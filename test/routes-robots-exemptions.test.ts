import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import {
  registerRobotsExemptionsRoute,
  type RobotsExemptionsRouteDeps,
} from "../src/api/robots-exemptions.js";
import type { Identity } from "../src/config/identity.js";
import type { ExemptionRow } from "../src/exemptions/store.js";
import { recordingDb } from "./recording-db.js";

/**
 * robots.txt の例外のエンドポイント (`src/api/robots-exemptions.ts`) の検査。
 *
 * DB は Kysely に SQL を組ませて記録する代役 (`recording-db.ts`)、OpenFGA は訊かれた問いを記録する代役。だから
 * 「断る時は SQL を出さない」「admin を、正しい組織に、contextual tuple なしで訊く」を、組んだ SQL と問いで言える。
 *
 * **ここの fga は、言われた答えを返すだけ。** 見ているのは経路 (どの問いを訊き、答えでどう分かれるか) で、
 * 「submitter は admin ではない」のような認可そのものは `fga/model.fga.yaml` の assertion が本物のモデルで見る。
 * 同時の登録が 1 本だけ通るかは、CI の `src/tools/robots-exemptions-smoke.ts` が本物の Postgres で見る。
 */
const NOW = new Date("2026-11-28T03:00:00.000Z");
const EXPIRES = "2026-12-28T03:00:00.000Z";
const UA = "BrowserHive/1.0 (web archiving; user-directed capture)";

const alice: Identity = { subject: "alice-sub", organizations: ["acme"], name: "alice" };

const rowOf = (overrides: Partial<ExemptionRow> = {}): ExemptionRow => ({
  id: "7",
  orgId: "acme",
  host: "site.test",
  pathPattern: "/",
  scope: "seeds",
  appliesTo: "all",
  userAgent: UA,
  reason: "証拠として残す",
  dailyLimit: 100,
  linkLimit: 20,
  createdBy: "alice-sub",
  createdByName: "alice",
  createdAt: NOW,
  expiresAt: new Date(EXPIRES),
  revokedAt: null,
  revokedBy: null,
  revokedByName: null,
  ...overrides,
});

/** 行の答え。時刻は JSON の字になる。 */
const answerOf = (row: ExemptionRow, state: string) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
  state,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  orgId: "acme",
  host: "Site.TEST",
  scope: "seeds",
  userAgent: UA,
  reason: "証拠として残す",
  expiresAt: EXPIRES,
  ...overrides,
});

interface Options {
  /** 名乗り。null は名乗り無し。 */
  identity?: Identity | null;
  identityMode?: RobotsExemptionsRouteDeps["identityMode"];
  /** fga の答え。関数なら、問いの relation ごとに決める。 */
  allowed?: boolean | ((relation: string, object: string) => boolean);
  rows?: readonly (readonly object[])[];
  payload?: object;
}

const call = async (method: "GET" | "POST", url: string, options: Options = {}) => {
  const { db, queries } = recordingDb(options.rows ?? []);
  const asked: { request: Record<string, unknown>; options: unknown }[] = [];
  const allowed = options.allowed ?? true;
  const fga = {
    check: (request: Record<string, string>, checkOptions: unknown) => {
      asked.push({ request, options: checkOptions });
      return Promise.resolve({
        allowed:
          typeof allowed === "function"
            ? allowed(request["relation"]!, request["object"]!)
            : allowed,
      });
    },
  };
  // 本物の server.ts と同じ設定 (知らない鍵を、削らずに拒む)
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  const identity = options.identity === undefined ? alice : options.identity;
  registerRobotsExemptionsRoute(app, {
    db,
    fga: fga as unknown as RobotsExemptionsRouteDeps["fga"],
    resolveIdentity: () => Promise.resolve(identity ?? undefined),
    identityMode: options.identityMode ?? "jwt",
    now: () => NOW,
  });
  await app.ready();
  const res = await app.inject({
    method,
    url,
    ...(options.payload !== undefined && { payload: options.payload }),
  });
  await app.close();
  return { res, queries, asked };
};

const WRITES = [
  ["/api/robots-exemptions", body()],
  ["/api/robots-exemptions/7/revoke", undefined],
] as const;

describe("robots.txt の例外のエンドポイントの認可", () => {
  it.each([
    ["GET", "/api/robots-exemptions", undefined],
    ["POST", "/api/robots-exemptions", body()],
    // 名乗らない `{}` も 400 でなく 401 (schema に required を書かない訳)
    ["POST", "/api/robots-exemptions", {}],
    ["POST", "/api/robots-exemptions/7/revoke", undefined],
  ] as const)(
    "名乗りが無ければ 401 で、SQL も OpenFGA への問いも出さない: %s %s %j",
    async (method, url, payload) => {
      const { res, queries, asked } = await call(method, url, {
        identity: null,
        ...(payload !== undefined && { payload }),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
      expect(queries).toEqual([]);
      expect(asked).toEqual([]);
    },
  );

  it.each(WRITES)("機械の主体の書き込みは 403 で、何も訊かない: %s", async (url, payload) => {
    const { res, queries, asked } = await call("POST", url, {
      identity: { subject: "client-id", organizations: ["acme"], machine: true },
      ...(payload !== undefined && { payload }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "machine identities cannot manage robots exemptions" });
    expect(queries).toEqual([]);
    expect(asked).toEqual([]);
  });

  it.each(WRITES)("ヘッダの経路の書き込みは 403 で、何も訊かない: %s", async (url, payload) => {
    const { res, queries, asked } = await call("POST", url, {
      identityMode: "header",
      ...(payload !== undefined && { payload }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "robots exemptions are not available with header identities",
    });
    expect(queries).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("名乗りの組織でない orgId の登録は 403 で、OpenFGA に訊かない", async () => {
    const { res, queries, asked } = await call("POST", "/api/robots-exemptions", {
      payload: body({ orgId: "contoso" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not an organization admin" });
    expect(queries).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("orgId の無い登録は 403 (名乗りの 1 つ目の組織に頼らない)", async () => {
    const { res, asked } = await call("POST", "/api/robots-exemptions", {
      payload: { ...body(), orgId: undefined },
    });
    expect(res.statusCode).toBe(403);
    expect(asked).toEqual([]);
  });

  it("admin でなければ登録は 403。関係 admin を本文の組織に、contextual tuple なしで訊く", async () => {
    const { res, queries, asked } = await call("POST", "/api/robots-exemptions", {
      // 始めてよい者 (can_submit) でも、admin でなければ通らない
      allowed: (relation) => relation !== "admin",
      payload: body(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not an organization admin" });
    expect(queries).toEqual([]);
    expect(asked).toEqual([
      {
        request: { user: "user:alice-sub", relation: "admin", object: "organization:acme" },
        options: { consistency: "HIGHER_CONSISTENCY" },
      },
    ]);
    // 所属の申告を渡すと、検査が申告で満たせる (tasks/lessons.md)
    expect(asked[0]!.request).not.toHaveProperty("contextualTuples");
    expect(asked[0]!.request).not.toHaveProperty("context");
  });

  it("admin の検査は、本文の検査より先 (admin でない者に、本文のどこが駄目かを言わない)", async () => {
    const { res } = await call("POST", "/api/robots-exemptions", {
      allowed: false,
      payload: body({ userAgent: "Mozilla/5.0" }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/robots-exemptions", () => {
  it("登録して 201 で行を返す。ホストは整え、既定を埋め、登録した主体と名前を残す", async () => {
    const row = rowOf();
    const { res, queries, asked } = await call("POST", "/api/robots-exemptions", {
      rows: [[], [], [row]],
      payload: body(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(answerOf(row, "active"));
    expect(asked).toHaveLength(1);

    expect(queries.map(({ sql }) => sql.split(" ")[0])).toEqual([
      "begin",
      "select",
      "select",
      "insert",
      "commit",
    ]);
    expect(queries[3]!.parameters).toEqual([
      "acme",
      "site.test",
      "/",
      "seeds",
      "all",
      UA,
      "証拠として残す",
      100,
      20,
      "alice-sub",
      "alice",
      NOW.toISOString(),
      EXPIRES,
    ]);
  });

  it("名乗りの 2 つ目の組織にも登録できる (admin はその組織で訊く)", async () => {
    const { res, asked } = await call("POST", "/api/robots-exemptions", {
      identity: { subject: "alice-sub", organizations: ["acme", "contoso"] },
      rows: [[], [], [rowOf({ orgId: "contoso", createdByName: null })]],
      payload: body({ orgId: "contoso" }),
    });
    expect(res.statusCode).toBe(201);
    expect(asked[0]!.request).toMatchObject({ relation: "admin", object: "organization:contoso" });
  });

  it.each([
    [{ host: "*.site.test" }, "host"],
    [{ host: "https://site.test/path" }, "host"],
    [{ pathPattern: "/a\nDisallow: /" }, "pathPattern"],
    [{ pathPattern: "status" }, "pathPattern"],
    [{ scope: "all" }, "scope"],
    [{ appliesTo: "machine" }, "appliesTo"],
    [{ userAgent: "" }, "userAgent"],
    [{ userAgent: "BrowserHive/1.0 Chrome/131.0" }, "userAgent"],
    [{ userAgent: "BrowserHive/1.0 ({chrome})" }, "userAgent"],
    [{ userAgent: "BrowserHive/1.0 (Mozilla/5.0)" }, "userAgent"],
    [{ reason: "   " }, "reason"],
    [{ reason: "あ".repeat(501) }, "reason"],
    [{ expiresAt: "2026-11-28T03:00:00.000Z" }, "expiresAt"],
    // 90 日を 1 日超える
    [{ expiresAt: "2027-02-27T03:00:00.000Z" }, "expiresAt"],
    [{ expiresAt: "来月" }, "expiresAt"],
    [{ dailyLimit: 0 }, "dailyLimit"],
    [{ linkLimit: 1001 }, "linkLimit"],
  ])("中身が駄目なら 400 で欄を名指し、SQL を出さない: %j", async (overrides, field) => {
    const { res, queries } = await call("POST", "/api/robots-exemptions", {
      payload: body(overrides),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) as string, field });
    expect(queries).toEqual([]);
  });

  it("欄の無い本文は 400 で、最初に足りない欄を名指す", async () => {
    const { res } = await call("POST", "/api/robots-exemptions", { payload: { orgId: "acme" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: "host" });
  });

  // 型は fastify の ajv が既定で寄せる ("100" は 100 になる)。寄せられない物と、知らない鍵が 400
  it.each([
    [{ unknown: 1 }],
    [{ dailyLimit: 1.5 }],
    [{ dailyLimit: "many" }],
    [{ reason: { text: "x" } }],
  ])("知らない鍵と型の違う欄は 400 (黙って削らない): %j", async (overrides) => {
    const { res, queries } = await call("POST", "/api/robots-exemptions", {
      payload: body(overrides),
    });
    expect(res.statusCode).toBe(400);
    expect(queries).toEqual([]);
  });

  it("同じ path の型で効いている行が在れば 409 で、その行を名指す", async () => {
    const { res, queries } = await call("POST", "/api/robots-exemptions", {
      rows: [[], [{ id: "4", pathPattern: "/", userAgent: UA }]],
      payload: body(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "an active robots exemption already covers this host and path pattern",
      id: "4",
    });
    expect(queries.some(({ sql }) => sql.startsWith("insert"))).toBe(false);
  });

  it("効いている行の名乗りが違えば 409 で、今の名乗りを返す", async () => {
    const { res } = await call("POST", "/api/robots-exemptions", {
      rows: [[], [{ id: "4", pathPattern: "/status/", userAgent: "BrowserHive/2.0" }]],
      payload: body(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "active robots exemptions for this host use a different user agent",
      userAgent: "BrowserHive/2.0",
    });
  });
});

describe("GET /api/robots-exemptions", () => {
  it("呼び手が始めてよい組織の行だけを引き、状態を付けて返す", async () => {
    const active = rowOf({ id: "9" });
    const expired = rowOf({ id: "8", expiresAt: new Date("2026-11-27T00:00:00.000Z") });
    const revoked = rowOf({
      id: "7",
      revokedAt: new Date("2026-11-20T00:00:00.000Z"),
      revokedBy: "erin-sub",
      revokedByName: "erin",
    });
    const { res, queries, asked } = await call("GET", "/api/robots-exemptions", {
      identity: { subject: "alice-sub", organizations: ["acme", "contoso", "globex"] },
      // contoso では始められない
      allowed: (_relation, object) => object !== "organization:contoso",
      rows: [[active, expired, revoked]],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      exemptions: [
        answerOf(active, "active"),
        answerOf(expired, "expired"),
        answerOf(revoked, "revoked"),
      ],
    });
    // 訊くのは can_submit (読むのに admin は要らない)。contextual tuple は送らない
    expect(asked.map(({ request }) => request)).toEqual([
      { user: "user:alice-sub", relation: "can_submit", object: "organization:acme" },
      { user: "user:alice-sub", relation: "can_submit", object: "organization:contoso" },
      { user: "user:alice-sub", relation: "can_submit", object: "organization:globex" },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('where "org_id" in ($1, $2)');
    expect(queries[0]!.parameters).toEqual(["acme", "globex"]);
  });

  it("始めてよい組織が無ければ 200 の空で、SQL を出さない", async () => {
    const { res, queries } = await call("GET", "/api/robots-exemptions", { allowed: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exemptions: [] });
    expect(queries).toEqual([]);
  });

  it("機械の主体とヘッダの経路でも、読むのは通る", async () => {
    const machine = await call("GET", "/api/robots-exemptions", {
      identity: { subject: "client-id", organizations: ["acme"], machine: true },
      rows: [[]],
    });
    expect(machine.res.statusCode).toBe(200);
    const header = await call("GET", "/api/robots-exemptions", {
      identityMode: "header",
      rows: [[]],
    });
    expect(header.res.statusCode).toBe(200);
  });
});

describe("POST /api/robots-exemptions/:id/revoke", () => {
  const revoke = (options: Options = {}) =>
    call("POST", "/api/robots-exemptions/7/revoke", options);

  it("取り消して 200 で行を返す。取り消した主体と名前を残す", async () => {
    const revoked = rowOf({ revokedAt: NOW, revokedBy: "alice-sub", revokedByName: "alice" });
    const { res, queries, asked } = await revoke({ rows: [[rowOf()], [revoked]] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(answerOf(revoked, "revoked"));
    // admin は、行の組織で訊く
    expect(asked).toEqual([
      {
        request: { user: "user:alice-sub", relation: "admin", object: "organization:acme" },
        options: { consistency: "HIGHER_CONSISTENCY" },
      },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.sql).toContain('update "robots_exemptions"');
    expect(queries[1]!.parameters).toEqual([NOW.toISOString(), "alice-sub", "alice", "7", NOW]);
  });

  it("無い行は 404 で、OpenFGA に訊かない", async () => {
    const { res, asked } = await revoke({ rows: [[]] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(asked).toEqual([]);
  });

  it("名乗りの組織に無い行は、在っても 404 (無い行と同じ答え) で、OpenFGA に訊かず、書かない", async () => {
    const { res, queries, asked } = await revoke({ rows: [[rowOf({ orgId: "contoso" })]] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(asked).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it("自分の組織の行でも、admin でなければ 403 で、書かない", async () => {
    const { res, queries, asked } = await revoke({
      allowed: (relation) => relation !== "admin",
      rows: [[rowOf()]],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "not an organization admin" });
    expect(asked[0]!.request).toEqual({
      user: "user:alice-sub",
      relation: "admin",
      object: "organization:acme",
    });
    expect(queries).toHaveLength(1);
  });

  it("もう取り消した行は 409", async () => {
    const gone = rowOf({ revokedAt: NOW, revokedBy: "erin-sub" });
    const { res } = await revoke({ rows: [[gone], [], [gone]] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "robots exemption is already revoked" });
  });

  it("期限の過ぎた行は 409 (取り消す物が無い)", async () => {
    const expired = rowOf({ expiresAt: new Date("2026-11-27T00:00:00.000Z") });
    const { res } = await revoke({ rows: [[expired], [], [expired]] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "robots exemption has already expired" });
  });

  it.each(["0", "abc", "-1", "1.5", "9".repeat(19)])(
    "番号の形でなければ 400 で、SQL を出さない: %s",
    async (id) => {
      const { res, queries } = await call("POST", `/api/robots-exemptions/${id}/revoke`);
      expect(res.statusCode).toBe(400);
      expect(queries).toEqual([]);
    },
  );
});
