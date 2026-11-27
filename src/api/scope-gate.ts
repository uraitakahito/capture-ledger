/**
 * scope の門 (CAPTURE-450)。`/api/*` の要求を、route の手続きより前に `scope.ts` で絞る。
 *
 * route ごとに書かず 1 か所に置くのは、新しい route が黙って AI の担当に開かないようにするため (`scope.ts`)。
 * `onRequest` で見るので、本文の検査 (400) より前に断る —— 届いてはいけない route の本文の形を、
 * 断られる呼び手に教えない。
 *
 * 名乗りは 1 要求に 1 度だけ確かめる (`rememberIdentity`)。門と route の手続きが同じ答えを使う。
 * 名乗れない要求は門を素通りし、route の手続きが今までどおり 401 にする。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Identity } from "../config/identity.js";
import type { IdentityResolver } from "./identity.js";
import { scopeRefusal } from "./scope.js";

/** 同じ要求の 2 度目からは、1 度目の答えを返す resolver。 */
export const rememberIdentity = (resolve: IdentityResolver): IdentityResolver => {
  const answers = new WeakMap<FastifyRequest, Promise<Identity | undefined>>();
  return (request) => {
    const known = answers.get(request);
    if (known !== undefined) return known;
    const answer = resolve(request);
    answers.set(request, answer);
    return answer;
  };
};

/** `/api/*` の route を、機械のトークンの scope で絞る。受け取り先 (`/api/sink/*`) は名乗りを使わないので見ない。 */
export const registerScopeGate = (app: FastifyInstance, resolveIdentity: IdentityResolver) => {
  app.addHook("onRequest", async (request, reply) => {
    const url = request.routeOptions.url;
    if (url === undefined || !url.startsWith("/api/") || url.startsWith("/api/sink/")) return;
    const identity = await resolveIdentity(request);
    if (identity === undefined) return;
    const refusal = scopeRefusal(identity, request.method, url);
    if (refusal === undefined) return;
    return reply
      .code(403)
      .header("www-authenticate", `Bearer error="insufficient_scope", scope="${refusal.scope}"`)
      .send(refusal);
  });
};
