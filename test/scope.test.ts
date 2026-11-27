import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { Identity } from "../src/config/identity.js";
import { CRAWL_SCOPE, START_SCOPE, scopeRefusal, startScopeAllows } from "../src/api/scope.js";
import { registerScopeGate, rememberIdentity } from "../src/api/scope-gate.js";

/**
 * 機械のトークンの scope で、届いてよい route を絞る (CAPTURE-450)。広い scope (`crawl`) は今までどおり全部通り、
 * 狭い scope (`crawl.start`) は始める・読むだけ。人とヘッダの経路には掛けない。
 */
const machine = (scopes: string[]): Identity => ({
  subject: "client-id",
  organizations: ["acme"],
  machine: true,
  scopes,
});
const human: Identity = { subject: "alice-sub", organizations: ["acme"], name: "alice" };

describe("scopeRefusal", () => {
  it("広い scope は、どの route も通る (Windmill の flow・smoke・doctor)", () => {
    for (const [method, url] of [
      ["POST", "/api/crawls/:id/pages"],
      ["POST", "/api/schedules"],
      ["GET", "/api/archives"],
    ] as const) {
      expect(scopeRefusal(machine([CRAWL_SCOPE]), method, url)).toBeUndefined();
    }
  });

  it("狭い scope は、始める・読む route だけ通る", () => {
    const ai = machine([START_SCOPE]);
    expect(scopeRefusal(ai, "POST", "/api/crawls")).toBeUndefined();
    expect(scopeRefusal(ai, "GET", "/api/crawls/:id")).toBeUndefined();
    expect(scopeRefusal(ai, "POST", "/api/archives/:id/url")).toBeUndefined();
  });

  // 行を締める route (`/failed`) は、クロールを止める route ではない (flow は走り続ける)。AI の担当には開かない
  it.each([
    ["POST", "/api/schedules"],
    ["POST", "/api/schedules/:id/run"],
    ["POST", "/api/crawls/:id/pages"],
    ["POST", "/api/crawls/:id/failed"],
    ["POST", "/api/crawls/:id/inline/:name/fix"],
  ])("狭い scope で %s %s は、広い scope が要ると断る", (method, url) => {
    expect(scopeRefusal(machine([START_SCOPE]), method, url)).toEqual({
      error: "insufficient_scope",
      scope: CRAWL_SCOPE,
    });
  });

  // `crawl.start` は `crawl` を頭に含む。字の含みで見ると、狭い token が広い scope として通る
  it("scope は字が同じかで見る (頭が同じ別の scope を、広い scope と読まない)", () => {
    expect(
      scopeRefusal(machine(["capture-ledger/crawl.start.extra"]), "GET", "/api/crawls"),
    ).toEqual({
      error: "insufficient_scope",
      scope: START_SCOPE,
    });
    expect(
      scopeRefusal(machine([`${CRAWL_SCOPE}x`]), "POST", "/api/crawls/:id/pages"),
    ).toBeDefined();
  });

  it("scope を持たない機械のトークンは、読む route でも断る", () => {
    expect(scopeRefusal(machine([]), "GET", "/api/crawls")).toEqual({
      error: "insufficient_scope",
      scope: START_SCOPE,
    });
  });

  // 人は組織の許可 (OpenFGA) が今までどおり絞る。画面のサインインの token の scope は見ない
  it("人とヘッダの経路には掛けない", () => {
    expect(scopeRefusal(human, "POST", "/api/schedules")).toBeUndefined();
    expect(
      scopeRefusal({ subject: "bob", organizations: [] }, "POST", "/api/schedules"),
    ).toBeUndefined();
  });
});

/**
 * src の書き込みの route を全部、狭い scope で通す・断るのどちらかに分ける。**書き込みの route を足すと、ここが赤になる**
 * —— 狭い scope に開くかどうかを、足す人が選ぶ (一覧に無い書き込みは、門が既定で断る)。GET はみな通す。
 *
 * **拾える形には限りがある。** `src/api/` の直下の `.ts` で、`<何か>.get|post|put|delete|patch(` の後に path の字が
 * そのまま書いてある登録だけ。下の folder・`app.route({…})`・定数の path で登録した route は拾えない (今の src には
 * どれも無い)。そう書く日には、組んだ app から `onRoute` で並べる形に替える。
 */
describe("狭い scope で届く route の一覧", () => {
  const API = join(import.meta.dirname, "../src/api");
  // `app.post<{ … Record<string, never> }>(` のように型引数に `>` が入っても拾えるよう、`(` と path の前まで遅く読む
  const REGISTER = /\.(get|post|put|delete|patch)\s*(?:<[\s\S]*?>)?\(\s*"(\/[^"]*)"/g;
  const routes = readdirSync(API)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) =>
      [...readFileSync(join(API, file), "utf8").matchAll(REGISTER)].map(
        (match) => `${match[1]!.toUpperCase()} ${match[2]!}`,
      ),
    )
    .filter((route) => route.split(" ")[1]!.startsWith("/api/") && !route.includes("/api/sink/"))
    .sort();

  /** 狭い scope で届く書き込み。読む route (GET) はみな届く。 */
  const START_WRITES = ["POST /api/archives/:id/url", "POST /api/crawls"];
  /** 狭い scope では断る書き込み。 */
  const REFUSED_WRITES = [
    "POST /api/archives/:id/changes/summary",
    "POST /api/crawls/:id/failed",
    "POST /api/crawls/:id/index",
    "POST /api/crawls/:id/inline/:name/fix",
    "POST /api/crawls/:id/pages",
    "POST /api/crawls/:id/replay-bundle",
    "POST /api/schedules",
    "POST /api/schedules/:id/delete",
    "POST /api/schedules/:id/pause",
    "POST /api/schedules/:id/repin",
    "POST /api/schedules/:id/resume",
    "POST /api/schedules/:id/run",
    "POST /api/scripts/check",
  ];

  it("src の route を拾えている (拾い方が壊れたら赤)", () => {
    expect(routes).toContain("POST /api/crawls");
    expect(routes).toContain("POST /api/crawls/:id/inline/:name/fix");
    expect(routes.length).toBeGreaterThan(40);
  });

  it("書き込みの route は、どれも一覧のどちらかに在る", () => {
    const writes = routes.filter((route) => !route.startsWith("GET "));
    expect(writes).toEqual([...START_WRITES, ...REFUSED_WRITES].sort());
  });

  it("一覧と門が同じことを言う", () => {
    for (const route of routes) {
      const [method, url] = route.split(" ") as [string, string];
      const allowed = method === "GET" || START_WRITES.includes(route);
      expect(startScopeAllows(method, url), route).toBe(allowed);
    }
  });
});

/** 門は route の手続きより前に断り、名乗りは 1 要求に 1 度だけ確かめる。 */
describe("registerScopeGate", () => {
  const build = async (identity: Identity | undefined) => {
    const resolve = vi.fn(() => Promise.resolve(identity));
    const resolveIdentity = rememberIdentity(resolve);
    const handler = vi.fn(async (request: Parameters<typeof resolveIdentity>[0]) => {
      await resolveIdentity(request);
      return { ok: true };
    });
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    registerScopeGate(app, resolveIdentity);
    app.post(
      "/api/schedules",
      { schema: { body: { type: "object", required: ["name"] } } },
      handler,
    );
    app.post("/api/crawls", handler);
    app.get("/api/crawls", handler);
    app.put("/api/sink/:crawlId/:filename", handler);
    await app.ready();
    return { app, resolve, handler };
  };

  it("狭い scope の書き込みを、本文の検査より前に 403 で断る", async () => {
    const { app, handler } = await build(machine([START_SCOPE]));
    // 本文は schema に合わない。それでも 400 でなく 403 (届いてはいけない route の本文の形を教えない)
    const res = await app.inject({ method: "POST", url: "/api/schedules", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "insufficient_scope", scope: CRAWL_SCOPE });
    expect(res.headers["www-authenticate"]).toBe(
      `Bearer error="insufficient_scope", scope="${CRAWL_SCOPE}"`,
    );
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it("狭い scope で始める・読む route は、手続きまで届く。名乗りは 1 度だけ確かめる", async () => {
    const { app, resolve, handler } = await build(machine([START_SCOPE]));
    expect((await app.inject({ method: "POST", url: "/api/crawls", payload: {} })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/api/crawls" })).statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
    // 門と手続きの 2 か所で訊いても、確かめるのは要求ごとに 1 度
    expect(resolve).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("名乗れない要求は門を素通りし、手続きが今までどおり決める", async () => {
    const { app, handler } = await build(undefined);
    expect((await app.inject({ method: "POST", url: "/api/crawls", payload: {} })).statusCode).toBe(
      200,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("受け取り先 (/api/sink/*) は見ない (名乗りを使わない route)", async () => {
    const { app, resolve } = await build(machine([]));
    expect(
      (await app.inject({ method: "PUT", url: "/api/sink/x/y", payload: {} })).statusCode,
    ).toBe(200);
    // 手続きが 1 度訊いただけ (門は訊いていない)
    expect(resolve).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("人のトークンは、どの route も門を通る", async () => {
    const { app } = await build(human);
    expect(
      (await app.inject({ method: "POST", url: "/api/schedules", payload: { name: "x" } }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });
});
