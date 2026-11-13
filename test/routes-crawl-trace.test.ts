/**
 * 取り込み 1 回の経緯を読むエンドポイント (`GET /api/crawls/:id/pages/:page/trace`)。
 *
 * ログのエンドポイントの試験 (`routes-crawl-pages.test.ts`) と同じ道具で見る: 本物の Kysely に SQL を組ませ、
 * 実行の直前で取り上げる代役 (`recording-db.ts`) と、読みに来た鍵を数える偽の保管庫。**SQL が Postgres で
 * 本当に通るかはここでは言えない。** 見るのは、組まれた SQL の形・答えの形・読めない理由・認可・400・502。
 */
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerTraceRoutes, type TraceRouteDeps } from "../src/api/trace.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const TASK = "550e8400-e29b-41d4-a716-446655440000";
const ARCHIVE = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const CAPTURED_AT = "2026-11-04T00:00:00.000Z";
const SUBMITTED_AT = "2026-11-03T23:59:50.000Z";
const FINISHED_AT = "2026-11-04T00:00:01.000Z";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
/**
 * 報告が運んだ鍵。ラベル付きの取り込みの鍵は、ラベルが綴りに入る —— `taskId` から組み直す実装なら、
 * 別の鍵を読みに行く (BrowserHive の命名規則では作れない綴りにしてある)。
 */
const KEY = "elsewhere/x y+z.result.json";
const WACZ_KEY = "elsewhere/x y+z.wacz";

/** 保管庫に置いた物。object は JSON にして返し、文字列はそのまま返し、Error は投げる。無い鍵は NoSuchKey。 */
type Stored = object | string | Error;

interface Built {
  app: FastifyInstance;
  queries: RecordedQuery[];
  /** 保管庫から読みに来た `bucket/鍵`。 */
  read: string[];
  /** OpenFGA に訊いた relation と object。 */
  asked: string[];
}

const build = async (opts: {
  results?: readonly (readonly object[])[];
  /** クロールを頼めるか (`can_submit`)。省けば頼める */
  submit?: boolean;
  /** その WACZ を見てよいか (`can_view`)。省けば見てよい */
  view?: boolean;
  store?: Record<string, Stored>;
}): Promise<Built> => {
  const { db, queries } = recordingDb(opts.results);
  const read: string[] = [];
  const asked: string[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string } }) => {
      read.push(`${command.input.Bucket}/${command.input.Key}`);
      const stored = opts.store?.[command.input.Key];
      if (stored === undefined) {
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
  registerTraceRoutes(app, {
    db,
    fga: {
      check: (request: { relation: string; object: string }) => {
        asked.push(`${request.relation} ${request.object}`);
        const allowed =
          request.relation === "can_view" ? (opts.view ?? true) : (opts.submit ?? true);
        return Promise.resolve({ allowed });
      },
    },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    s3,
    bucket: "b",
  } as unknown as TraceRouteDeps);
  await app.ready();
  return { app, queries, read, asked };
};

const get = async (url: string, opts: Parameters<typeof build>[0] = {}) => {
  const built = await build(opts);
  const res = await built.app.inject({ method: "GET", url, headers: SUBJECT });
  await built.app.close();
  return { res, queries: built.queries, read: built.read, asked: built.asked };
};

/** DB が返す行 (`pageRows` の select に、経緯のエンドポイントが足す 4 欄を加えた形)。 */
const row = (over: Record<string, unknown> = {}) => ({
  id: "42",
  url: "https://site.test/",
  depth: 0,
  state: "captured",
  skipReason: null,
  taskId: TASK,
  logCounts: { debug: 3, info: 12, warn: 1, error: 0, dropped: 0 },
  archiveId: ARCHIVE,
  capturedAt: new Date(CAPTURED_AT),
  bundledRev: 2,
  manifestKey: KEY,
  submittedAt: new Date(SUBMITTED_AT),
  finishedAt: new Date(FINISHED_AT),
  objectKey: WACZ_KEY,
  ...over,
});

/** ページの行の答え (`pageOf` に、flow が測った投入と完了を足した形)。 */
const page = (over: Record<string, unknown> = {}) => ({
  id: "42",
  url: "https://site.test/",
  depth: 0,
  state: "captured",
  reason: null,
  taskId: TASK,
  archiveId: ARCHIVE,
  capturedAt: CAPTURED_AT,
  bundledRev: 2,
  logCounts: { debug: 3, info: 12, warn: 1, error: 0, dropped: 0 },
  submittedAt: SUBMITTED_AT,
  finishedAt: FINISHED_AT,
  ...over,
});

/** 待ちの内訳。BrowserHive が成功の取り込みに書く (`settle`)。 */
const settle = {
  strategy: "quiet",
  endedBy: "deadline",
  waitedMs: 3105,
  devicePixelRatio: 1,
  limits: { minMs: 500, maxMs: 3000, quietMs: 500, networkConcurrency: 0 },
  network: {},
  dom: { quietAtMs: 812 },
  load: { atMs: 412 },
  cpu: { quietAtMs: 640 },
};

const log = {
  lines: [
    {
      at: "2026-11-04T00:00:00.221Z",
      ms: 221,
      source: "browserhive",
      level: "info",
      msg: "step connect",
      data: { step: "connect" },
    },
    { at: "2026-11-04T00:00:09.585Z", ms: 9585, source: "page", level: "error", msg: "Uncaught" },
  ],
  counts: { debug: 0, info: 1, warn: 0, error: 1 },
  dropped: 0,
};

/** 成功した取り込みの `.result.json`。 */
const success = {
  taskId: TASK,
  url: "https://site.test/",
  labels: ["x y+z"],
  status: "success",
  timestamp: "2026-11-04T00:00:10.000Z",
  captureProcessingTimeMs: 9834,
  httpStatusCode: 200,
  artifacts: { wacz: "s3://b/elsewhere/x y+z.wacz" },
  settle,
  log,
};

/** 読み込みが時間切れになった取り込みの `.result.json` (WACZ も `settle` も無い)。 */
const timedOut = {
  taskId: TASK,
  url: "https://site.test/slow",
  labels: [],
  status: "timeout",
  timestamp: "2026-11-04T00:00:31.000Z",
  captureProcessingTimeMs: 30412,
  errorDetails: {
    type: "timeout",
    message: "Navigation timeout of 30000 ms exceeded",
    step: "load-pages",
  },
  log,
};

const url = `/api/crawls/${CRAWL}/pages/42/trace`;

describe("取り込み 1 回の経緯を読む", () => {
  it("成功した取り込みは、ページ・WACZ の在り処・取り込みの欄・ログを返す（trace と reason は null）", async () => {
    const { res, read } = await get(url, { results: [[row()]], store: { [KEY]: success } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      page: page(),
      archive: { id: ARCHIVE, objectKey: WACZ_KEY },
      capture: {
        status: "success",
        timestamp: "2026-11-04T00:00:10.000Z",
        captureProcessingTimeMs: 9834,
        httpStatusCode: 200,
        // 下位の object は書かれたまま (中の欄を選び直さない)
        settle,
      },
      log,
      trace: null,
      reason: null,
    });
    // 鍵は組まない。設定の bucket の、記録した鍵を 1 度だけ読む (ラベルが綴りに入っていても)
    expect(read).toEqual([`b/${KEY}`]);
  });

  it("ページはクロールとの組で引き、capture_submissions は task_id の uuid 側を text に倒して繋ぐ", async () => {
    const { queries } = await get(url, { results: [[row()]], store: { [KEY]: success } });
    const query = queries[0];
    expect(query?.sql).toContain('"capture_submissions" as "s"');
    expect(query?.sql).toContain('"s"."task_id"::text');
    // flow が測った投入と完了・WACZ の鍵を、同じ 1 本で引く
    expect(query?.sql).toContain('"p"."submitted_at"');
    expect(query?.sql).toContain('"p"."finished_at"');
    expect(query?.sql).toContain('"a"."object_key"');
    expect(query?.parameters).toEqual(expect.arrayContaining([CRAWL, "42"]));
    expect(queries).toHaveLength(1);
  });

  it("時間切れの取り込みは、止まった段とログを返し、WACZ の在り処と settle は無い", async () => {
    const { res } = await get(url, {
      results: [
        [
          row({
            state: "failed",
            skipReason: "timeout",
            archiveId: null,
            capturedAt: null,
            bundledRev: null,
            objectKey: null,
          }),
        ],
      ],
      store: { [KEY]: timedOut },
    });
    const body = res.json<{ archive: unknown; capture: Record<string, unknown>; log: unknown }>();
    expect(body.archive).toBeNull();
    expect(body.capture).toEqual({
      status: "timeout",
      timestamp: "2026-11-04T00:00:31.000Z",
      captureProcessingTimeMs: 30412,
      errorDetails: timedOut.errorDetails,
    });
    expect(body.log).toEqual(log);
  });

  it("log の無い .result.json（BrowserHive v24.0.0 より前）でも、取り込みの欄は返す（log は null・reason も null）", async () => {
    const withoutLog: Record<string, unknown> = { ...success };
    delete withoutLog["log"];
    const { res } = await get(url, { results: [[row()]], store: { [KEY]: withoutLog } });
    const body = res.json<{ capture: { status: string } | null; log: unknown; reason: unknown }>();
    expect(body.capture?.status).toBe("success");
    expect(body.log).toBeNull();
    expect(body.reason).toBeNull();
  });

  it("見てよくない WACZ は、id だけを返し、鍵は返さない", async () => {
    const { res, asked } = await get(url, {
      results: [[row()]],
      view: false,
      store: { [KEY]: success },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ archive: unknown }>().archive).toEqual({ id: ARCHIVE, objectKey: null });
    // その WACZ について can_view を訊いている
    expect(asked).toContain(`can_view archive:${ARCHIVE}`);
  });

  it("取り込みの答えが無いページは not-captured で、保管庫を読まない", async () => {
    const { res, read } = await get(url, {
      results: [
        [
          row({
            state: "pending",
            taskId: null,
            manifestKey: null,
            archiveId: null,
            capturedAt: null,
            bundledRev: null,
            objectKey: null,
            logCounts: null,
            submittedAt: null,
            finishedAt: null,
          }),
        ],
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      archive: null,
      capture: null,
      log: null,
      trace: null,
      reason: "not-captured",
    });
    expect(read).toEqual([]);
  });

  it("答えはあるが .result.json の場所が記録されていなければ no-manifest で、保管庫を読まない", async () => {
    const { res, read } = await get(url, { results: [[row({ manifestKey: null })]] });
    expect(res.json<{ reason: string }>().reason).toBe("no-manifest");
    expect(read).toEqual([]);
  });

  it("記録した場所に .result.json が無ければ manifest-missing", async () => {
    const { res, read } = await get(url, { results: [[row()]], store: {} });
    expect(res.json<{ reason: string }>().reason).toBe("manifest-missing");
    expect(read).toEqual([`b/${KEY}`]);
  });

  it("契約に合わない .result.json は manifest-invalid（JSON でない物も）", async () => {
    const wrong = await get(url, {
      results: [[row()]],
      store: { [KEY]: { status: "CAPTURE_STATUS_SUCCESS" } },
    });
    expect(wrong.res.json<{ reason: string }>().reason).toBe("manifest-invalid");
    const notJson = await get(url, { results: [[row()]], store: { [KEY]: "<html>" } });
    expect(notJson.res.json<{ reason: string }>().reason).toBe("manifest-invalid");
  });

  it("保管庫に届かなければ 502", async () => {
    const { res } = await get(url, {
      results: [[row()]],
      store: { [KEY]: new Error("connect ECONNREFUSED") },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "storage unreachable" });
  });

  it("無いページ（他のクロールのページも）は 404", async () => {
    const { res } = await get(url, { results: [[]] });
    expect(res.statusCode).toBe(404);
  });

  it("クロールを頼めない名乗りは 404 で、DB を引かない", async () => {
    const { res, queries } = await get(url, { results: [[row()]], submit: false });
    expect(res.statusCode).toBe(404);
    expect(queries).toHaveLength(0);
  });

  it("ページの id が数字だけで 18 桁までの綴りでなければ 400 で、DB を引かない", async () => {
    for (const bad of ["abc", "1234567890123456789", "4.2"]) {
      const { res, queries } = await get(`/api/crawls/${CRAWL}/pages/${bad}/trace`, {});
      expect(res.statusCode, bad).toBe(400);
      expect(queries).toHaveLength(0);
    }
    const { res } = await get("/api/crawls/not-a-uuid/pages/42/trace", {});
    expect(res.statusCode).toBe(400);
  });
});
