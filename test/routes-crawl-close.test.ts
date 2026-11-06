/**
 * 段の報告で締めるとき、1 枚も撮れていなければ failed にする (`crawl/close.ts`)。
 *
 * 本物の Kysely に SQL を組ませ、実行の直前で取り上げる代役 (`recording-db.ts`) で見る。走っている行だけを
 * 締める条件そのものは `routes-crawl-decisions.test.ts`。ここで見るのは、数え方と、書く値。
 *
 * `admitLevel` は偽物にする。拾い直し (`failed` の報告に成功の manifest が在る) の場面を、manifest を
 * 組まずに作るため。
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { CrawlRouteDeps } from "../src/api/crawls.js";
import { nothingCapturedError } from "../src/crawl/close.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

vi.mock("../src/crawl/admit-level.js", () => ({ admitLevel: vi.fn() }));

const { admitLevel } = await import("../src/crawl/admit-level.js");
const { registerCrawlRoutes } = await import("../src/api/crawls.js");
const { parseCaptureFormats } = await import("../src/config/capture-formats.js");

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const TASK = "550e8400-e29b-41d4-a716-446655440000";
const SEED = "https://site.test/";
const OTHER = "https://site.test/other";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };

const crawlRow = (over: { pagesCaptured?: number; state?: string } = {}) => ({
  id: CRAWL,
  seeds: [SEED],
  rules: [{ follow: "same-host" }],
  orgId: "acme",
  requestedBy: "alice",
  state: "running",
  maxDepth: 2,
  maxPages: 20,
  perHostDelayMs: 0,
  hostParallelism: 1,
  pagesDiscovered: 0,
  pagesCaptured: 0,
  artifactKeyPrefix: null,
  scripts: [],
  variables: {},
  secrets: {},
  ...over,
});

/** 次の段が無い報告を投げ、応答と、締める UPDATE を返す。 */
const close = async (
  results: Record<string, unknown>[],
  opts: { row?: ReturnType<typeof crawlRow>; recovered?: string[] } = {},
): Promise<{ status: number; body: unknown; update: RecordedQuery | undefined }> => {
  vi.mocked(admitLevel).mockResolvedValue({
    admittedUrls: opts.recovered ?? [],
    logCounts: new Map(),
  } as unknown as Awaited<ReturnType<typeof admitLevel>>);
  const { db, queries } = recordingDb([
    [opts.row ?? crawlRow()], // クロールの行
    ...results.map(() => [{ id: "11" }]), // 報告した行を閉じる
    ...(results.some((page) => "taskId" in page) ? [[]] : []), // capture_submissions
    ...(opts.recovered === undefined ? [] : [[]]), // 拾い直した行を直す
    [{ count: "1" }], // crawl_pages の数
    [], // crawls の集計
  ]);
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  registerCrawlRoutes(app, {
    db,
    fga: { check: () => Promise.resolve({ allowed: true }) },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    dispatch: () => Promise.resolve(),
    s3: {},
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: `/api/crawls/${CRAWL}/pages`,
    headers: SUBJECT,
    payload: {
      depth: 1,
      compiled: { typescript: "6.0.3", hostTypes: "v0.2.0", scripts: [] },
      results,
    },
  });
  await app.close();
  return {
    status: res.statusCode,
    body: res.json(),
    update: queries.find((query) => query.sql.startsWith('update "crawls" set "pages_captured"')),
  };
};

describe("1 枚も撮れずに終わったクロール", () => {
  it("全部が取れなければ failed で締め、理由を error に書く", async () => {
    const reason = "failed: s3://browserhive/x.wacz: 500 InternalError (3 attempts, 20s)";
    const { status, body, update } = await close([
      { url: SEED, status: "failed", skipReason: reason },
      { url: OTHER, status: "failed", skipReason: "http_error: HTTP 404: Not Found" },
    ]);
    expect(status).toBe(200);
    expect(body).toEqual({ next: [], stopReason: "failed" });
    // 走っている行だけを動かす条件は、state・stop_reason・error の 3 つとも更新の中に在る
    expect(update?.sql).toBe(
      'update "crawls" set "pages_captured" = "pages_captured" + $1, ' +
        '"pages_discovered" = "pages_discovered" + $2, ' +
        '"stop_reason" = case when "state" = $3 then $4 else "stop_reason" end, ' +
        '"state" = case when "state" = $5 then $6 else "state" end, ' +
        '"finished_at" = case when "state" = $7 then $8 else "finished_at" end, ' +
        '"error" = case when "state" = $9 then $10 else "error" end where "id" = $11',
    );
    const parameters = update?.parameters ?? [];
    expect(parameters.slice(0, 7)).toEqual([
      0,
      0,
      "running",
      "failed",
      "running",
      "failed",
      "running",
    ]);
    expect(parameters[8]).toBe("running");
    expect(parameters[9]).toBe(
      `1 枚も撮れませんでした（取れず 2・見送り 0）。最初の理由: ${reason}`,
    );
    expect(parameters[10]).toBe(CRAWL);
  });

  it("全部を見送っても failed で締め、見送りの数と理由を書く", async () => {
    const { body, update } = await close([{ url: SEED, status: "skipped", skipReason: "robots" }]);
    expect(body).toEqual({ next: [], stopReason: "failed" });
    expect(update?.parameters).toContain("failed");
    expect(update?.parameters).toContain(
      "1 枚も撮れませんでした（取れず 0・見送り 1）。最初の理由: robots",
    );
  });
});

describe("1 枚でも撮れたクロール", () => {
  /** 書いた状態と、エラーの欄を書かないことを見る。 */
  const expectSucceeded = ({
    body,
    update,
  }: {
    body: unknown;
    update: RecordedQuery | undefined;
  }): void => {
    expect(body).toEqual({ next: [], stopReason: "completed" });
    expect(update?.parameters).toContain("succeeded");
    expect(update?.parameters).not.toContain("failed");
    expect(update?.sql).not.toContain('"error"');
  };

  it("取れないページが混ざっても succeeded で締める", async () => {
    expectSucceeded(
      await close([
        { url: SEED, status: "captured" },
        { url: OTHER, status: "failed", skipReason: "http_error: HTTP 404: Not Found" },
      ]),
    );
  });

  it("最後の段が全部取れなくても、前の段で撮れていれば succeeded で締める", async () => {
    expectSucceeded(
      await close(
        [{ url: OTHER, status: "failed", skipReason: "http_error: HTTP 404: Not Found" }],
        { row: crawlRow({ pagesCaptured: 3 }) },
      ),
    );
  });

  // 報告は flow の言い分で、正本は manifest。数えた結果と台帳の中身が食い違わないように
  it("failed と報告されても manifest から拾い直せたら撮れたと数え、succeeded で締める", async () => {
    const closed = await close(
      [
        {
          url: SEED,
          status: "failed",
          skipReason: "no report",
          taskId: TASK,
          manifestLocation: "s3://b/x.result.json",
        },
      ],
      { recovered: [SEED] },
    );
    expectSucceeded(closed);
    expect(closed.update?.parameters[0]).toBe(1);
  });
});

describe("走っていない行に届いた、1 枚も撮れていない報告", () => {
  // 読んだ後・書く前に締められた行もあるので、読んだ状態では分岐しない。何を書くかは UPDATE の条件が決める
  it("読んだ状態に関わらず同じ条件つきの UPDATE を送る（締めた時の理由を上書きしない）", async () => {
    const { update } = await close(
      [{ url: SEED, status: "failed", skipReason: "http_error: HTTP 404: Not Found" }],
      { row: crawlRow({ state: "failed" }) },
    );
    expect(update?.sql).toContain('"error" = case when "state" = $9 then $10 else "error" end');
    expect(update?.sql).toContain(
      '"stop_reason" = case when "state" = $3 then $4 else "stop_reason" end',
    );
  });
});

describe("nothingCapturedError", () => {
  it("取れなかった理由を、見送りの理由より先に出す", () => {
    expect(
      nothingCapturedError([
        { status: "skipped", skipReason: "robots" },
        { status: "failed", skipReason: "http_error: HTTP 404: Not Found" },
      ]),
    ).toBe(
      "1 枚も撮れませんでした（取れず 1・見送り 1）。最初の理由: http_error: HTTP 404: Not Found",
    );
  });

  it("理由が無ければ数だけを言う", () => {
    expect(nothingCapturedError([{ status: "failed" }])).toBe(
      "1 枚も撮れませんでした（取れず 1・見送り 0）。",
    );
  });

  it("報告が空でも文を作る", () => {
    expect(nothingCapturedError([])).toBe("1 枚も撮れませんでした（取れず 0・見送り 0）。");
  });

  it("理由は 200 字までで切る", () => {
    expect(nothingCapturedError([{ status: "failed", skipReason: "あ".repeat(201) }])).toBe(
      `1 枚も撮れませんでした（取れず 1・見送り 0）。最初の理由: ${"あ".repeat(200)}`,
    );
  });
});
