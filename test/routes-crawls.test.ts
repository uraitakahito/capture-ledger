import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerCrawlRoutes, type CrawlRouteDeps } from "../src/api/crawls.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";

/**
 * クロールを起こす口の検査。
 *
 * 2 層で見る。入口の検証は張りぼて deps で、認可と単一実行は
 * 偽の DB で見る。**認可そのものを見ているのではない** —— fga は「false を返せ」と
 * 言われて false を返しているだけで、`can_submit` が誰を拒むかは
 * `fga/model.fga.yaml` の assertion が見ている。
 */
const TOUCHED_DEPS = "deps を使った（検証を通過した証拠）";
const explode = (): never => {
  throw new Error(TOUCHED_DEPS);
};

const unreachableDeps = {
  db: new Proxy({}, { get: explode }),
  fga: new Proxy({}, { get: explode }),
  resolveIdentity: explode,
  dispatch: explode,
} as unknown as CrawlRouteDeps;

const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const UUID = "d272d256-e528-4581-bb4e-8d9477d78196";
const SEED = "https://example.com/start";

const buildApp = async (deps: CrawlRouteDeps): Promise<FastifyInstance> => {
  // server.ts と同じ ajv 設定 —— 知らない鍵を落とさずに拒む。
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
    return reply.code(500).send({ error: "internal error" });
  });
  registerCrawlRoutes(app, deps);
  await app.ready();
  return app;
};

describe("クロール route の入力検証", () => {
  let app: FastifyInstance;
  const original = process.env["CAPTURE_LEDGER_DEV_IDENTITY"];

  beforeEach(async () => {
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
    app = await buildApp(unreachableDeps);
  });

  afterEach(async () => {
    await app.close();
    if (original === undefined) delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
    else process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = original;
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/crawls", headers: SUBJECT, payload });

  it("空の seeds を拒む", async () => {
    // 「どちらか一方」の判定は handler に置いてある (ajv の `oneOf` だと
    // 「どちらでもない」と「両方」が同じ 400 になり、言い分を分けられない)。
    // schema の層で落ちるのは、**配列として空**のときだけ。
    expect((await post({ seeds: [] })).statusCode).toBe(400);
  });

  it("rejects a body key that is not on the allowlist", async () => {
    expect((await post({ seeds: [SEED], signing: true })).statusCode).toBe(400);
  });

  it("rejects a scope it does not know", async () => {
    // 範囲は挙動を決めるので、綴りの誤りを通すと黙って別の範囲になる。
    expect((await post({ seeds: [SEED], scope: "same-site" })).statusCode).toBe(400);
  });

  it("rejects limits outside their range", async () => {
    expect((await post({ seeds: [SEED], maxPages: 0 })).statusCode).toBe(400);
    expect((await post({ seeds: [SEED], maxDepth: -1 })).statusCode).toBe(400);
    expect((await post({ seeds: [SEED], hostParallelism: 0 })).statusCode).toBe(400);
  });

  it("allows a zero delay so a test can take it away on purpose", async () => {
    // 0 を弾くと「間隔が効いている」の反証が書けなくなる。schema は通し、
    // 通った先で deps に触れて落ちる。
    expect((await post({ seeds: [SEED], perHostDelayMs: 0 })).statusCode).toBe(500);
  });

  it("rejects a crawl id that is not a uuid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/crawls/not-a-uuid",
      headers: SUBJECT,
    });
    expect(res.statusCode).toBe(400);
  });
});

/** 認可と単一実行を見るための、最小の偽物。 */
interface FakeCrawl {
  id: string;
  seeds: string[];
  scope: string;
  state: string;
  maxDepth: number;
  maxPages: number;
  perHostDelayMs: number;
  hostParallelism: number;
  orgId: string;
  requestedBy: string;
  stopReason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  pagesDiscovered: number;
  pagesCaptured: number;
  error: string | null;
  lastJobId?: string | null;
  lastJobDepth?: number | null;
}

/** `crawl_pages` の 1 行。`GET /api/crawls/:id` の `failures` を見るのに要る欄だけ。 */
interface FakePage {
  crawlId: string;
  url: string;
  depth: number;
  state: string;
  skipReason: string | null;
}

/**
 * 走行中を 1 本だけ許す偽の DB。本物は部分 unique index が守るので、ここでは同じ形の
 * 失敗（`23505` と制約名）を投げて、409 への翻訳だけを固定する。
 *
 * **index そのものはここでは証明できない** —— 制約を持っているのが偽物のほうだから。
 * 本物の Postgres に対して別途確かめること。
 */
/** `capture_targets` の 1 行。組織で絞れることを見るために `orgId` を持つ。 */
interface FakeTarget {
  url: string;
  enabled: boolean;
  orgId: string;
}

const fakeDb = (
  crawls: FakeCrawl[],
  targets: FakeTarget[] = [],
  pages: FakePage[] = [],
  /** `updateTable(...).set(値)` の値を、呼ばれた順に積む。 */
  updates: Record<string, unknown>[] = [],
) => ({
  insertInto: (table: string) => ({
    values: (row: Record<string, unknown> | Record<string, unknown>[]) => ({
      /**
       * 深さ 0 の行は `onConflict(...).returning(...)` で入れる。
       *
       * **重複排除まで写す。** 本物は `(crawl_id, url_hash)` の unique index が
       * 落とすので、ここで素通しにすると「同じ URL を 2 つ種に書いても 2 回取る」
       * という、本物では起きない振る舞いを試験が肯定してしまう。
       */
      onConflict: () => ({
        returning: () => ({
          execute: async (): Promise<{ url: string; host: string }[]> => {
            const rows = (Array.isArray(row) ? row : [row]) as { url: string; host: string }[];
            const seen = new Set<string>();
            return Promise.resolve(
              rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))),
            );
          },
        }),
      }),
      execute: async (): Promise<void> => {
        if (table === "crawlPages") return Promise.resolve();
        if (crawls.some((c) => c.state === "running")) {
          const err = new Error("duplicate key") as Error & { code: string; constraint: string };
          err.code = "23505";
          err.constraint = "crawls_single_active_idx";
          throw err;
        }
        crawls.push({
          ...(row as unknown as FakeCrawl),
          stopReason: null,
          startedAt: new Date(),
          finishedAt: null,
          pagesDiscovered: 0,
          pagesCaptured: 0,
          error: null,
        });
        await Promise.resolve();
      },
    }),
  }),
  updateTable: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      /**
       * `where` は何度でも続き、`returning(...).execute()` で「実際に当たった行」を返す。
       *
       * **`state = 'running'` の条件まで写す。** 素通しにすると、終わったクロールに
       * 後から `failed` を被せる誤りが試験で見えなくなる。
       */
      const build = (conds: [string, unknown][]) => ({
        // 式で書いた条件 (`where((eb) => …)`) は写さない。見ているのは id と state だけ。
        where: (column: string | ((eb: unknown) => unknown), _op?: unknown, value?: unknown) =>
          typeof column === "function" ? build(conds) : build([...conds, [column, value]]),
        execute: async (): Promise<void> => Promise.resolve(),
        returning: () => ({
          execute: async (): Promise<{ id: string }[]> => {
            const id = conds.find(([c]) => c === "id")?.[1];
            const wantState = conds.find(([c]) => c === "state")?.[1];
            const row = crawls.find((c) => c.id === id);
            if (!row) return Promise.resolve([]);
            if (wantState !== undefined && row.state !== wantState) return Promise.resolve([]);
            row.state = "failed";
            return Promise.resolve([{ id: row.id }]);
          },
        }),
      });
      return build([]);
    },
  }),
  selectFrom: (table: string) => ({
    selectAll: () => ({
      where: (_c: unknown, _o: unknown, id: string) => ({
        executeTakeFirst: async (): Promise<FakeCrawl | undefined> =>
          Promise.resolve(crawls.find((c) => c.id === id)),
      }),
    }),
    /**
     * `loadTargets` の読み方を写す。
     *
     * **問い合わせが指定した条件だけを当てる。** 最初は `enabled` を無条件に
     * 絞っていたが、それだと**本物から `enabled` の条件を外しても試験が緑のまま**に
     * なる (反証で素通りした)。偽物が制約を持っていると、消したことに気づけない。
     */
    select: () => {
      if (table === "crawls") {
        // 409 のときに「走っている 1 本」を引く。
        return {
          where: (_c: unknown, _o: unknown, state: string) => ({
            executeTakeFirst: async () =>
              Promise.resolve(
                crawls
                  .filter((c) => c.state === state)
                  .map((c) => ({ id: c.id, startedAt: c.startedAt }))[0],
              ),
          }),
        };
      }
      if (table === "crawlPages") {
        // `GET /api/crawls/:id` の `failures`。**指定された条件だけを当てる**（下と同じ理由）。
        const pageQuery = (where: [string, unknown][], limit: number | undefined) => ({
          where: (column: string, _op: unknown, value: unknown) =>
            pageQuery([...where, [column, value]], limit),
          orderBy: () => pageQuery(where, limit),
          limit: (n: number) => pageQuery(where, n),
          execute: async () => {
            const matched = pages.filter((p) =>
              where.every(
                ([column, value]) => (p as unknown as Record<string, unknown>)[column] === value,
              ),
            );
            return Promise.resolve(limit === undefined ? matched : matched.slice(0, limit));
          },
        });
        return pageQuery([], undefined);
      }
      const build = (where: [string, unknown][], limit: number | undefined) => ({
        where: (column: string, _op: unknown, value: unknown) =>
          build([...where, [column, value]], limit),
        orderBy: () => build(where, limit),
        limit: (n: number) => build(where, n),
        execute: async (): Promise<{ url: string }[]> => {
          const matched = targets.filter((t) =>
            where.every(
              ([column, value]) => (t as unknown as Record<string, unknown>)[column] === value,
            ),
          );
          return Promise.resolve(
            (limit === undefined ? matched : matched.slice(0, limit)).map((t) => ({ url: t.url })),
          );
        },
      });
      expect(table).toBe("captureTargets");
      return build([], undefined);
    },
  }),
});

const depsWith = (opts: {
  crawls: FakeCrawl[];
  allowed: boolean;
  dispatch?: CrawlRouteDeps["dispatch"];
  targets?: FakeTarget[];
  pages?: FakePage[];
  updates?: Record<string, unknown>[];
}): CrawlRouteDeps =>
  ({
    db: fakeDb(opts.crawls, opts.targets, opts.pages, opts.updates),
    fga: { check: async () => Promise.resolve({ allowed: opts.allowed }) },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    dispatch: opts.dispatch ?? (() => Promise.resolve()),
    // **本物の設定を使う。** 手書きの literal だと、`capture-formats.ts` が
    // 6 つ全部を返す約束を破っても、この試験は気づかない。
    capture: parseCaptureFormats("wacz", false),
  }) as unknown as CrawlRouteDeps;

describe("クロール route の認可と単一実行", () => {
  it("refuses an unauthenticated caller", async () => {
    // 認可は通す側に倒してある。401 が fga より前で返っている証拠。
    const app = await buildApp({
      ...depsWith({ crawls: [], allowed: true }),
      resolveIdentity: () => Promise.resolve(undefined),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("hides the endpoint from a caller without permission", async () => {
    const app = await buildApp(depsWith({ crawls: [], allowed: false }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a seed that is not an http url", async () => {
    // schema は「文字列であること」しか見ない。scheme はここで落とす。
    const app = await buildApp(depsWith({ crawls: [], allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: ["ftp://example.com/x"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("種を複数受け取り、全部を最初の段に渡す", async () => {
    // run を畳むための土台。`capture_targets` の一覧はここに複数の種として入る。
    const sent: { url: string }[][] = [];
    const app = await buildApp(
      depsWith({
        crawls: [],
        allowed: true,
        dispatch: (crawl) => {
          sent.push(crawl.frontier);
          return Promise.resolve(undefined);
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: ["https://a.example.com/1", "https://b.example.com/2"] },
    });
    expect(sent[0]?.map((f) => f.url)).toEqual([
      "https://a.example.com/1",
      "https://b.example.com/2",
    ]);
    await app.close();
  });

  it("同じ種を 2 度渡しても 1 度しか取らない", async () => {
    // 本物では `(crawl_id, url_hash)` の unique index が落とす。**種の段にも
    // 同じ守りが要る** —— 対象一覧に同じ URL が 2 行あることは普通にありうる。
    const sent: { url: string }[][] = [];
    const app = await buildApp(
      depsWith({
        crawls: [],
        allowed: true,
        dispatch: (crawl) => {
          sent.push(crawl.frontier);
          return Promise.resolve(undefined);
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED, SEED] },
    });
    expect(sent[0]).toHaveLength(1);
    await app.close();
  });

  it("読めない種が 1 本でもあれば拒む", async () => {
    // **黙って落とさない。** 落とすと、投げた側は全部辿ったつもりで結果を読む。
    const app = await buildApp(depsWith({ crawls: [], allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED, "ftp://example.com/x"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts a crawl and answers 202 without waiting for it", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toHaveProperty("crawlId");
    expect(crawls[0]?.state).toBe("running");
    await app.close();
  });

  it("stores the defaults when the caller asks for nothing", async () => {
    // 既定は控えめな側。**30 が効いていること**が、上限で止まる普通の姿を作る。
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    await app.inject({ method: "POST", url: "/api/crawls", payload: { seeds: [SEED] } });
    expect(crawls[0]).toMatchObject({
      scope: "same-origin",
      maxDepth: 2,
      maxPages: 30,
      perHostDelayMs: 2000,
      hostParallelism: 4,
    });
    await app.close();
  });

  it("normalizes the seed before storing it", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: ["https://example.com/start#top"] },
    });
    expect(crawls[0]?.seeds?.[0]).toBe("https://example.com/start");
    await app.close();
  });

  it("refuses a second crawl while one is in flight", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const first = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(crawls).toHaveLength(1);
    await app.close();
  });

  it("answers 404 for a crawl that does not exist", async () => {
    const app = await buildApp(depsWith({ crawls: [], allowed: true }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("409 は、塞いでいる 1 本の id と開始時刻を返す", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const first = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: "a crawl is already in progress",
      crawlId: first.json<{ crawlId: string }>().crawlId,
      startedAt: crawls[0]?.startedAt.toISOString(),
    });
    await app.close();
  });

  it("投げた段の job の id を、その深さと一緒に残す", async () => {
    const updates: Record<string, unknown>[] = [];
    const JOB = "0193b6a1-3c1d-7a2e-9f00-1234567890ab";
    const app = await buildApp(
      depsWith({ crawls: [], allowed: true, updates, dispatch: () => Promise.resolve(JOB) }),
    );
    await app.inject({ method: "POST", url: "/api/crawls", payload: { seeds: [SEED] } });
    // 投げるのは待たない (応答が先に返る) ので、残すのは次の tick。
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates).toContainEqual({ lastJobId: JOB, lastJobDepth: 0 });
    await app.close();
  });

  it("job の id が返らなければ、何も書かない", async () => {
    const updates: Record<string, unknown>[] = [];
    const app = await buildApp(
      depsWith({ crawls: [], allowed: true, updates, dispatch: () => Promise.resolve(undefined) }),
    );
    await app.inject({ method: "POST", url: "/api/crawls", payload: { seeds: [SEED] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates.filter((u) => "lastJobId" in u)).toEqual([]);
    await app.close();
  });

  it("GET は最後の段の job と、取れなかったページとその理由を返す", async () => {
    const crawl: FakeCrawl = {
      id: UUID,
      seeds: [SEED],
      scope: "same-origin",
      state: "succeeded",
      maxDepth: 0,
      maxPages: 30,
      perHostDelayMs: 2000,
      hostParallelism: 4,
      orgId: "acme",
      requestedBy: "alice",
      stopReason: "completed",
      startedAt: new Date("2026-09-19T00:00:00Z"),
      finishedAt: new Date("2026-09-19T00:00:10Z"),
      pagesDiscovered: 2,
      pagesCaptured: 1,
      error: null,
      lastJobId: "0193b6a1-3c1d-7a2e-9f00-1234567890ab",
      lastJobDepth: 0,
    };
    const pages: FakePage[] = [
      {
        crawlId: UUID,
        url: "https://example.com/ok",
        depth: 0,
        state: "captured",
        skipReason: null,
      },
      {
        crawlId: UUID,
        url: "https://nonexistent.invalid/",
        depth: 0,
        state: "failed",
        skipReason: "net::ERR_NAME_NOT_RESOLVED",
      },
    ];
    const app = await buildApp(depsWith({ crawls: [crawl], allowed: true, pages }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      lastJob: { id: "0193b6a1-3c1d-7a2e-9f00-1234567890ab", depth: 0 },
      failures: [
        { url: "https://nonexistent.invalid/", depth: 0, reason: "net::ERR_NAME_NOT_RESOLVED" },
      ],
    });
    await app.close();
  });

  it("GET は、job の記録が無ければ lastJob を null にする", async () => {
    const crawl = {
      id: UUID,
      seeds: [SEED],
      scope: "same-origin",
      state: "running",
      maxDepth: 0,
      maxPages: 30,
      perHostDelayMs: 2000,
      hostParallelism: 4,
      orgId: "acme",
      requestedBy: "alice",
      stopReason: null,
      startedAt: new Date(),
      finishedAt: null,
      pagesDiscovered: 1,
      pagesCaptured: 0,
      error: null,
      lastJobId: null,
      lastJobDepth: null,
    } satisfies FakeCrawl;
    const app = await buildApp(depsWith({ crawls: [crawl], allowed: true }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.json()).toMatchObject({ lastJob: null, failures: [] });
    await app.close();
  });
});

describe("対象一覧から起こす", () => {
  const targets: FakeTarget[] = [
    { url: "https://a.example.com/1", enabled: true, orgId: "acme" },
    { url: "https://b.example.com/2", enabled: true, orgId: "acme" },
    { url: "https://c.example.com/3", enabled: false, orgId: "acme" },
    { url: "https://d.example.com/4", enabled: true, orgId: "other" },
  ];

  const start = async (payload: Record<string, unknown>, crawls: FakeCrawl[] = []) => {
    const sent: { url: string }[][] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        targets,
        dispatch: (crawl) => {
          sent.push(crawl.frontier);
          return Promise.resolve(undefined);
        },
      }),
    );
    const res = await app.inject({ method: "POST", url: "/api/crawls", payload });
    await app.close();
    return { res, sent, crawls };
  };

  it("有効な行だけを、自分の組織のぶんだけ種にする", async () => {
    // **組織で絞る。** 以前の CLI 経路 (run.ts) は「他組織が混じっていたら投げる」
    // していたが、クロールは `org_id` を 1 つ持つ行なので、混ぜると帰属が言えない。
    const { res, sent } = await start({ fromTargets: {} });
    expect(res.statusCode).toBe(202);
    expect(sent[0]?.map((f) => f.url)).toEqual([
      "https://a.example.com/1",
      "https://b.example.com/2",
    ]);
  });

  it("既定では辿らない（max_depth = 0）", async () => {
    // それが `runs` の意味だった —— 深さも範囲も持たない 1 回。
    const { crawls } = await start({ fromTargets: {} });
    expect(crawls[0]?.maxDepth).toBe(0);
  });

  it("明示された深さは勝つ", async () => {
    // 「一覧を種にして 2 段辿る」も書ける。畳んだことで表せる幅が減っていない。
    const { crawls } = await start({ fromTargets: {}, maxDepth: 2 });
    expect(crawls[0]?.maxDepth).toBe(2);
  });

  it("max_pages が種の数を下回らない", async () => {
    // 既定の 30 のままだと、対象が 30 件を超えた瞬間に黙って切り落とされる。
    const { crawls } = await start({ fromTargets: {} });
    expect(crawls[0]?.maxPages).toBeGreaterThanOrEqual(2);
  });

  it("limit は種の数を絞る", async () => {
    const { sent } = await start({ fromTargets: { limit: 1 } });
    expect(sent[0]).toHaveLength(1);
  });

  it("対象が 1 件も無ければ 400（500 ではない）", async () => {
    // `011` の CHECK に当たって 500 にすると、呼ぶ側から見て「壊れた」になる。
    // 実際には「取るものが無い」なので、そう言う。
    const app = await buildApp(depsWith({ crawls: [], allowed: true, targets: [] }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { fromTargets: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("no enabled capture targets");
    await app.close();
  });

  it("seeds と fromTargets の両方は拒む", async () => {
    // どちらを使うかをこちらが決めることになる。
    const { res } = await start({ seeds: [SEED], fromTargets: {} });
    expect(res.statusCode).toBe(400);
  });

  it("どちらも無ければ拒む", async () => {
    const { res } = await start({});
    expect(res.statusCode).toBe(400);
  });
});

describe("落ちた段を受けて締める", () => {
  const running = (): FakeCrawl[] => [{ id: UUID, state: "running" }] as unknown as FakeCrawl[];

  const post = async (crawls: FakeCrawl[], body: Record<string, unknown> = {}) => {
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${UUID}/failed`,
      payload: body,
    });
    await app.close();
    return res;
  };

  it("走行中のものを締める", async () => {
    // **これが無いと、flow が段の途中で落ちたクロールが永久に走行中になる。**
    // 部分 unique index が以後のクロールを全部塞ぐ (実測で踏んだ)。
    const crawls = running();
    const res = await post(crawls, { reason: "BrowserHive に届きません" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"closed":true');
    expect(crawls[0]?.state).toBe("failed");
  });

  it("終わったものには被せない", async () => {
    // 段の失敗が遅れて届くことはある。そのとき既に別の段が締めていれば、
    // **そちらの理由のほうが正しい。**
    const crawls = [{ id: UUID, state: "succeeded" }] as unknown as FakeCrawl[];
    const res = await post(crawls);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"closed":false');
    expect(crawls[0]?.state).toBe("succeeded");
  });

  it("知らない id でも 200 で「締めるものが無い」と答える", async () => {
    // 締める相手が無いのは異常ではない。呼ぶ側 (failure_module) は
    // どのみち投げない立場なので、ここで 404 にしても誰も読まない。
    const res = await post([]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"closed":false');
  });

  it("権限が無ければ 404", async () => {
    const app = await buildApp(depsWith({ crawls: running(), allowed: false }));
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${UUID}/failed`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("知らない鍵は拒む", async () => {
    const res = await post(running(), { reason: "x", extra: 1 });
    expect(res.statusCode).toBe(400);
  });
});
