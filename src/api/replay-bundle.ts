/**
 * 合本の口。クロールの WACZ を全部並べた `replay.json` と、その頁の行の `pages.json` を、新しい版として保管庫に書く
 * (`replay-bundle/write.ts`)。replay はそれを 1 つのアーカイブとして開き、どの WACZ の頁へもリンクで行ける。
 *
 * 呼ぶのはクロールの flow で、段の報告 (`POST /api/crawls/:id/pages`) の後・索引 (`POST /api/crawls/:id/index`) の
 * 前。作り直しは `pnpm run replay-bundle:rebuild` (同じ関数を DB と保管庫に直に)。
 *
 * ## 答えは 200 だけ (認可と形の誤りを除く)
 *
 * **保管庫に書けなくても 200** で、`error` に理由を入れ、`crawls.replay_bundle_error` にも残す。合本は撮った物から
 * 作る派生物で、flow の段を誤りにするとクロールが failed になり、次の段が既に出ているときに状態が食い違う。
 * 401・404・400 は索引の口と同じ (身元が無い・`can_submit` が無い・id や本文の形が違う)。クロールが無ければ 404
 * (置き場の鍵に組織が要る)。DB に届かないときだけ 500。
 *
 * ## 終わったクロールの合本には署名する (CAPTURE-61)
 *
 * 署名の設定が在り (`config/signer.ts`)、クロールが終わっていて、未検めの WACZ が残っていなければ、`replay.json` の
 * sha256 に wacz-signer の署名を貰って検め、同じ置き場に `replay-digest.json` を書く。答えの `signed`・`digestKey`・
 * `signError` がその結末。**署名が付かなくても 200** —— 合本は書き、理由を `signError` と
 * `crawls.replay_bundle_sign_error` に残す (書けない時と同じ考え)。
 *
 * ## 本文は `{depth}` だけ
 *
 * flow の段の深さで、`replay.json` に記録するだけ。**版ではない** —— 版は作るたびに台帳が払い出す (作り直しで同じ
 * 深さを 2 度書くため)。どの WACZ を入れるかも呼ぶ側に言わせない —— 台帳の `archives.crawl_id` が知っている
 * (索引の口と同じ線引き)。
 */
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Database } from "../db/database.js";
import type { IdentityResolver } from "./identity.js";
import { maySubmit, unauthorized } from "./authorization.js";
import type { UninspectedArchive } from "../replay-bundle/inspect.js";
import type { ReplayBundleSigner } from "../replay-bundle/sign.js";
import { writeReplayBundle } from "../replay-bundle/write.js";

export interface ReplayBundleRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  s3: S3Client;
  /** 合本を書く bucket (設定の物。WACZ と同じ bucket)。 */
  bucket: string;
  resolveIdentity: IdentityResolver;
  /** 差し替え口。試験は zip を作らずに、数え方と答えの形を見る (台帳に DB の試験は無い)。 */
  inspectOne?: (archive: UninspectedArchive) => Promise<void>;
  now?: () => Date;
  /** 署名の窓口 (`replay-bundle/sign.ts`)。無ければ署名しない (設定の無い配備)。 */
  signer?: ReplayBundleSigner;
}

export const registerReplayBundleRoutes = (
  app: FastifyInstance,
  deps: ReplayBundleRouteDeps,
): void => {
  const { db, fga, s3, bucket, resolveIdentity } = deps;

  /**
   * クロール 1 本の合本を書く。認可は段の報告・索引と同じ (`can_submit`) —— 呼ぶのは同じ flow で、書く中身は
   * 既に台帳と保管庫に在る。
   */
  app.post<{ Params: { id: string }; Body: { depth: number } }>(
    "/api/crawls/:id/replay-bundle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["depth"],
          properties: { depth: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }

      const result = await writeReplayBundle(request.params.id, request.body.depth, {
        db,
        s3,
        bucket,
        ...(deps.inspectOne && { inspectOne: deps.inspectOne }),
        ...(deps.now && { now: deps.now }),
        ...(deps.signer && { signer: deps.signer }),
      });
      if (result === undefined) return reply.code(404).send({ error: "not found" });
      return reply.code(200).send(result);
    },
  );
};
