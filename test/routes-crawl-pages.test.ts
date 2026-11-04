/**
 * クロールのページと、1 ページの取り込みのログを読む口。
 *
 * 本物の Kysely に SQL を組ませ、実行の直前で取り上げる代役 (`recording-db.ts`) で見る。返す行は試験が並べた物
 * なので、**SQL が Postgres で本当に通るかはここでは言えない** (この repo に DB の試験は無い)。ここで見るのは、
 * 組まれた SQL の形 (task_id の uuid 側を text に倒す・ページはクロールとの組で引く) と、口が答える形 (並び・続き・
 * 読めない理由・認可・400・502)。保管庫は、読みに来た鍵を数える偽物。
 */
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerCrawlRoutes, type CrawlRouteDeps } from "../src/api/crawls.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const TASK = "550e8400-e29b-41d4-a716-446655440000";
const ARCHIVE = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
/** 報告が運んだ鍵。BrowserHive の命名規則では作れない綴り (組み直す実装なら別の鍵を読みに行く)。 */
const KEY = "elsewhere/x y+z.result.json";

/** 保管庫に置いた物。object は JSON にして返し、文字列はそのまま返し、Error は投げる。無い鍵は NoSuchKey。 */
type Stored = object | string | Error;

interface Built {
  app: FastifyInstance;
  queries: RecordedQuery[];
  /** 保管庫から読みに来た `bucket/鍵`。 */
  read: string[];
}

const build = async (opts: {
  results?: readonly (readonly object[])[];
  allowed?: boolean;
  store?: Record<string, Stored>;
}): Promise<Built> => {
  const { db, queries } = recordingDb(opts.results);
  const read: string[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string } }) => {
      read.push(`${command.input.Bucket}/${command.input.Key}`);
      const stored = opts.store?.[command.input.Key];
      if (stored === undefined) {
        // 本物の SDK が無い鍵に投げる物 (`archive/s3.ts` の isNotFound が name で見分ける)
        const missing = Object.assign(new Error("The specified key does not exist."), {
          name: "NoSuchKey",
        });
        return Promise.reject(missing);
      }
      if (stored instanceof Error) return Promise.reject(stored);
      const body = typeof stored === "string" ? stored : JSON.stringify(stored);
      return Promise.resolve({ Body: { transformToString: () => Promise.resolve(body) } });
    },
  };
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
    return reply.code(500).send({ error: "internal error", message: error.message });
  });
  registerCrawlRoutes(app, {
    db,
    fga: { check: () => Promise.resolve({ allowed: opts.allowed ?? true }) },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    dispatch: () => Promise.resolve(undefined),
    s3,
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  return { app, queries, read };
};

const get = async (url: string, opts: Parameters<typeof build>[0] = {}) => {
  const built = await build(opts);
  const res = await built.app.inject({ method: "GET", url, headers: SUBJECT });
  await built.app.close();
  return { res, queries: built.queries, read: built.read };
};

/** DB が返すページの行 (`pageRows` の select の形)。 */
const row = (over: Record<string, unknown> = {}) => ({
  id: "42",
  url: "https://site.test/",
  depth: 0,
  state: "captured",
  skipReason: null,
  taskId: TASK,
  logCounts: { debug: 0, info: 12, warn: 1, error: 0, dropped: 0 },
  archiveId: ARCHIVE,
  ...over,
});

/** BrowserHive が `.result.json` に書くとおりの答え (`log` は持たない)。 */
const manifest = {
  taskId: TASK,
  url: "https://site.test/",
  labels: [],
  status: "success",
  timestamp: "2026-11-04T00:00:00.000Z",
  captureProcessingTimeMs: 100,
  artifacts: { wacz: "s3://b/x.wacz" },
};

describe("クロールのページを読む", () => {
  const url = `/api/crawls/${CRAWL}/pages`;

  it("ページを id の昇順で返し、WACZ は task_id の uuid 側を text に倒して繋ぐ（続きが無ければ next は null）", async () => {
    const pending = row({
      id: "43",
      url: "https://site.test/next",
      depth: 1,
      state: "pending",
      taskId: null,
      logCounts: null,
      archiveId: null,
    });
    const failed = row({
      id: "44",
      url: "https://site.test/slow",
      depth: 1,
      state: "failed",
      skipReason: "timeout: capture exceeded its budget",
      archiveId: null,
    });
    const { res, queries } = await get(url, {
      results: [[{ id: CRAWL }], [row(), pending, failed]],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pages: [
        {
          id: "42",
          url: "https://site.test/",
          depth: 0,
          state: "captured",
          reason: null,
          taskId: TASK,
          archiveId: ARCHIVE,
          logCounts: { debug: 0, info: 12, warn: 1, error: 0, dropped: 0 },
        },
        {
          id: "43",
          url: "https://site.test/next",
          depth: 1,
          state: "pending",
          reason: null,
          taskId: null,
          archiveId: null,
          logCounts: null,
        },
        {
          id: "44",
          url: "https://site.test/slow",
          depth: 1,
          state: "failed",
          reason: "timeout: capture exceeded its budget",
          taskId: TASK,
          archiveId: null,
          logCounts: { debug: 0, info: 12, warn: 1, error: 0, dropped: 0 },
        },
      ],
      next: null,
    });

    expect(queries[0]?.sql).toBe('select "id" from "crawls" where "id" = $1');
    expect(queries[1]?.sql).toBe(
      'select distinct on ("p"."id") "p"."id", "p"."url", "p"."depth", "p"."state", "p"."skip_reason", ' +
        '"p"."task_id", "p"."log_counts", "a"."id" as "archive_id" from "crawl_pages" as "p" ' +
        'left join "archives" as "a" on "p"."task_id" = "a"."task_id"::text ' +
        'where "p"."crawl_id" = $1 order by "p"."id", "a"."created_at" limit $2',
    );
    // 既定の 100 本より 1 本多く引く (続きが在るかを言うため)
    expect(queries[1]?.parameters).toEqual([CRAWL, 101]);
  });

  it("limit より 1 本多く返れば、最後に返したページの id を next にし、after はその次から引く", async () => {
    const { res, queries } = await get(`${url}?after=7&limit=2`, {
      results: [[{ id: CRAWL }], [row({ id: "8" }), row({ id: "9" }), row({ id: "10" })]],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pages: { id: string }[]; next: string | null }>();
    expect(body.pages.map((page) => page.id)).toEqual(["8", "9"]);
    expect(body.next).toBe("9");
    expect(queries[1]?.sql).toContain('where "p"."crawl_id" = $1 and "p"."id" > $2 order by');
    expect(queries[1]?.parameters).toEqual([CRAWL, "7", 3]);
  });

  it("ちょうど limit 本なら next は null", async () => {
    const { res } = await get(`${url}?limit=2`, {
      results: [[{ id: CRAWL }], [row({ id: "8" }), row({ id: "9" })]],
    });
    expect(res.json()).toMatchObject({ next: null });
  });

  it("after は数字だけで 18 桁まで、limit は 1〜500。外れは 400 で、DB を引かない", async () => {
    for (const query of [
      "after=abc",
      "after=-1",
      "after=1.5",
      "after=",
      `after=${"9".repeat(19)}`,
      "limit=0",
      "limit=501",
      "limit=1.5",
      "limit=x",
    ]) {
      const { res, queries } = await get(`${url}?${query}`);
      expect(res.statusCode, query).toBe(400);
      expect(queries, query).toEqual([]);
    }
    // 境目の内側は通る (外れの 400 が、境目を広く取りすぎた schema のせいではないことの確かめ)
    for (const query of [`after=${"9".repeat(18)}`, "after=0", "limit=500", "limit=1"]) {
      const { res } = await get(`${url}?${query}`, { results: [[{ id: CRAWL }], []] });
      expect(res.statusCode, query).toBe(200);
    }
  });

  it("クロールが無ければ 404 で、ページを引かない", async () => {
    const { res, queries } = await get(url, { results: [[]] });
    expect(res.statusCode).toBe(404);
    expect(queries).toHaveLength(1);
  });

  it("許可が無ければ 404 で、DB を引かない", async () => {
    const { res, queries } = await get(url, { allowed: false });
    expect(res.statusCode).toBe(404);
    expect(queries).toEqual([]);
  });
});

describe("1 ページの取り込みのログを読む", () => {
  const url = `/api/crawls/${CRAWL}/pages/42/log`;
  /** 読めなかったときの答え。ページは一覧と同じ形。 */
  const unreadable = (reason: string, over: Record<string, unknown> = {}) => ({
    page: {
      id: "42",
      url: "https://site.test/",
      depth: 0,
      state: "captured",
      reason: null,
      taskId: TASK,
      archiveId: ARCHIVE,
      logCounts: { debug: 0, info: 12, warn: 1, error: 0, dropped: 0 },
      ...over,
    },
    log: null,
    reason,
  });

  it("ページはクロールとの組で引き、capture_submissions は task_id の uuid 側を text に倒して繋ぐ", async () => {
    const { queries } = await get(url, { results: [[row({ manifestKey: null })]] });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toBe(
      'select distinct on ("p"."id") "p"."id", "p"."url", "p"."depth", "p"."state", "p"."skip_reason", ' +
        '"p"."task_id", "p"."log_counts", "a"."id" as "archive_id", "s"."manifest_key" ' +
        'from "crawl_pages" as "p" ' +
        'left join "archives" as "a" on "p"."task_id" = "a"."task_id"::text ' +
        'left join "capture_submissions" as "s" on "p"."task_id" = "s"."task_id"::text ' +
        'where "p"."crawl_id" = $1 and "p"."id" = $2 order by "p"."id", "a"."created_at"',
    );
    expect(queries[0]?.parameters).toEqual([CRAWL, "42"]);
  });

  it("取り込みの答えが無いページは not-captured で、保管庫を読まない", async () => {
    const { res, read } = await get(url, {
      results: [
        [
          row({
            state: "pending",
            taskId: null,
            logCounts: null,
            archiveId: null,
            manifestKey: null,
          }),
        ],
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      unreadable("not-captured", {
        state: "pending",
        taskId: null,
        archiveId: null,
        logCounts: null,
      }),
    );
    expect(read).toEqual([]);
  });

  it("答えはあるが .result.json の場所が記録されていなければ no-manifest で、保管庫を読まない", async () => {
    const { res, read } = await get(url, { results: [[row({ manifestKey: null })]] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(unreadable("no-manifest"));
    expect(read).toEqual([]);
  });

  it("記録した場所に .result.json が無ければ manifest-missing（設定の bucket の、記録した鍵を読む）", async () => {
    const { res, read } = await get(url, { results: [[row({ manifestKey: KEY })]], store: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(unreadable("manifest-missing"));
    expect(read).toEqual([`b/${KEY}`]);
  });

  it("契約に合わない .result.json は manifest-invalid（JSON でない物も）", async () => {
    for (const stored of [{ ...manifest, status: "CAPTURE_STATUS_SUCCESS" }, "{ not json"]) {
      const { res } = await get(url, {
        results: [[row({ manifestKey: KEY })]],
        store: { [KEY]: stored },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(unreadable("manifest-invalid"));
    }
  });

  it("契約に合っても log の無い .result.json は no-log", async () => {
    const { res, read } = await get(url, {
      results: [[row({ manifestKey: KEY })]],
      store: { [KEY]: manifest },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(unreadable("no-log"));
    expect(read).toEqual([`b/${KEY}`]);
  });

  it("保管庫に届かなければ 502", async () => {
    const { res } = await get(url, {
      results: [[row({ manifestKey: KEY })]],
      store: { [KEY]: new Error("connect ECONNREFUSED 127.0.0.1:8333") },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "storage unreachable" });
  });

  it("無いページ（他のクロールのページも）は 404", async () => {
    const { res, read } = await get(url, { results: [[]] });
    expect(res.statusCode).toBe(404);
    expect(read).toEqual([]);
  });

  it("許可が無ければ 404 で、DB を引かない", async () => {
    const { res, queries } = await get(url, { allowed: false });
    expect(res.statusCode).toBe(404);
    expect(queries).toEqual([]);
  });

  it("ページの id が数字だけで 18 桁までの綴りでなければ 400 で、許可を見る前に断る", async () => {
    for (const page of ["abc", "-1", "1.5", "4%202", "9".repeat(19)]) {
      const { res, queries } = await get(`/api/crawls/${CRAWL}/pages/${page}/log`, {
        allowed: false,
      });
      expect(res.statusCode, page).toBe(400);
      expect(queries, page).toEqual([]);
    }
  });
});
