/**
 * いま何が走るか。**身元だけを返す。**
 *
 * 返すのは目録が「何も指定しないクロール」に配る顔ぶれ —— 有効な各 id の最新版 ——
 * の `id` / `version` / `phase` / `sha256` だけで、**`source` は返さない**。
 * 何が走るかを知るのに要るのは「どれの何版か」で、中身は `pnpm run scripts show` と
 * アーカイブ (`behaviors/custom.jsonl`) に在る。
 *
 * ## なぜ要るのか
 *
 * 目録が空だと、クロールはページの中で何も走らせない —— スクロールも遅延読み込みも
 * 起きないまま、`complete: true` のアーカイブが出る。`POST /api/crawls` はそれを
 * 400 で止めるが、**止まるのは頼んだ後**。capture-scheduler の `doctor` は
 * 「全部 ✓ なら、クロールを起こせば最後まで走る設定になっている」と名乗っているので、
 * 頼む前に空かどうかを言えなければ、その約束が嘘になる。
 *
 * ## 認可
 *
 * `POST /api/crawls` と同じ `maySubmit` —— **起こせる者だけが、何が走るかを見られる。**
 * 許可が無ければ 404 で、クロールの口と同じ答え方をする (在ることを漏らさない)。
 *
 * 解決は `resolveScripts(db)` をそのまま呼ぶ。クロールが走らせるものを決めるのと
 * **同じ関数**で、写しを作らない —— 2 つになれば、いつか食い違う。
 */
import type { FastifyInstance } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { IdentityResolver } from "./identity.js";
import { maySubmit, unauthorized } from "./authorization.js";
import { resolveScripts } from "../scripts/store.js";

export interface ScriptsRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
}

export const registerScriptsRoute = (app: FastifyInstance, deps: ScriptsRouteDeps): void => {
  const { db, fga, resolveIdentity } = deps;

  app.get("/api/scripts", async (request, reply) => {
    const identity = await resolveIdentity(request);
    if (!identity) return unauthorized(reply);
    if (!(await maySubmit(fga, identity))) return reply.code(404).send({ error: "not found" });

    const resolved = await resolveScripts(db);
    // `resolveScripts` は id を渡さなければ必ず ok を返す (見つからない id が無いので)。
    const scripts = resolved.kind === "ok" ? resolved.scripts : [];
    return reply.code(200).send({
      scripts: scripts.map(({ id, version, phase, sha256 }) => ({ id, version, phase, sha256 })),
    });
  });
};
