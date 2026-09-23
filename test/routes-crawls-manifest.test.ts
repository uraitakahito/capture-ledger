/**
 * 段の報告の manifest の結末 —— 契約と、書き留める値と、`admitLevel` に渡す鍵。
 *
 * これは配線の試験。場所を鍵に直す判断は `manifest-outcome.test.ts` が、鍵で読む段取りは
 * `admit-level.test.ts` が見ている。ここで見るのは **その判断が、書き留める値と読みに行く
 * 鍵の両方に届いているか**。片方だけ届いていると、台帳には鍵が在るのに段の登録は別の
 * 鍵を読む (あるいはその逆) という食い違いが、どの単体試験にも映らない。
 *
 * `admitLevel` は偽物にして呼ばれ方だけを記録する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { CrawlRouteDeps } from "../src/api/crawls.js";
import type { CrawlScript } from "../src/db/database.js";

vi.mock("../src/crawl/admit-level.js", () => ({ admitLevel: vi.fn() }));

const { admitLevel } = await import("../src/crawl/admit-level.js");
const { registerCrawlRoutes } = await import("../src/api/crawls.js");
const { parseCaptureFormats } = await import("../src/config/capture-formats.js");

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const TASK = "550e8400-e29b-41d4-a716-446655440000";
const PAGE = "https://example.com/start";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };

/** `capture_submissions` に書こうとした行。insert の `values` が受け取ったもの。 */
let inserted: unknown[];
/** クロールが固定した目録。報告の `compiled` と突き合わされる (`crawl/compiled.ts`)。 */
let fakeScripts: CrawlScript[] = [];
/** 走った JS の hash と変換の記録。台帳側で必須なので、どの報告にも載せる。 */
const COMPILED = { typescript: "6.0.3", hostTypes: "v0.2.0", scripts: [] };

const fakeDb = {
  selectFrom: () => ({
    selectAll: () => ({
      where: () => ({
        executeTakeFirst: () =>
          Promise.resolve({
            id: CRAWL,
            orgId: "acme",
            requestedBy: "alice",
            state: "running",
            maxPages: 10,
            maxDepth: 2,
            scope: "same-host",
            seeds: [PAGE],
            perHostDelayMs: 0,
            hostParallelism: 1,
            pagesDiscovered: 1,
            pagesCaptured: 0,
            artifactKeyPrefix: null,
            scripts: fakeScripts,
          }),
      }),
    }),
  }),
  updateTable: () => ({
    set: () => ({
      where: () => ({
        execute: () => Promise.resolve(),
        where: () => ({ execute: () => Promise.resolve() }),
      }),
    }),
  }),
  insertInto: () => ({
    values: (rows: unknown) => {
      inserted.push(rows);
      return {
        onConflict: () => ({ execute: () => Promise.resolve() }),
        execute: () => Promise.resolve(),
      };
    },
  }),
};

const buildApp = async (): Promise<FastifyInstance> => {
  // 本物の server と同じく、知らない鍵は削らずに拒む (`api/server.ts`)。
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  registerCrawlRoutes(app, {
    db: fakeDb,
    fga: { check: () => Promise.resolve({ allowed: true }) },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    dispatch: () => Promise.resolve(),
    s3: {},
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  return app;
};

/**
 * 1 段ぶんの報告を投げ、応答の status を返す。
 *
 * **応答が 200 かどうかは見ない**（400 の試験を除く）。この偽 DB は `admitLevel` を
 * 呼ぶところまでしか写しておらず、その先 (次の段の立案) では落ちる。
 */
const report = async (results: Record<string, unknown>[]): Promise<number> => {
  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: SUBJECT,
      payload: { depth: 0, results, compiled: COMPILED },
    });
    return res.statusCode;
  } finally {
    await app.close();
  }
};

/** 本文を丸ごと指定して投げる。status と、台帳の言い分。 */
const post = async (
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: SUBJECT,
      payload,
    });
    return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
  } finally {
    await app.close();
  }
};

/** 書き留めた行のうち、最初の 1 行。 */
const firstRow = (): Record<string, unknown> | undefined =>
  (inserted[0] as Record<string, unknown>[] | undefined)?.[0];

beforeEach(() => {
  inserted = [];
  fakeScripts = [];
  vi.mocked(admitLevel).mockReset();
  vi.mocked(admitLevel).mockResolvedValue({ registered: 0, admittedUrls: [] });
});

/**
 * 段の報告の `compiled` —— 走った JS の hash と、何で・何に向けて変換したか。
 * 断る条件そのものは `crawl-compiled.test.ts` が見ている。ここで見るのは配線: schema が
 * 必須にしていること、断りが status と言い分になって返り、その先 (帰属・登録) に進まないこと。
 */
describe("段の報告の compiled", () => {
  it("compiled の無い報告は 400 —— 古い flow を黙って通さない", async () => {
    expect((await post({ depth: 0, results: [] })).status).toBe(400);
    expect(admitLevel).not.toHaveBeenCalled();
  });

  it("compiled の中の知らない鍵は 400", async () => {
    const res = await post({ depth: 0, results: [], compiled: { ...COMPILED, cached: false } });
    expect(res.status).toBe(400);
  });

  it("前の段と違う JS の hash は 409 で、どれかを名指しし、先へ進まない", async () => {
    fakeScripts = [
      {
        id: "autoscroll",
        version: 3,
        phase: "behavior",
        source: "ts",
        sha256: "a".repeat(64),
        options: {},
        jsSha256: "b".repeat(64),
        compiledWith: { typescript: "6.0.3", hostTypes: "v0.2.0" },
      },
    ];
    const res = await post({
      depth: 1,
      results: [],
      compiled: {
        ...COMPILED,
        scripts: [{ id: "autoscroll", version: 3, sha256: "c".repeat(64) }],
      },
    });
    expect(res.status).toBe(409);
    expect(res.body["scriptId"]).toBe("autoscroll@3");
    expect(admitLevel).not.toHaveBeenCalled();
  });
});

describe("段の報告と manifest", () => {
  // flow が運び忘れた。受けてしまうと、その取り込みは読みに行く鍵を持たないまま残る。
  it("taskId を持つのに結末が無い報告は 400", async () => {
    expect(await report([{ url: PAGE, status: "captured", taskId: TASK }])).toBe(400);
    expect(inserted).toEqual([]);
    expect(admitLevel).not.toHaveBeenCalled();
  });

  it("結末を 2 つ持つ報告は 400", async () => {
    expect(
      await report([
        {
          url: PAGE,
          status: "captured",
          taskId: TASK,
          manifestLocation: "s3://b/x.result.json",
          manifestError: "boom",
        },
      ]),
    ).toBe(400);
  });

  // 投入が通らなかったページ (taskId が無い) に結末は付かない。
  it("taskId の無い結末は 400", async () => {
    expect(
      await report([{ url: PAGE, status: "failed", manifestLocation: "s3://b/x.result.json" }]),
    ).toBe(400);
  });

  /**
   * **これが本題。** 見本の場所は BrowserHive の命名規則では作れない綴りにしてある ——
   * 規則どおりの名前だと、taskId と crawlId から組み直す実装でも同じ鍵になって緑で通る。
   */
  it("書けた場所から組み直さずに鍵を取り、書き留める値と読みに行く鍵が同じ", async () => {
    await report([
      {
        url: PAGE,
        status: "captured",
        taskId: TASK,
        manifestLocation: "s3://b/elsewhere/x y+z.result.json",
      },
    ]);

    expect(firstRow()?.["manifestKey"]).toBe("elsewhere/x y+z.result.json");
    expect(firstRow()?.["manifestError"]).toBeNull();
    expect(vi.mocked(admitLevel).mock.calls[0]?.[0]).toEqual([
      { taskId: TASK, url: PAGE, manifestKey: "elsewhere/x y+z.result.json" },
    ]);
  });

  it("書けなかった報告は理由を書き留め、鍵は渡さない", async () => {
    await report([
      {
        url: PAGE,
        status: "failed",
        taskId: TASK,
        manifestError: "s3://b/x.result.json: not written within 10000ms",
      },
    ]);

    expect(firstRow()?.["manifestKey"]).toBeNull();
    expect(firstRow()?.["manifestError"]).toBe("s3://b/x.result.json: not written within 10000ms");
    expect(vi.mocked(admitLevel).mock.calls[0]?.[0]).toEqual([
      { taskId: TASK, url: PAGE, manifestKey: null },
    ]);
  });

  // 報告の bucket で読み先が変わらないこと。段の報告は落とさず、読めない理由を残す。
  it("別の bucket を指す場所は読まず、理由を書き留める", async () => {
    expect(
      await report([
        {
          url: PAGE,
          status: "captured",
          taskId: TASK,
          manifestLocation: "s3://someone-else/x.result.json",
        },
      ]),
    ).not.toBe(400);

    expect(firstRow()?.["manifestKey"]).toBeNull();
    expect(firstRow()?.["manifestError"]).toContain("someone-else");
  });
});
