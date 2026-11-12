/**
 * クロールのリンクの構成を読むエンドポイント (`GET /api/crawls/:id/links` と `…/links/:page`・`039`)。
 *
 * 本物の Kysely に SQL を組ませる代役 (`recording-db.ts`) で見る。SQL が Postgres で本当に通るか・URL ごとの
 * 最初の 1 本が本当にそう選ばれるかは、CI の「Links against Postgres」(`src/tools/links-smoke.ts`) が見る。
 * ここで見るのは、読んだ行を答えの形に組む所と、認可。
 */
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerCrawlRoutes, type CrawlRouteDeps } from "../src/api/crawls.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import type { LinkGraph } from "../src/crawl/links-read.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const SITE = "https://site.test";

const build = async (
  results: readonly (readonly object[])[],
  allowed = true,
): Promise<{ app: FastifyInstance; queries: RecordedQuery[] }> => {
  const { db, queries } = recordingDb(results);
  const app = Fastify({ logger: false });
  registerCrawlRoutes(app, {
    db,
    fga: { check: () => Promise.resolve({ allowed }) },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    dispatch: () => Promise.resolve(undefined),
    s3: {},
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  return { app, queries };
};

const page = (
  id: string,
  parent: string | null,
  depth: number,
  path: string,
  state = "captured",
) => ({
  id,
  parent,
  depth,
  url: `${SITE}${path}`,
  state,
  reason: state === "skipped" ? "robots" : null,
  title: path === "/" ? "起点" : null,
});

describe("GET /api/crawls/:id/links", () => {
  // hub の形を枚数 3 で撮ったクロール: 起点 10・葉 11 と 12 (12 は robots で見送り)。
  // 行の無い URL は、葉 3 と hidden (枚数で切った) と、別のホストの 2 本
  const rows = [
    [{ id: CRAWL, linksRecordedAt: new Date("2026-11-13T00:00:00Z") }],
    [
      page("10", null, 0, "/"),
      page("11", "10", 1, "/leaf/1"),
      page("12", "10", 1, "/leaf/2", "skipped"),
    ],
    [
      { fromPage: "10", outcome: "followed", n: 2 },
      { fromPage: "10", outcome: "max_pages", n: 2 },
      { fromPage: "10", outcome: "skip", n: 2 },
      { fromPage: "11", outcome: "known", n: 1 },
    ],
    [{ id: "10", n: 1 }],
    [
      { fromPage: "10", outcome: "max_pages", hostname: "site.test", n: 2 },
      { fromPage: "10", outcome: "skip", hostname: "b.test", n: 1 },
      { fromPage: "10", outcome: "skip", hostname: "a.test", n: 1 },
    ],
    [{ fromPage: "11", to: "10" }],
  ];

  it("ページ・内訳・束・ホスト・木に無い辺を 1 度に返す", async () => {
    const { app } = await build(rows);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links` });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json<LinkGraph>();
    expect(body.recorded).toBe(true);
    // 内訳は URL ごと。起点は数えない (行の在る 2 つは、結末で分かれる)
    expect(body.summary).toEqual({
      pending: 0,
      captured: 1,
      failed: 0,
      skipped: 1,
      maxPages: 2,
      maxDepth: 0,
      closed: 0,
      skip: 2,
      nofollow: 0,
      hosts: 2,
    });
    expect(body.pages).toHaveLength(3);
    expect(body.pages[0]).toEqual({
      ...page("10", null, 0, "/"),
      out: { followed: 2, known: 0, maxPages: 2, maxDepth: 0, closed: 0, skip: 2, nofollow: 0 },
      in: 1,
    });
    // リンクの無いページは、数が 0 (null ではない —— 記録は在る)
    expect(body.pages[2]?.out).toEqual({
      followed: 0,
      known: 0,
      maxPages: 0,
      maxDepth: 0,
      closed: 0,
      skip: 0,
      nofollow: 0,
    });
    expect(body.pages[2]?.in).toBe(0);
    expect(body.bundles).toEqual([{ from: "10", outcome: "max_pages", urls: 2 }]);
    // 同じ数なら名前の順
    expect(body.hosts).toEqual([
      { hostname: "a.test", urls: 1 },
      { hostname: "b.test", urls: 1 },
    ]);
    expect(body.cross).toEqual([["11", "10"]]);
    expect(body.crossTruncated).toBe(false);
  });

  it("内訳の合計は、束とホストの合計と合う（URL ごとに数えている）", async () => {
    const { app } = await build(rows);
    const body = (
      await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links` })
    ).json<LinkGraph>();
    await app.close();
    const bundled = body.bundles.reduce((n, b) => n + b.urls, 0);
    const hosted = body.hosts.reduce((n, h) => n + h.urls, 0);
    const summary = body.summary!;
    expect(bundled).toBe(summary.maxPages + summary.maxDepth + summary.closed);
    expect(hosted).toBe(summary.skip);
  });

  it("リンクの記録が無いクロールは、ページと親だけを返し、リンクの表を読まない", async () => {
    const { app, queries } = await build([
      [{ id: CRAWL, linksRecordedAt: null }],
      [page("10", null, 0, "/"), page("11", "10", 1, "/leaf/1")],
    ]);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links` });
    await app.close();
    expect(res.json()).toEqual({
      crawlId: CRAWL,
      recorded: false,
      summary: null,
      pages: [
        { ...page("10", null, 0, "/"), out: null, in: null },
        { ...page("11", "10", 1, "/leaf/1"), out: null, in: null },
      ],
      bundles: [],
      hosts: [],
      cross: [],
      crossTruncated: false,
    });
    expect(queries.some((query) => query.sql.includes("crawl_links"))).toBe(false);
  });

  it("無いクロールは 404", async () => {
    const { app } = await build([[]]);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links` });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it("許可が無ければ 404 で、DB を引かない", async () => {
    const { app, queries } = await build(rows, false);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links` });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(queries).toEqual([]);
  });
});

describe("GET /api/crawls/:id/links/:page", () => {
  const out = [
    { seq: 0, url: `${SITE}/leaf/1`, text: "leaf 1", rule: 1, outcome: "followed", to: "11" },
    { seq: 1, url: `${SITE}/leaf/3`, text: "", rule: 1, outcome: "max_pages", to: null },
  ];

  it("そのページから出るリンクと、入ってくるリンクの元のページを返す", async () => {
    const { app, queries } = await build([[{ id: "10" }], out, [{ from: "11", text: "戻る" }]]);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links/10` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ out, in: [{ from: "11", text: "戻る" }] });
    // ページはクロールとの組で引く (ほかのクロールのページを読ませない)
    expect(queries[0]?.parameters).toEqual([CRAWL, "10"]);
  });

  it("そのクロールに無いページは 404 で、リンクを読まない", async () => {
    const { app, queries } = await build([[]]);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links/10` });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(queries).toHaveLength(1);
  });

  it("ページの id が数字でなければ 400", async () => {
    const { app } = await build([]);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links/abc` });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("許可が無ければ 404 で、DB を引かない", async () => {
    const { app, queries } = await build([[{ id: "10" }]], false);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}/links/10` });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(queries).toEqual([]);
  });
});
