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
import { DEFAULT_EXPIRES_IN_SECONDS, presignArchive } from "./presign.js";
import { unauthorized } from "./authorization.js";
import { mayViewArchive, viewableArchiveIds } from "./archive-visibility.js";
import { onListedScreenshot, SCREENSHOT_COLUMNS, screenshotOf } from "./stage-screenshot.js";
import { getObjectRange } from "../archive/s3.js";
import { CAPTURE_SCRIPTS_STAGE } from "../archive/stage-name.js";
import { pictureOf, ScreenshotRecordError } from "../archive/stage-screenshots.js";
import { PICTURE_MAX_BYTES } from "../archive/webp.js";
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

/** 返せる時点 (BrowserHive WACZ Profile の `#screenshots`)。 */
const SCREENSHOT_STAGES = ["after-load", CAPTURE_SCRIPTS_STAGE];

/** 絵のレコード (gzip の member) の長さの上限。絵の上限に、WARC の見出しと gzip のぶんを足す。 */
const SCREENSHOT_MEMBER_MAX_BYTES = PICTURE_MAX_BYTES + 64 * 1024;

/**
 * 絵をブラウザに覚えさせる長さ。署名付き URL の寿命 (`api/presign.ts`) と同じ —— 見る許可を外した後も、
 * この秒数だけはブラウザに残る。WACZ は書き換わらないので、同じ URL の絵は変わらない (`immutable`)。
 */
const SCREENSHOT_CACHE_SECONDS = DEFAULT_EXPIRES_IN_SECONDS;

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
        // 読み込みの後の節目のスクリーンショット (`api/stage-screenshot.ts`)。主キーが (archive_id, stage) なので
        // 行は増えず、limit はずれない
        .leftJoin("archiveScreenshots as sh", onListedScreenshot("archives.id"))
        // objectKey は picker が replayweb-player へ渡す鍵。bucket は返さない —— replayweb-player は
        // 自分の S3_BUCKET_URL で既に持っていて、両方返すと「どちらが正か」が
        // 2 つになる。
        .select([
          "archives.id",
          "archives.taskId",
          "archives.sourceUrl",
          "archives.labels",
          "archives.waczComplete",
          "archives.capturedAt",
          "archives.objectKey",
          ...SCREENSHOT_COLUMNS,
        ])
        .orderBy("archives.capturedAt", "desc")
        .limit(PAGE_SIZE);
      if (before !== undefined) query = query.where("archives.capturedAt", "<", new Date(before));
      const page = await query.execute();

      if (page.length === 0) return reply.code(200).send({ archives: [] });

      const allowed = await viewableArchiveIds(
        fga,
        identity,
        page.map((archive) => archive.id),
      );
      return reply.code(200).send({
        archives: page
          .filter((a) => allowed.has(a.id))
          .map((a) => ({
            id: a.id,
            taskId: a.taskId,
            sourceUrl: a.sourceUrl,
            labels: a.labels,
            waczComplete: a.waczComplete,
            capturedAt: a.capturedAt,
            objectKey: a.objectKey,
            screenshot: screenshotOf(a),
          })),
      });
    },
  );

  /**
   * アーカイブ 1 本の、節目のスクリーンショット 1 枚 (CAPTURE-432)。絵は BrowserHive WACZ の中の WARC の resource で、
   * 在り処は WACZ を検めた時に `archive_screenshots` (`041`) に覚えてある。**保管庫への Range の読み 1 本**で取り、
   * gzip を 1 つ解いて、名指しの絵か (Record-ID・時点・`image/webp`・大きさ・WebP の頭) を確かめてから返す
   * (`archive/stage-screenshots.ts` の `pictureOf`)。
   *
   * 見る許可は WACZ と同じ (`can_view`。強一貫)。断る理由は分けず 404 —— 見てよくない・行が無い・残さなかった
   * 時点・位置を引けなかった時点・WACZ が保管庫に無い。前の 4 つは保管庫を読まない。読んだ物が名指しの絵でなければ 502。
   */
  app.get<{ Params: { id: string; stage: string } }>(
    "/api/archives/:id/screenshots/:stage",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            stage: { type: "string", enum: SCREENSHOT_STAGES },
          },
          required: ["id", "stage"],
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);

      const { id, stage } = request.params;
      if (!(await mayViewArchive(fga, identity, id))) {
        log.info({ subject: identity.subject, archiveId: id }, "Denied");
        return reply.code(404).send({ error: "not found" });
      }

      const row = await db
        .selectFrom("archiveScreenshots as sh")
        .innerJoin("archives as a", "a.id", "sh.archiveId")
        .select([
          "a.bucket",
          "a.objectKey",
          "sh.waczOffset",
          "sh.waczLength",
          "sh.bytes",
          "sh.recordId",
        ])
        .where("sh.archiveId", "=", id)
        .where("sh.stage", "=", stage)
        .executeTakeFirst();
      // 行が無い・残さなかった時点・位置を引けなかった時点は、保管庫を読まずに 404
      if (row?.waczOffset == null || row.waczLength === null || row.recordId === null) {
        return reply.code(404).send({ error: "not found" });
      }
      if (
        row.waczLength > SCREENSHOT_MEMBER_MAX_BYTES ||
        (row.bytes !== null && row.bytes > PICTURE_MAX_BYTES)
      ) {
        log.warn(
          { archiveId: id, stage, length: row.waczLength },
          "Screenshot is larger than the cap",
        );
        return reply.code(502).send({ error: "screenshot too large" });
      }

      let member: Buffer | undefined;
      try {
        member = await getObjectRange(
          s3,
          row.bucket,
          row.objectKey,
          Number(row.waczOffset),
          row.waczLength,
        );
      } catch (err) {
        log.warn({ err, archiveId: id, stage }, "Screenshot could not be read from the store");
        return reply.code(502).send({ error: "storage unreachable" });
      }
      if (member === undefined) {
        log.warn({ archiveId: id, key: row.objectKey }, "The WACZ is not in the store");
        return reply.code(404).send({ error: "not found" });
      }

      let picture: Buffer;
      try {
        picture = pictureOf(member, {
          stage,
          recordId: row.recordId,
          bytes: row.bytes ?? undefined,
        });
      } catch (err) {
        if (!(err instanceof ScreenshotRecordError)) throw err;
        log.warn({ err, archiveId: id, stage }, "The recorded place does not hold the screenshot");
        return reply.code(502).send({ error: "screenshot record unreadable" });
      }
      return reply
        .code(200)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox")
        .header("cache-control", `private, max-age=${String(SCREENSHOT_CACHE_SECONDS)}, immutable`)
        .type("image/webp")
        .send(picture);
    },
  );

  app.get("/healthz", (_request, reply) => reply.code(200).send({ status: "ok" }));
};
