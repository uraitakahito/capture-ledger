/**
 * Policy Enforcement Point —— 認可を実際に強制する 1 点。
 *
 * S3 は署名しか見ないので、URL に署名した瞬間に判断は済んでいて、取り消せない。
 * つまり `presignArchive` の直前の 1 行が、認可を強制できる唯一の場所になる ——
 * 他の検査はすべて助言でしかない。ここでは、直前に Check を置かずに URL を配って
 * はならない。
 */
import type { FastifyInstance } from "fastify";
import type { S3Client } from "@aws-sdk/client-s3";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { IdentityResolver } from "./identity.js";
import { presignArchive } from "./presign.js";
import { unauthorized } from "./authorization.js";
import { mayViewArchive, viewableArchiveIds } from "./archive-visibility.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "api" });

export interface RouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  s3: S3Client;
  resolveIdentity: IdentityResolver;
}

/** アーカイブ一覧 1 ページあたりの行数。 */
const PAGE_SIZE = 50;

export const registerRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { db, fga, s3, resolveIdentity } = deps;

  /**
   * アーカイブ 1 本に対して署名付き URL を発行する。
   *
   * 拒否は 403 ではなく 404 で答える。403 は「この id は実在するアーカイブを
   * 指している」ことを確認してしまい、それはまさに列挙を試みる側が欲しい情報 ——
   * OWASP API1:2023 (Broken Object Level Authorization) が警告している漏れ。
   * 「見てはいけない」と「存在しない」は区別が付いてはならない。
   */
  app.post<{ Params: { id: string } }>(
    "/api/archives/:id/url",
    {
      // 形式の検査は認可より前。UUID でない id は FGA が結果的に弾いていたが、
      // それは認可の副作用であって入力の検査ではない —— モデルを変えれば消える。
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);

      const { id } = request.params;

      // **強一貫で訊く。** ここで配る URL は寿命の間ずっと有効なので、古い許可を
      // 使ってはいけない。理由は `archive-visibility.ts` に書いてある。
      if (!(await mayViewArchive(fga, identity, id))) {
        log.info({ subject: identity.subject, archiveId: id }, "Denied");
        return reply.code(404).send({ error: "not found" });
      }

      const location = await db
        .selectFrom("archives")
        .select(["bucket", "objectKey"])
        .where("id", "=", id)
        .executeTakeFirst();

      // モデル上は許されているが capture-ledger に無い: tuple がアーカイブより長生きした場合。
      // 同じ 404 —— 署名する相手が無い。
      if (!location) {
        log.warn({ archiveId: id }, "Check allowed an archive that is not in the ledger");
        return reply.code(404).send({ error: "not found" });
      }

      const signed = await presignArchive(s3, location);
      log.info({ subject: identity.subject, archiveId: id }, "Signed URL issued");
      return reply.code(200).send(signed);
    },
  );

  /**
   * この呼び出し元が見てよいアーカイブを、新しい順に並べる。
   *
   * SQL でページを切ってから、そのページについて訊く。`ListObjects` なら同じ問いに
   * 1 回で答えられるが、上限があり (既定で 1,000 件)、蓄積が増えるほど高くつく。
   * こちらはページの大きさに比例したままでいられる。
   *
   * 一貫性は既定のまま —— ここではキャッシュで構わない。一覧に出ることは何も
   * 与えない: どれかを取りに行くには、上の強一貫な Check を通る必要がある。
   */
  app.get<{ Querystring: { before?: string } }>(
    "/api/archives",
    {
      // カーソルは「いま出した最後の行の capturedAt」。形式が違えば 400 ——
      // new Date() は不正な文字列でも投げず Invalid Date を返すので、ここで
      // 落とさないと SQL のパラメータになり、Postgres が拒んで 500 になる。
      schema: {
        querystring: {
          type: "object",
          properties: { before: { type: "string", format: "date-time" } },
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);

      const { before } = request.query;
      let query = db
        .selectFrom("archives")
        // objectKey は picker が replayweb-server へ渡す鍵。bucket は返さない —— replayweb-server は
        // 自分の S3_BUCKET_URL で既に持っていて、両方返すと「どちらが正か」が
        // 2 つになる。
        .select(["id", "taskId", "sourceUrl", "labels", "waczComplete", "capturedAt", "objectKey"])
        .orderBy("capturedAt", "desc")
        .limit(PAGE_SIZE);
      if (before !== undefined) query = query.where("capturedAt", "<", new Date(before));
      const page = await query.execute();

      if (page.length === 0) return reply.code(200).send({ archives: [] });

      const allowed = await viewableArchiveIds(
        fga,
        identity,
        page.map((archive) => archive.id),
      );
      return reply.code(200).send({ archives: page.filter((a) => allowed.has(a.id)) });
    },
  );

  app.get("/healthz", (_request, reply) => reply.code(200).send({ status: "ok" }));
};
