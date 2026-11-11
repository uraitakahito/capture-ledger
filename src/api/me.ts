/**
 * 呼び出し元が、capture-ledger からどう見えているか。
 *
 * 名前と組織は、トークン (かヘッダ) から解いたそのもの。`canSubmit` は `maySubmit`
 * そのもので、クロールのエンドポイントが訊くのと同じ問いを同じ関数で訊く —— 写しを作らない
 * (`authorization.ts` の注記)。
 *
 * ## なぜ要るのか
 *
 * クロールのエンドポイントは、許されていない呼び出し元に 404 を返す。在るかどうかを漏らさないための
 * 正しい設計だが、その 404 からは「許可が無い」のか「エンドポイントが無い」のかが読めない。
 * capture-scheduler の `doctor` は、flow が使うのと同じトークンでここを訊き、
 * 足りない許可を、ここが返した名前で名指しする。
 *
 * **新しく漏らすものは無い。** 答えるのは呼び出し元自身のことだけ。許可の有無も、
 * クロールのエンドポイントが出ていれば既に分かる (`POST /api/crawls/<無い id>/failed` は、許されて
 * いれば 200、いなければ 404)。
 *
 * クロールのエンドポイントと違い、webhook が無くても出す。名前と組織は、どの配備でも名乗りの
 * 食い違いを調べる手がかりになる。
 */
import type { FastifyInstance } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";
import type { IdentityResolver } from "./identity.js";
import { maySubmit, unauthorized } from "./authorization.js";

export interface MeRouteDeps {
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
}

export const registerMeRoute = (app: FastifyInstance, deps: MeRouteDeps): void => {
  const { fga, resolveIdentity } = deps;

  app.get("/api/me", async (request, reply) => {
    const identity = await resolveIdentity(request);
    if (!identity) return unauthorized(reply);
    return reply.code(200).send({
      subject: identity.subject,
      organizations: identity.organizations,
      canSubmit: await maySubmit(fga, identity),
    });
  });
};
