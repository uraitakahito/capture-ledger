import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerScriptsRoute, type ScriptsRouteDeps } from "../src/api/scripts.js";
import type { CrawlScript } from "../src/db/database.js";
import {
  TsCompileUnreachable,
  type CompileAnswer,
  type TsCompile,
} from "../src/scripts/ts-compile.js";
import { recordingDb } from "./recording-db.js";

/**
 * スクリプトを読む口 (`src/api/scripts.ts`) の検査。
 *
 * DB は Kysely に SQL を組ませて記録する代役 (`recording-db.ts`)。だから「許可が無ければ SQL を
 * 1 本も出さない」と「1 版の口は版で絞る」を、組んだ SQL で言える。Postgres で本当に通るかは
 * CI の `src/tools/scripts-smoke.ts` が見る (口と同じ関数を CLI から呼ぶ)。
 */
const TOUCHED = "fga に訊いた";
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error(TOUCHED);
    },
  },
);

const fgaAnswering = (allowed: boolean) => ({
  check: () => Promise.resolve({ allowed }),
});

const caller = () => Promise.resolve({ subject: "windmill", organizations: ["acme"] });

const get = async (
  url: string,
  options: {
    rows?: readonly (readonly object[])[];
    fga?: unknown;
    resolveIdentity?: ScriptsRouteDeps["resolveIdentity"];
  } = {},
) => {
  const { db, queries } = recordingDb(options.rows ?? []);
  const app = Fastify({ logger: false });
  registerScriptsRoute(app, {
    db,
    fga: (options.fga ?? fgaAnswering(true)) as ScriptsRouteDeps["fga"],
    resolveIdentity: options.resolveIdentity ?? caller,
  });
  await app.ready();
  const res = await app.inject({ method: "GET", url });
  await app.close();
  return { res, queries };
};

const ROUTES = [
  "/api/scripts",
  "/api/scripts/autoscroll/versions",
  "/api/scripts/autoscroll/versions/1",
  "/api/host-types",
];

describe("スクリプトを読む口の認可", () => {
  it.each(ROUTES)("名乗りが無ければ 401 で、OpenFGA には訊かない: %s", async (url) => {
    const { res, queries } = await get(url, {
      fga: untouchable,
      resolveIdentity: () => Promise.resolve(undefined),
    });
    expect(res.statusCode).toBe(401);
    expect(queries).toEqual([]);
  });

  it.each(ROUTES)(
    "始められない呼び出し元には、在っても 404 で、SQL を出さない: %s",
    async (url) => {
      const { res, queries } = await get(url, { fga: fgaAnswering(false) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
      expect(queries).toEqual([]);
    },
  );
});

describe("GET /api/scripts/:id/versions/:version", () => {
  it("その版を丸ごと（source・バイト数・渡す値・対象サイト・有効か・取り込んだ時刻）返す", async () => {
    const row = {
      id: "autoscroll",
      version: 1,
      phase: "behavior",
      sha256: "c9956819ffea",
      sites: ["site.test"],
      params: [{ name: "query", kind: "variable", required: false, summary: "検索語" }],
      enabled: false,
      bytes: 2695,
      createdAt: new Date("2026-10-14T12:26:38.656Z"),
      source: "// autoscroll\n",
      options: { maxSteps: 60 },
    };
    const { res, queries } = await get("/api/scripts/autoscroll/versions/1", { rows: [[row]] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...row, createdAt: "2026-10-14T12:26:38.656Z" });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('"sites"');
    expect(queries[0]?.sql).toContain('"params"');
    expect(queries[0]?.sql).toContain('where "id" = $1 and "version" = $2');
    expect(queries[0]?.parameters).toEqual(["autoscroll", 1]);
  });

  it("その版が無ければ 404", async () => {
    const { res } = await get("/api/scripts/autoscroll/versions/9", { rows: [[]] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });

  it.each(["abc", "0", "1.5"])(
    "版が 1 以上の整数でなければ、許可を見る前に 400: %s",
    async (version) => {
      const { res, queries } = await get(`/api/scripts/autoscroll/versions/${version}`, {
        fga: untouchable,
      });
      expect(res.statusCode).toBe(400);
      expect(queries).toEqual([]);
    },
  );

  it("id の % は解いて引く（/ や空白を含む id でも、その id の版を読む）", async () => {
    const { queries } = await get("/api/scripts/a%2Fb%20c/versions/2", { rows: [[]] });
    expect(queries[0]?.parameters).toEqual(["a/b c", 2]);
  });
});

describe("GET /api/scripts/:id/versions", () => {
  it("新しい順の版の並びを返し、source は返さない", async () => {
    const rows = [2, 1].map((version) => ({
      id: "autoscroll",
      version,
      phase: "behavior",
      sha256: `sha-${String(version)}`,
      sites: version === 2 ? ["site.test"] : [],
      params: version === 2 ? [{ name: "query", kind: "variable", required: false }] : [],
      enabled: true,
      bytes: 2695,
      createdAt: new Date(`2026-10-1${String(version + 3)}T00:00:00.000Z`),
      // 一覧の SQL は source を引かないが、引いてしまっても答えには出さない
      source: "// 出してはいけない\n",
    }));
    const { res, queries } = await get("/api/scripts/autoscroll/versions", { rows: [rows] });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; versions: Record<string, unknown>[] }>();
    expect(body.id).toBe("autoscroll");
    expect(body.versions.map((v) => v["version"])).toEqual([2, 1]);
    for (const v of body.versions)
      expect(Object.keys(v).sort()).toEqual([
        "bytes",
        "createdAt",
        "enabled",
        "params",
        "phase",
        "sha256",
        "sites",
        "version",
      ]);
    expect(body.versions.map((v) => v["sites"])).toEqual([["site.test"], []]); // 対象サイトは版ごと
    // 宣言も版ごと
    expect(body.versions.map((v) => v["params"])).toEqual([
      [{ name: "query", kind: "variable", required: false }],
      [],
    ]);
    expect(queries[0]?.sql).not.toContain('"source"');
    expect(queries[0]?.parameters).toEqual(["autoscroll"]);
  });

  it("台帳に無い id は 404", async () => {
    const { res } = await get("/api/scripts/nothing/versions", { rows: [[]] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });
});

describe("GET /api/host-types", () => {
  it("いちばん新しい版を返す", async () => {
    const row = {
      version: 2,
      sha256: "ab12",
      createdAt: new Date("2026-10-17T00:00:00.000Z"),
      source: "declare var __bh: {};\n",
      bytes: 22,
    };
    const { res, queries } = await get("/api/host-types", { rows: [[row]] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...row, createdAt: "2026-10-17T00:00:00.000Z" });
    expect(queries[0]?.sql).toContain('order by "version" desc limit $1');
  });

  it("1 度も取り込んでいなければ 404", async () => {
    const { res } = await get("/api/host-types", { rows: [[]] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });
});

describe("GET /api/scripts", () => {
  it("各 id の 1 行を、身元と対象サイトと宣言と既定に入るか（id・版・phase・sha256・sites・params・enabled）だけで返す", async () => {
    const params = [{ name: "query", kind: "variable", required: false, summary: "検索語" }];
    const row = {
      id: "autoscroll",
      version: 2,
      phase: "behavior",
      source: "// a\n",
      sha256: "c9",
      options: {},
      sites: [],
      params,
      enabled: true,
    };
    const { res } = await get("/api/scripts", { rows: [[row]] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scripts: [
        {
          id: "autoscroll",
          version: 2,
          phase: "behavior",
          sha256: "c9",
          sites: [],
          params,
          enabled: true,
        },
      ],
    });
  });

  it("既定に入らないスクリプトも enabled: false で返す（名指しすれば走るので）", async () => {
    const row = {
      id: "autofetch",
      version: 1,
      phase: "behavior",
      sha256: "6a",
      sites: [],
      params: [],
      enabled: false,
    };
    const { res } = await get("/api/scripts", { rows: [[row]] });

    expect(res.json<{ scripts: unknown[] }>().scripts).toEqual([row]);
  });

  it("サイト用のスクリプトも返す（既定で走る物だけではない）。対象サイトで絞らない", async () => {
    const rows = [
      {
        id: "autoscroll",
        version: 2,
        phase: "behavior",
        sha256: "c9",
        sites: [],
        params: [],
        enabled: true,
      },
      {
        id: "example-title",
        version: 1,
        phase: "behavior",
        sha256: "e1",
        sites: ["site.test"],
        params: [],
        enabled: true,
      },
    ];
    const { res, queries } = await get("/api/scripts", { rows: [rows] });

    expect(res.json<{ scripts: unknown[] }>().scripts).toEqual(rows);
    expect(queries[0]?.sql).toBe(
      'select distinct on ("id") "id", "version", "phase", "sha256", "sites", "params", "enabled", "position" from "scripts" ' +
        'order by "id", "enabled" desc, "version" desc',
    );
  });

  it("行は既定の実行順で、position は答えに載せない", async () => {
    const row = (id: string, position: number) => ({
      id,
      version: 1,
      phase: "behavior",
      sha256: "h",
      sites: [],
      params: [],
      enabled: true,
      position,
    });
    const { res } = await get("/api/scripts", {
      rows: [[row("autofetch", 2), row("autoscroll", 0)]],
    });

    const { scripts } = res.json<{ scripts: Record<string, unknown>[] }>();
    expect(scripts.map((script) => script["id"])).toEqual(["autoscroll", "autofetch"]);
    expect(scripts[0]).not.toHaveProperty("position");
  });
});

describe("POST /api/scripts/check", () => {
  const SOURCE =
    'import { z } from "zod";\nconst { q } = defineParams(z.object({ q: z.string() }));\n';
  const PARAM = {
    name: "q",
    kind: "variable",
    required: true,
    schema: { type: "string" },
  } as const;

  const check = async (
    body: unknown,
    tsCompile: TsCompile | undefined,
    options: { fga?: unknown; resolveIdentity?: ScriptsRouteDeps["resolveIdentity"] } = {},
  ) => {
    const { db } = recordingDb([]);
    const app = Fastify({ logger: false });
    registerScriptsRoute(app, {
      db,
      fga: (options.fga ?? fgaAnswering(true)) as ScriptsRouteDeps["fga"],
      resolveIdentity: options.resolveIdentity ?? caller,
      ...(tsCompile && { tsCompile }),
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/scripts/check",
      payload: body as object,
    });
    await app.close();
    return res;
  };
  const answering = (answer: CompileAnswer) => {
    const asked: { scripts: readonly CrawlScript[]; names: readonly string[] }[] = [];
    const tsCompile: TsCompile = {
      compile: (scripts, names) => {
        asked.push({ scripts, names });
        return Promise.resolve(answer);
      },
    };
    return { asked, tsCompile };
  };

  it("宣言を返す。名前を渡さずに訊くので、BH0001 は誤りに数えない", async () => {
    const { asked, tsCompile } = answering({
      ok: false,
      typescript: "6.0.3",
      diagnostics: [
        { file: "inline-check.ts", line: 2, col: 7, code: "BH0001", message: "渡されていない" },
      ],
      declarations: [{ id: "inline-check", params: [PARAM], unreadable: false }],
      missingVariables: ["q"],
    });
    const res = await check({ source: SOURCE, phase: "behavior" }, tsCompile);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ params: [PARAM], diagnostics: [] });
    expect(asked[0]?.names).toEqual([]);
    // sha256 は source の本物の値 (違えば変換サービスが 409 で断る)
    expect(asked[0]?.scripts[0]?.sha256).toBe(createHash("sha256").update(SOURCE).digest("hex"));
    expect(asked[0]?.scripts[0]?.phase).toBe("behavior");
  });

  it("ほかの誤りは返す", async () => {
    const diagnostic = { file: "inline-check.ts", line: 1, col: 1, code: "TS2322", message: "型" };
    const { tsCompile } = answering({
      ok: false,
      typescript: "6.0.3",
      diagnostics: [diagnostic],
      declarations: [{ id: "inline-check", params: [], unreadable: false }],
      missingVariables: [],
    });
    const res = await check({ source: "x;", phase: "preload" }, tsCompile);
    expect(res.json()).toEqual({ params: [], diagnostics: [diagnostic] });
  });

  it("通れば誤りは空", async () => {
    const { tsCompile } = answering({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0.11.0",
      declarations: [{ id: "inline-check", params: [PARAM], unreadable: false }],
    });
    const res = await check({ source: SOURCE, phase: "behavior" }, tsCompile);
    expect(res.json()).toEqual({ params: [PARAM], diagnostics: [] });
  });

  it("届かなければ 503", async () => {
    const res = await check(
      { source: "x;", phase: "behavior" },
      { compile: () => Promise.reject(new TsCompileUnreachable("connect ECONNREFUSED")) },
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "ts-compile unreachable" });
  });

  it("名乗りが無ければ 401、始められなければ 404 で、検査しない", async () => {
    const { asked, tsCompile } = answering({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0",
      declarations: [],
    });
    const body = { source: "x;", phase: "behavior" };
    const none = await check(body, tsCompile, {
      resolveIdentity: () => Promise.resolve(undefined),
    });
    expect(none.statusCode).toBe(401);
    const denied = await check(body, tsCompile, { fga: fgaAnswering(false) });
    expect(denied.statusCode).toBe(404);
    expect(asked).toEqual([]);
  });

  it("形の違う本文は 400 で、検査しない", async () => {
    const { asked, tsCompile } = answering({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0",
      declarations: [],
    });
    expect((await check({ source: "x;", phase: "other" }, tsCompile)).statusCode).toBe(400);
    expect((await check({ phase: "behavior" }, tsCompile)).statusCode).toBe(400);
    expect(asked).toEqual([]);
  });

  it("窓口の無い配備では口を作らない", async () => {
    const res = await check({ source: "x;", phase: "behavior" }, undefined);
    expect(res.statusCode).toBe(404);
  });
});
