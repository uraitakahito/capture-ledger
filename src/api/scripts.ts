/**
 * スクリプトを読むエンドポイント。**一覧は身元だけ、中身は 1 版のエンドポイント。**
 *
 * | エンドポイント | 返すもの |
 * | --- | --- |
 * | `GET /api/scripts` | 有効な各 id の最新版の身元と対象サイトと宣言 (サイト用のスクリプトも。何も指定しないクロールが走らせるのは、対象サイトの無い物と起点に合う物) |
 * | `GET /api/scripts/:id/versions` | 1 つの id の版の並び (新しい順)。**source は返さない** |
 * | `GET /api/scripts/:id/versions/:version` | 1 版を丸ごと (source・渡す値・対象サイト・宣言・有効か・取り込んだ時刻) |
 * | `GET /api/host-types` | 受け皿 `__bh` の型のいちばん新しい版 (読む人に見せる写し。`020`) |
 * | `POST /api/scripts/check` | 書きかけの TS の変数の宣言と誤り。行を立てない。capture-workbench が欄を作るのに使う |
 *
 * 一覧が身元と対象サイトと宣言 (`id` / `version` / `phase` / `sha256` / `sites` / `params`) だけなのは、何が走るかを知るのに
 * 要るのが「どれの何版か」「どの起点で走るか」「どの値を読むか」だから。workbench は `params` で、新しいクロールの
 * 画面に変数の欄を並べる (`024`)。中身は 1 版のエンドポイント・`pnpm run scripts show`・アーカイブ (`behaviors/custom.jsonl`。
 * こちらは変換後の JS) に在る。1 版のエンドポイントは**有効かどうかを見ない** —— 無効な版も、過去のクロールが
 * 走らせた物で、読み返す相手になる。
 *
 * ## なぜ顔ぶれのエンドポイントが要るのか
 *
 * 台帳にスクリプトが無いと、クロールはページの中で何も走らせない —— スクロールも遅延読み込みも
 * 起きないまま、`complete: true` のアーカイブが出る。`POST /api/crawls` はそれを
 * 400 で止めるが、**止まるのは頼んだ後**。capture-scheduler の `doctor` は
 * 「全部 ✓ なら、クロールを始めれば最後まで走る設定になっている」と名乗っているので、
 * 頼む前に空かどうかを言えなければ、その約束が嘘になる。
 *
 * 一覧は `pickable(db)` —— 各 id に 1 行、既定で走る版（有効な版の中の最新）か、無ければ最新版を、
 * サイト用のスクリプト（対象サイトのある物。`021`）も含めて返す。`enabled` が既定に入るかで、既定に入らない物
 * （カタログの `default: false`）も名指しすれば走るので載せる。既定で走るのは `enabled` の物のうち対象サイトの無い物と、
 * 起点に合う物で、選ぶのはクロールを始めるときの `resolveScripts`（起点を見る）。workbench はこの一覧で対象サイトと
 * `enabled` を見せ、新しいクロールの画面で同じ決まりのとおりに選ぶ。`enabled` の物が 1 つも無い台帳や、対象サイトのある
 * 物しか無い台帳では、一覧が空でなくても既定が空になる（クロールは 400）—— 頼む前に言えるのは「`enabled` の物が在る」まで。
 *
 * ## 認可
 *
 * 全部 `POST /api/crawls` と同じ `maySubmit` —— **始められる者だけが、何が走るかを見られる。**
 * 許可が無ければ 404 で、クロールのエンドポイントと同じ答え方をする (在ることを漏らさない)。
 */
import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { IdentityResolver } from "./identity.js";
import { maySubmit, unauthorized } from "./authorization.js";
import { listScripts, pickable, readHostTypes, readScript } from "../scripts/store.js";
import { TsCompileUnreachable, type TsCompile } from "../scripts/ts-compile.js";

export interface ScriptsRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
  /** 型の検査のクライアント。無ければ `POST /api/scripts/check` を出さない。 */
  tsCompile?: TsCompile;
}

/** 検査のエンドポイントが受ける本文の上限。`POST /api/crawls` の上限と同じ 1 MiB。 */
const CHECK_BODY_LIMIT = 1024 * 1024;

/** 台帳のスクリプトの id。綴りは `scripts` の表の CHECK (`017`) が決めるので、ここは空でないことだけを見る */
const ID = { type: "string", minLength: 1 } as const;

export const registerScriptsRoute = (app: FastifyInstance, deps: ScriptsRouteDeps): void => {
  const { db, fga, resolveIdentity, tsCompile } = deps;

  /** 名乗りが無ければ 401、始められなければ 404 を返して false。 */
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

    // 各 id に 1 行 (サイト用のスクリプトも、既定に入らない物も)。既定で走るのは enabled の物のうち、対象サイトの無い物と起点に合う物
    const scripts = await pickable(db);
    return reply.code(200).send({
      scripts: scripts.map(({ id, version, phase, sha256, sites, params, enabled }) => ({
        id,
        version,
        phase,
        sha256,
        sites,
        params,
        enabled,
      })),
    });
  });

  /** 1 つの id の版。新しい順。**source は返さない**（読むのは 1 版のエンドポイント）。無い id は 404。 */
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
        versions: rows.map(
          ({ version, phase, sha256, sites, params, enabled, bytes, createdAt }) => ({
            version,
            phase,
            sha256,
            sites,
            params,
            enabled,
            bytes,
            createdAt,
          }),
        ),
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

  /**
   * 書きかけの TS を読む。**行を立てず、値も受けない。** 名前を渡さずに検査するので、必須の変数の誤り (`BH0001`) は
   * 答えから除く —— 書いている最中の「まだ渡していない」は誤りではない。workbench はこの宣言から欄を作る。
   */
  if (tsCompile !== undefined) {
    app.post<{ Body: { source: string; phase: "preload" | "behavior" } }>(
      "/api/scripts/check",
      {
        bodyLimit: CHECK_BODY_LIMIT,
        schema: {
          body: {
            type: "object",
            properties: {
              source: { type: "string" },
              phase: { type: "string", enum: ["preload", "behavior"] },
            },
            required: ["source", "phase"],
            additionalProperties: false,
          },
        },
      },
      async (request, reply) => {
        if (!(await allowed(request, reply))) return reply;
        const { source, phase } = request.body;
        const id = "inline-check";
        const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
        let answer;
        try {
          answer = await tsCompile.compile(
            [{ id, version: 1, phase, source, sha256, options: {} }],
            [],
          );
        } catch (err) {
          if (!(err instanceof TsCompileUnreachable)) throw err;
          request.log.warn({ err }, "ts-compile-service did not answer");
          return reply.code(503).send({ error: "ts-compile unreachable" });
        }
        return reply.code(200).send({
          params: answer.declarations[0]?.params ?? [],
          diagnostics: answer.ok ? [] : answer.diagnostics.filter((d) => d.code !== "BH0001"),
        });
      },
    );
  }
};
