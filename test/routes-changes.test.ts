import type { OpenFgaClient } from "@openfga/sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerChangeRoutes } from "../src/api/changes.js";
import type { ChangeReads, ChangeRunDetail, ChangeRunRow } from "../src/changes/reads.js";

/**
 * 前回からの変化を読むエンドポイント。読む SQL は偽物 (`changes/reads.ts` の形は `changes-smoke` が本物の DB で見る)。
 * 見るのは認可の 2 段 (`can_submit` で通し、`can_view` で絞る) と、要約に必ず付く印。
 */
const CRAWL = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-12T04:00:00.000Z");

const run = (over: Partial<ChangeRunRow> = {}): ChangeRunRow => ({
  crawlId: CRAWL,
  scheduleId: "22222222-2222-4222-8222-222222222222",
  scheduleName: "毎朝の 5 サイト",
  startedAt: NOW,
  scheduledFor: NOW,
  prevCrawlId: "33333333-3333-4333-8333-333333333333",
  state: "summarized",
  pagesCompared: 2,
  pagesChanged: 2,
  significance: "content",
  headline: "ANA のニュースが入れ替わった",
  error: null,
  archiveIds: ["a-now", "a-prev", "b-now", "b-prev"],
  ...over,
});

const ref = (archiveId: string) => ({
  archiveId,
  objectKey: `${archiveId}.wacz`,
  sourceUrl: "https://site.test/",
  capturedAt: NOW,
  browserhiveVersion: "29.0.2",
});

const detail: ChangeRunDetail = {
  run: run(),
  summary: {
    model: "claude-opus-5-5",
    promptVersion: "change-v1",
    usd: "0.015000",
    output: {
      headline: "ANA のニュースが入れ替わった",
      pages: [
        {
          url: "https://a.test/",
          significance: "content",
          headline: "記事",
          quotes: ["ANA月次輸送実績", "ok"],
          quotesUnverified: ["ok"],
        },
        {
          url: "https://b.test/",
          significance: "none",
          headline: "時刻",
          quotes: [],
          quotesUnverified: [],
        },
      ],
    },
  },
  pages: [
    {
      url: "https://a.test/",
      stage: null,
      state: "diffed",
      added: 1,
      removed: 1,
      hunks: [["-x", "+ANA月次輸送実績"]],
      after: ref("a-now"),
      before: ref("a-prev"),
    },
    {
      url: "https://b.test/",
      stage: null,
      state: "diffed",
      added: 1,
      removed: 1,
      hunks: [["-1", "+2"]],
      after: ref("b-now"),
      before: ref("b-prev"),
    },
  ],
};

describe("前回からの変化を読むエンドポイント", () => {
  let app: FastifyInstance;
  let named: boolean;
  let submit: boolean;
  let viewable: Set<string>;

  beforeEach(async () => {
    named = true;
    submit = true;
    viewable = new Set(["a-now", "a-prev", "b-now", "b-prev"]);
    app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    const reads: ChangeReads = {
      listRuns: () => Promise.resolve([run()]),
      runDetail: (id) => Promise.resolve(id === CRAWL ? structuredClone(detail) : undefined),
    };
    registerChangeRoutes(app, {
      fga: {
        check: () => Promise.resolve({ allowed: submit }),
        batchCheck: ({ checks }: { checks: { object: string }[] }) =>
          Promise.resolve({
            result: checks.map((c) => ({
              allowed: viewable.has(c.object.replace(/^archive:/, "")),
              request: { object: c.object },
            })),
          }),
      } as unknown as OpenFgaClient,
      resolveIdentity: () =>
        Promise.resolve(named ? { subject: "alice", organizations: ["acme"] } : undefined),
      reads,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("名乗らなければ 401、頼めなければ一覧は空・1 本は 404", async () => {
    named = false;
    expect((await app.inject({ url: "/api/changes" })).statusCode).toBe(401);
    named = true;
    submit = false;
    expect((await app.inject({ url: "/api/changes" })).json()).toEqual({ runs: [] });
    expect((await app.inject({ url: `/api/crawls/${CRAWL}/changes` })).statusCode).toBe(404);
  });

  it("一覧は回のまとめを返し、見てよくない WACZ を含む回は要約を伏せる", async () => {
    expect((await app.inject({ url: "/api/changes" })).json()).toMatchObject({
      runs: [
        {
          crawlId: CRAWL,
          headline: "ANA のニュースが入れ替わった",
          significance: "content",
          restricted: false,
        },
      ],
    });
    viewable.delete("b-prev");
    expect((await app.inject({ url: "/api/changes" })).json()).toMatchObject({
      runs: [{ crawlId: CRAWL, headline: null, significance: null, restricted: true }],
    });
  });

  it("before は日時でなければ 400", async () => {
    expect((await app.inject({ url: "/api/changes?before=yesterday" })).statusCode).toBe(400);
  });

  it("1 本は要約に「証拠ではない」と model・prompt の版・費用を付け、引用ごとに照合を返す", async () => {
    const body = (await app.inject({ url: `/api/crawls/${CRAWL}/changes` })).json<{
      summary: unknown;
      pages: { url: string; quotes: unknown }[];
    }>();
    expect(body.summary).toEqual({
      evidence: false,
      model: "claude-opus-5-5",
      promptVersion: "change-v1",
      usd: 0.015,
    });
    expect(body.pages[0]).toMatchObject({
      url: "https://a.test/",
      significance: "content",
      quotes: [
        { text: "ANA月次輸送実績", verified: true },
        { text: "ok", verified: false },
      ],
      before: { archiveId: "a-prev", objectKey: "a-prev.wacz" },
      after: { archiveId: "a-now" },
    });
  });

  it("前か今の WACZ を見てよくないページは返さない", async () => {
    viewable.delete("b-prev");
    const body = (await app.inject({ url: `/api/crawls/${CRAWL}/changes` })).json<{
      pages: { url: string }[];
      restricted: boolean;
      headline: string | null;
    }>();
    expect(body.pages.map((p) => p.url)).toEqual(["https://a.test/"]);
    expect(body).toMatchObject({ restricted: true, headline: null });
  });

  it("無い回は 404、id が UUID でなければ 400", async () => {
    expect(
      (await app.inject({ url: "/api/crawls/44444444-4444-4444-8444-444444444444/changes" }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/api/crawls/nope/changes" })).statusCode).toBe(400);
  });
});
