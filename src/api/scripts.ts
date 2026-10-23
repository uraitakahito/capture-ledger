/**
 * 目録を読む口。**一覧は身元だけ、中身は 1 版の口。**
 *
 * | 口 | 返すもの |
 * | --- | --- |
 * | `GET /api/scripts` | 有効な各 id の最新版の身元と札 (サイト用の台本も。何も指定しないクロールが走らせるのは、札の無い物と起点に合う物) |
 * | `GET /api/scripts/:id/versions` | 1 つの id の版の並び (新しい順)。**source は返さない** |
 * | `GET /api/scripts/:id/versions/:version` | 1 版を丸ごと (source・渡す値・札・有効か・取り込んだ時刻) |
 * | `GET /api/host-types` | 受け皿 `__bh` の型のいちばん新しい版 (読む人に見せる写し。`020`) |
 *
 * 一覧が身元と札 (`id` / `version` / `phase` / `sha256` / `sites`) だけなのは、何が走るかを知るのに
 * 要るのが「どれの何版か」と「どの起点で走るか」だから。中身は 1 版の口・`pnpm run scripts show`・アーカイブ (`behaviors/custom.jsonl`。
 * こちらは変換後の JS) に在る。1 版の口は**有効かどうかを見ない** —— 無効な版も、過去のクロールが
 * 走らせた物で、読み返す相手になる。
 *
 * ## なぜ顔ぶれの口が要るのか
 *
 * 目録が空だと、クロールはページの中で何も走らせない —— スクロールも遅延読み込みも
 * 起きないまま、`complete: true` のアーカイブが出る。`POST /api/crawls` はそれを
 * 400 で止めるが、**止まるのは頼んだ後**。capture-scheduler の `doctor` は
 * 「全部 ✓ なら、クロールを起こせば最後まで走る設定になっている」と名乗っているので、
 * 頼む前に空かどうかを言えなければ、その約束が嘘になる。
 *
 * 一覧は `enabledLatest(db)` —— 有効な各 id の最新版を、サイト用の台本（札のある物。`021`）も含めて返す。
 * 既定で走るのは、この中の札の無い物と、起点に合う物で、選ぶのはクロールを起こすときの
 * `resolveScripts`（起点を見る）。画面はこの一覧で札を見せ、起こす面で同じ決まりのとおりに選ぶ。
 * 札のある物しか無い目録では、一覧が空でなくても、起点によっては既定が空になる（クロールは 400
 * `no default scripts for these seeds`）—— この口で頼む前に言えるのは「空でない」まで。
 *
 * ## 認可
 *
 * 4 本とも `POST /api/crawls` と同じ `maySubmit` —— **起こせる者だけが、何が走るかを見られる。**
 * 許可が無ければ 404 で、クロールの口と同じ答え方をする (在ることを漏らさない)。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { IdentityResolver } from "./identity.js";
import { maySubmit, unauthorized } from "./authorization.js";
import { enabledLatest, listScripts, readHostTypes, readScript } from "../scripts/store.js";

export interface ScriptsRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
}

/** 目録の id。綴りは目録の CHECK (`017`) が決めるので、ここは空でないことだけを見る */
const ID = { type: "string", minLength: 1 } as const;

export const registerScriptsRoute = (app: FastifyInstance, deps: ScriptsRouteDeps): void => {
  const { db, fga, resolveIdentity } = deps;

  /** 名乗りが無ければ 401、起こせなければ 404 を返して false。 */
  const allowed = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      await unauthorized(reply);
      return false;
    }
    if (!(await maySubmit(fga, identity))) {
      await reply.code(404).send({ error: "not found" });
      return false;
    }
    return true;
  };

  app.get("/api/scripts", async (request, reply) => {
    if (!(await allowed(request, reply))) return reply;

    // 有効な各 id の最新版を全部 (サイト用の台本も)。既定で走るのは、この中の札の無い物と起点に合う物
    const scripts = await enabledLatest(db);
    return reply.code(200).send({
      scripts: scripts.map(({ id, version, phase, sha256, sites }) => ({
        id,
        version,
        phase,
        sha256,
        sites,
      })),
    });
  });

  /** 1 つの id の版。新しい順。**source は返さない**（読むのは 1 版の口）。無い id は 404。 */
  app.get<{ Params: { id: string } }>(
    "/api/scripts/:id/versions",
    {
      schema: {
        params: { type: "object", properties: { id: ID }, required: ["id"] },
      },
    },
    async (request, reply) => {
      if (!(await allowed(request, reply))) return reply;

      const rows = await listScripts(db, { allVersions: true, id: request.params.id });
      if (rows.length === 0) return reply.code(404).send({ error: "not found" });
      return reply.code(200).send({
        id: request.params.id,
        versions: rows.map(({ version, phase, sha256, sites, enabled, bytes, createdAt }) => ({
          version,
          phase,
          sha256,
          sites,
          enabled,
          bytes,
          createdAt,
        })),
      });
    },
  );

  /**
   * 1 版を丸ごと。**有効かどうかは見ない**（`readScript`）。版は 1 以上の整数で、数でなければ
   * 許可を見る前に 400。
   */
  app.get<{ Params: { id: string; version: number } }>(
    "/api/scripts/:id/versions/:version",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: ID, version: { type: "integer", minimum: 1 } },
          required: ["id", "version"],
        },
      },
    },
    async (request, reply) => {
      if (!(await allowed(request, reply))) return reply;

      const script = await readScript(db, request.params.id, request.params.version);
      if (script === undefined) return reply.code(404).send({ error: "not found" });
      return reply.code(200).send(script);
    },
  );

  /** いちばん新しい受け皿の型。`scripts import` が 1 度も型を読んでいなければ 404。 */
  app.get("/api/host-types", async (request, reply) => {
    if (!(await allowed(request, reply))) return reply;

    const types = await readHostTypes(db);
    if (types === undefined) return reply.code(404).send({ error: "not found" });
    return reply.code(200).send(types);
  });
};
