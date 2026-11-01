import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerScriptsRoute, type ScriptsRouteDeps } from "../src/api/scripts.js";
import { recordingDb } from "./recording-db.js";

/**
 * スクリプトを読む口 (`src/api/scripts.ts`) の検査。
 *
 * DB は Kysely に SQL を組ませて記録する代役 (`recording-db.ts`)。だから「許可が無ければ SQL を
 * 1 本も出さない」と「1 版の口は版で絞る」を、組んだ SQL で言える。Postgres で本当に通るかは
 * CI の `scripts/scripts-smoke.mjs` が見る (口と同じ関数を CLI から呼ぶ)。
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
  it("その版を丸ごと（source・バイト数・渡す値・札・有効か・取り込んだ時刻）返す", async () => {
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
    expect(body.versions.map((v) => v["sites"])).toEqual([["site.test"], []]); // 札は版ごと
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
  it("各 id の 1 行を、身元と札と宣言と既定に入るか（id・版・phase・sha256・sites・params・enabled）だけで返す", async () => {
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

  it("サイト用のスクリプトも返す（既定で走る物だけではない）。札で絞らない", async () => {
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
      'select distinct on ("id") "id", "version", "phase", "sha256", "sites", "params", "enabled" from "scripts" ' +
        'order by "id", "enabled" desc, "version" desc',
    );
  });
});
