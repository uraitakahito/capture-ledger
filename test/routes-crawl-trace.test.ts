/**
 * 取り込み 1 回の経緯を読むエンドポイント (`GET /api/crawls/:id/pages/:page/trace`) と、失敗の時点の絵を返す
 * エンドポイント (`GET /api/crawls/:id/pages/:page/trace/failure-screenshot`)。
 *
 * ログのエンドポイントの試験 (`routes-crawl-pages.test.ts`) と同じ道具で見る: 本物の Kysely に SQL を組ませ、
 * 実行の直前で取り上げる代役 (`recording-db.ts`) と、読みに来た鍵を数える偽の保管庫。**SQL が Postgres で
 * 本当に通るかはここでは言えない。** 見るのは、組まれた SQL の形・答えの形・読めない理由・認可・400・502。
 *
 * 偽の保管庫は鍵だけで引き、bucket を見ない。**bucket を取り違えた読みは、`read` の字 (`bucket/鍵`) で見える** ——
 * 別の bucket を言う `.result.json` の試験は、同じ鍵に本物の絵を置いたうえで、読みに行かないことを見る。
 */
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
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

/** 失敗の時点の絵の鍵。`.result.json` の隣だが、エンドポイントは `.result.json` が言う場所を読む (組まない)。 */
const PICTURE_KEY = "elsewhere/x y+z.failure.webp";
const MIB = 1024 * 1024;

/**
 * 保管庫に置いた物。object は JSON にして返し、文字列と Buffer はそのまま返し、Error は投げる。無い鍵は NoSuchKey
 * (大きさを訊かれたら NotFound)。
 */
type Stored = object | string | Buffer | Error;

/** WebP の頭を持つ、`size` バイトの作り物。中身は絵として開けなくてよい (エンドポイントが見るのは頭と大きさ)。 */
const webp = (size = 64): Buffer => {
  const bytes = Buffer.alloc(size, 0x2a);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write("WEBP", 8, "latin1");
  return bytes;
};

interface Built {
  app: FastifyInstance;
  queries: RecordedQuery[];
  /** 保管庫から読みに来た `bucket/鍵`。 */
  read: string[];
  /** 保管庫に大きさを訊きに来た `bucket/鍵` (本文は読まない)。 */
  sized: string[];
  /** OpenFGA に訊いた relation と object。 */
  asked: string[];
}

const build = async (opts: {
  results?: readonly (readonly object[])[];
  /** クロールを頼めるか (`can_submit`)。省けば頼める */
  submit?: boolean;
  /** その WACZ を見てよいか (`can_view`)。省けば見てよい */
  view?: boolean;
  /** 呼び出し元の組織。省けば acme (取り込みを出した組織と同じ) */
  organizations?: string[];
  store?: Record<string, Stored>;
}): Promise<Built> => {
  const { db, queries } = recordingDb(opts.results);
  const read: string[] = [];
  const sized: string[] = [];
  const asked: string[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string } }) => {
      const head = command instanceof HeadObjectCommand;
      (head ? sized : read).push(`${command.input.Bucket}/${command.input.Key}`);
      const stored = opts.store?.[command.input.Key];
      if (stored === undefined) {
        // 本物の保管庫は、HEAD には本文の無い 404 (SDK の名前は NotFound)、GET には NoSuchKey で答える
        const missing = head
          ? Object.assign(new Error("NotFound"), {
              name: "NotFound",
              $metadata: { httpStatusCode: 404 },
            })
          : Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
        return Promise.reject(missing);
      }
      if (stored instanceof Error) return Promise.reject(stored);
      const body = Buffer.isBuffer(stored)
        ? stored
        : Buffer.from(typeof stored === "string" ? stored : JSON.stringify(stored));
      if (head) return Promise.resolve({ ContentLength: body.length });
      return Promise.resolve({
        Body: {
          transformToString: () => Promise.resolve(body.toString("utf8")),
          transformToByteArray: () => Promise.resolve(new Uint8Array(body)),
        },
      });
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
    resolveIdentity: () =>
      Promise.resolve({ subject: "alice", organizations: opts.organizations ?? ["acme"] }),
    s3,
    bucket: "b",
  } as unknown as TraceRouteDeps);
  await app.ready();
  return { app, queries, read, sized, asked };
};

const get = async (url: string, opts: Parameters<typeof build>[0] = {}) => {
  const built = await build(opts);
  const res = await built.app.inject({ method: "GET", url, headers: SUBJECT });
  await built.app.close();
  return {
    res,
    queries: built.queries,
    read: built.read,
    sized: built.sized,
    asked: built.asked,
  };
};

/** DB が返す行 (`pageRows` の select に、経緯のエンドポイントが足す欄を加えた形)。`orgId` は取り込みを出した組織。 */
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
  orgId: "acme",
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

/**
 * BrowserHive v30.0.0 の `.result.json` の `trace`。行の形は、本物の取り込み (e2e) の行を写した物 ——
 * 読み終えた行・終わりを観測できない行 (別サイトのフレームの文書)・方針で残さなかった行。
 */
const trace = {
  lines: [
    {
      kind: "request",
      id: "3246.2",
      hop: 0,
      dpr: 1,
      url: "https://site.test/slow-response?delayMs=1537",
      method: "GET",
      resourceType: "Fetch",
      initiator: { type: "script", url: "https://site.test/", line: 4 },
      startedAt: "2026-11-04T00:00:01.457Z",
      ms: 670,
      response: { status: 200, protocol: "http/1.1" },
      timing: { dnsMs: 0, connectMs: 0, tlsMs: 0, sendMs: 0, waitMs: 1546, receiveMs: 1 },
      durationMs: 1597,
      encodedBytes: 185,
      outcome: "finished",
      record: "urn:uuid:172f0c84-7c13-431e-92a7-2151d4525de2",
    },
    {
      kind: "request",
      id: "E058663D9B8F34876C0B61EE874AF177",
      hop: 0,
      dpr: 1,
      url: "https://other.test/frame",
      method: "GET",
      resourceType: "Document",
      initiator: { type: "parser", url: "https://site.test/", line: 3 },
      startedAt: "2026-11-04T00:00:01.093Z",
      ms: 334,
      response: { status: 200, protocol: "http/1.1" },
      outcome: "pending",
      endUnobservable: true,
    },
    {
      kind: "request",
      id: "3246.5",
      hop: 0,
      dpr: 1,
      url: "https://ads.test/pixel.gif",
      method: "GET",
      resourceType: "Image",
      startedAt: "2026-11-04T00:00:01.200Z",
      ms: 441,
      outcome: "not-archived",
    },
  ],
  counts: {
    finished: 1,
    redirected: 0,
    failed: 0,
    pending: 1,
    notArchived: 1,
    denied: 0,
    evicted: 0,
  },
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

/**
 * 文書が 404 だった取り込みの `.result.json` (BrowserHive v30.2.0。絵を撮る設定の配備)。WACZ は無く、
 * 失敗の時点の絵の場所を言う。
 */
const notFoundDocument = {
  taskId: TASK,
  url: "https://site.test/missing",
  labels: ["x y+z"],
  status: "http_error",
  timestamp: "2026-11-04T00:00:03.000Z",
  captureProcessingTimeMs: 2710,
  httpStatusCode: 404,
  errorDetails: { type: "http", message: "HTTP 404 Not Found", httpStatusCode: 404 },
  log,
  failureScreenshot: `s3://b/${PICTURE_KEY}`,
};

/** 節目のスクリーンショットの成り行き (BrowserHive v30.2.0)。残した時点と、残さなかった時点。 */
const screenshots = [
  {
    stage: "after-load",
    url: "urn:browserhive:screenshot:after-load:https://site.test/",
    date: "2026-11-04T00:00:04.120Z",
    record: "urn:uuid:5b0c3f0e-2f0f-4a43-9d58-5c2f4c1f7a10",
    bytes: 48213,
  },
  { stage: "after-behaviors", skipped: "task-budget" },
];

const url = `/api/crawls/${CRAWL}/pages/42/trace`;
const pictureUrl = `${url}/failure-screenshot`;

/** 絵のエンドポイントが引く行 (取り込みを出した組織と、`.result.json` の鍵)。 */
const pictureRow = (over: Record<string, unknown> = {}) => ({
  orgId: "acme",
  manifestKey: KEY,
  ...over,
});

describe("取り込み 1 回の経緯を読む", () => {
  it("trace を持たない .result.json（BrowserHive v30.0.0 より前）は、ページ・WACZ の在り処・取り込みの欄・ログを返し、trace は null", async () => {
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
        // 絵の成り行き (`screenshots`) は、無い取り込みでは鍵ごと無い。失敗の時点の絵は、無くても真偽で言う
        failureScreenshot: false,
      },
      log,
      trace: null,
      reason: null,
    });
    // 鍵は組まない。設定の bucket の、記録した鍵を 1 度だけ読む (ラベルが綴りに入っていても)
    expect(read).toEqual([`b/${KEY}`]);
  });

  it("trace を持つ .result.json（BrowserHive v30.0.0 から）なら、trace を書かれたまま返す", async () => {
    const { res } = await get(url, { results: [[row()]], store: { [KEY]: { ...success, trace } } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ trace: unknown; log: unknown; reason: unknown }>();
    // 行の欄を選び直さない。無い欄は、鍵ごと無いまま
    expect(body.trace).toEqual(trace);
    expect(body.log).toEqual(log);
    expect(body.reason).toBeNull();
  });

  it("時間切れの取り込みも、trace が在れば返す（WACZ は無く、行はレコードを名指さない）", async () => {
    const pending = {
      lines: [
        {
          kind: "request",
          id: "A1",
          hop: 0,
          url: "https://site.test/slow",
          method: "GET",
          resourceType: "Document",
          startedAt: "2026-11-04T00:00:00.500Z",
          ms: 12,
          outcome: "pending",
        },
      ],
      counts: {
        finished: 0,
        redirected: 0,
        failed: 0,
        pending: 1,
        notArchived: 0,
        denied: 0,
        evicted: 0,
      },
      dropped: 0,
    };
    const { res } = await get(url, {
      results: [[row({ archiveId: null, objectKey: null, capturedAt: null, bundledRev: null })]],
      store: { [KEY]: { ...timedOut, trace: pending } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ archive: null, trace: pending, reason: null });
  });

  it("trace の行の outcome が契約に無い綴りなら、読めない物として答える（manifest-invalid）", async () => {
    const odd = { ...trace, lines: [{ ...trace.lines[0], outcome: "half-done" }] };
    const { res } = await get(url, {
      results: [[row()]],
      store: { [KEY]: { ...success, trace: odd } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      capture: null,
      log: null,
      trace: null,
      reason: "manifest-invalid",
    });
  });

  it("節目のスクリーンショットの成り行き（BrowserHive v30.2.0 から）を、書かれたまま返す", async () => {
    const { res } = await get(url, {
      results: [[row()]],
      store: { [KEY]: { ...success, screenshots } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ capture: { screenshots: unknown; failureScreenshot: unknown } }>();
    // 項目の欄を選び直さない。残さなかった時点は、理由だけを持つ
    expect(body.capture.screenshots).toEqual(screenshots);
    expect(body.capture.failureScreenshot).toBe(false);
  });

  it("乱数の控えの要約（BrowserHive v31.1.0 から）を、書かれたまま返す。無い取り込みでは鍵ごと無い", async () => {
    const random = { recorded: true, documents: 2, draws: 731, truncated: false };
    const recorded = await get(url, {
      results: [[row()]],
      store: { [KEY]: { ...success, random } },
    });
    expect(recorded.res.statusCode).toBe(200);
    expect(recorded.res.json<{ capture: { random: unknown } }>().capture.random).toEqual(random);

    const skipped = await get(url, {
      results: [[row()]],
      store: { [KEY]: { ...success, random: { recorded: false, skipped: "not-requested" } } },
    });
    expect(skipped.res.json<{ capture: { random: unknown } }>().capture.random).toEqual({
      recorded: false,
      skipped: "not-requested",
    });

    const absent = await get(url, { results: [[row()]], store: { [KEY]: success } });
    expect(absent.res.json<{ capture: Record<string, unknown> }>().capture).not.toHaveProperty(
      "random",
    );
  });

  it("失敗の時点の絵は、在るかどうかだけを真偽で返し、保管庫の場所を返さない", async () => {
    const { res, read, sized } = await get(url, {
      results: [
        [
          row({
            state: "failed",
            archiveId: null,
            capturedAt: null,
            bundledRev: null,
            objectKey: null,
          }),
        ],
      ],
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: webp() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ capture: Record<string, unknown> }>();
    expect(body.capture["failureScreenshot"]).toBe(true);
    // 成功でない取り込みに、節目の絵の成り行きは無い
    expect(body.capture).not.toHaveProperty("screenshots");
    // 答えのどこにも、場所 (bucket と鍵) が出ない
    expect(res.body).not.toContain("s3://");
    expect(res.body).not.toContain(PICTURE_KEY);
    // 経緯のエンドポイントは、絵を読みにも、大きさを訊きにも行かない
    expect(read).toEqual([`b/${KEY}`]);
    expect(sized).toEqual([]);
  });

  it("失敗の時点の絵の真偽は、取り込みを出した組織に属する呼び出し元にだけ true（別の組織には false で、経緯は見える）", async () => {
    // 同じ取り込み (acme が出した)・同じ .result.json。変えるのは呼び出し元の組織だけ
    const failedRow = row({
      state: "failed",
      archiveId: null,
      capturedAt: null,
      bundledRev: null,
      objectKey: null,
    });
    const store = { [KEY]: notFoundDocument, [PICTURE_KEY]: webp() };
    interface Body {
      capture: { status: string; failureScreenshot: unknown };
      log: unknown;
    }

    const member = await get(url, { results: [[failedRow]], store, organizations: ["acme"] });
    expect(member.res.json<Body>().capture.failureScreenshot).toBe(true);
    // 2 つ目の組織として属していても同じ
    const second = await get(url, {
      results: [[failedRow]],
      store,
      organizations: ["globex", "acme"],
    });
    expect(second.res.json<Body>().capture.failureScreenshot).toBe(true);

    const outsider = await get(url, { results: [[failedRow]], store, organizations: ["globex"] });
    expect(outsider.res.statusCode).toBe(200);
    const body = outsider.res.json<Body>();
    expect(body.capture.failureScreenshot).toBe(false);
    // 経緯そのものは、今までどおり見える (can_submit の線)
    expect(body.capture.status).toBe("http_error");
    expect(body.log).toEqual(log);
    // 組織は capture_submissions の行から引いている
    expect(outsider.queries[0]?.sql).toContain('"s"."org_id"');
  });

  it("失敗の時点の絵が、設定の bucket の外や s3:// でない場所なら、無いと答える", async () => {
    for (const location of [`s3://elsewhere/${PICTURE_KEY}`, `https://store.test/${PICTURE_KEY}`]) {
      const { res } = await get(url, {
        results: [[row()]],
        store: { [KEY]: { ...notFoundDocument, failureScreenshot: location } },
      });
      const body = res.json<{ capture: { failureScreenshot: unknown } }>();
      expect(body.capture.failureScreenshot, location).toBe(false);
      expect(res.body, location).not.toContain(PICTURE_KEY);
    }
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
      failureScreenshot: false,
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

describe("失敗の時点の絵を返す", () => {
  it("絵を、JSON の中の base64 で返す（読むのは .result.json が言う鍵。大きさを訊いてから読む）", async () => {
    const picture = webp(4096);
    const { res, read, sized } = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: picture },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ contentType: string; base64: string }>();
    expect(Object.keys(body).sort()).toEqual(["base64", "contentType"]);
    expect(body.contentType).toBe("image/webp");
    expect(Buffer.from(body.base64, "base64").equals(picture)).toBe(true);
    // 設定の bucket の、.result.json と、それが言った鍵だけ
    expect(read).toEqual([`b/${KEY}`, `b/${PICTURE_KEY}`]);
    expect(sized).toEqual([`b/${PICTURE_KEY}`]);
  });

  it("取り込みを出した組織は capture_submissions から引く（ページはクロールとの組で、task_id の uuid 側を text に倒して繋ぐ）", async () => {
    const { queries } = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: webp() },
    });
    expect(queries).toHaveLength(1);
    const query = queries[0];
    expect(query?.sql).toContain('inner join "capture_submissions" as "s"');
    expect(query?.sql).toContain('"s"."task_id"::text');
    expect(query?.sql).toContain('"s"."org_id"');
    expect(query?.sql).toContain('"p"."crawl_id" = ');
    expect(query?.parameters).toEqual([CRAWL, "42"]);
  });

  it("クロールを頼めない名乗りは 404 で、DB を引かない", async () => {
    const { res, queries, read } = await get(pictureUrl, {
      results: [[pictureRow()]],
      submit: false,
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: webp() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(queries).toHaveLength(0);
    expect(read).toEqual([]);
  });

  it("別の組織が出した取り込みの絵は 404 で、保管庫を読まない（クロールを頼める名乗りでも）", async () => {
    const { res, read, sized } = await get(pictureUrl, {
      results: [[pictureRow()]],
      organizations: ["globex"],
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: webp() },
    });
    expect(res.statusCode).toBe(404);
    // 無いページと同じ答え (在るが見せない、を言わない)
    expect(res.json()).toEqual({ error: "not found" });
    expect(read).toEqual([]);
    expect(sized).toEqual([]);
  });

  it(".result.json が別の bucket を指していたら 404 で、絵を読みに行かない（設定の bucket の同じ鍵に絵が在っても）", async () => {
    const { res, read, sized } = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: {
        [KEY]: { ...notFoundDocument, failureScreenshot: `s3://elsewhere/${PICTURE_KEY}` },
        [PICTURE_KEY]: webp(),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(read).toEqual([`b/${KEY}`]);
    expect(sized).toEqual([]);
  });

  it("s3:// でない場所も 404 で、絵を読みに行かない", async () => {
    const { res, read } = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: {
        [KEY]: { ...notFoundDocument, failureScreenshot: `https://store.test/${PICTURE_KEY}` },
        [PICTURE_KEY]: webp(),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(read).toEqual([`b/${KEY}`]);
  });

  it("1 MiB を超える物は 502 で断り、本文を読まない（ちょうど 1 MiB は返す）", async () => {
    const over = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: webp(MIB + 1) },
    });
    expect(over.res.statusCode).toBe(502);
    expect(over.res.json()).toEqual({ error: "failure screenshot too large" });
    // 大きさは訊いたが、絵の本文は読んでいない
    expect(over.sized).toEqual([`b/${PICTURE_KEY}`]);
    expect(over.read).toEqual([`b/${KEY}`]);

    const exact = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: webp(MIB) },
    });
    expect(exact.res.statusCode).toBe(200);
    expect(Buffer.from(exact.res.json<{ base64: string }>().base64, "base64")).toHaveLength(MIB);
  });

  it("WebP の頭を持たない物は 502 で、中身を返さない（PNG・別の取り込みの .result.json・頭だけの切れ端）", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(56),
    ]);
    // RIFF の入れ物でも、WEBP でない物 (WAV) は絵ではない
    const wav = webp();
    wav.write("WAVE", 8, "latin1");
    const others: Stored[] = [png, success, wav, Buffer.from("RIFF")];
    for (const other of others) {
      const { res } = await get(pictureUrl, {
        results: [[pictureRow()]],
        store: { [KEY]: notFoundDocument, [PICTURE_KEY]: other },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: "failure screenshot is not a WebP image" });
    }
  });

  it("絵の無い取り込みは 404（絵を言わない .result.json・成功した取り込み）で、保管庫に絵を訊かない", async () => {
    for (const manifest of [timedOut, success]) {
      const { res, read, sized } = await get(pictureUrl, {
        results: [[pictureRow()]],
        store: { [KEY]: manifest, [PICTURE_KEY]: webp() },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
      expect(read).toEqual([`b/${KEY}`]);
      expect(sized).toEqual([]);
    }
  });

  it("無いページ・取り込みの答えの無いページ（行が出ない）は 404 で、保管庫を読まない", async () => {
    const { res, read } = await get(pictureUrl, { results: [[]] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(read).toEqual([]);
  });

  it(".result.json の場所が記録されていない・保管庫に無い・契約に合わない取り込みは 404", async () => {
    const noKey = await get(pictureUrl, { results: [[pictureRow({ manifestKey: null })]] });
    expect(noKey.res.statusCode).toBe(404);
    expect(noKey.read).toEqual([]);
    const missing = await get(pictureUrl, { results: [[pictureRow()]], store: {} });
    expect(missing.res.statusCode).toBe(404);
    const invalid = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: { [KEY]: { status: "CAPTURE_STATUS_FAILED" }, [PICTURE_KEY]: webp() },
    });
    expect(invalid.res.statusCode).toBe(404);
    expect(invalid.read).toEqual([`b/${KEY}`]);
  });

  it(".result.json が言う場所に絵が無ければ 404", async () => {
    const { res, read, sized } = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: { [KEY]: notFoundDocument },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    // 大きさを訊いて無いと分かれば、本文は読みに行かない
    expect(sized).toEqual([`b/${PICTURE_KEY}`]);
    expect(read).toEqual([`b/${KEY}`]);
  });

  it("保管庫に届かなければ 502（.result.json を読むときも、絵を読むときも）", async () => {
    const down = new Error("connect ECONNREFUSED");
    const manifest = await get(pictureUrl, { results: [[pictureRow()]], store: { [KEY]: down } });
    expect(manifest.res.statusCode).toBe(502);
    expect(manifest.res.json()).toEqual({ error: "storage unreachable" });
    const picture = await get(pictureUrl, {
      results: [[pictureRow()]],
      store: { [KEY]: notFoundDocument, [PICTURE_KEY]: down },
    });
    expect(picture.res.statusCode).toBe(502);
    expect(picture.res.json()).toEqual({ error: "storage unreachable" });
  });

  it("ページの id が数字だけで 18 桁までの綴りでなければ 400 で、DB を引かない", async () => {
    for (const bad of ["abc", "1234567890123456789", "4.2"]) {
      const { res, queries } = await get(
        `/api/crawls/${CRAWL}/pages/${bad}/trace/failure-screenshot`,
        {},
      );
      expect(res.statusCode, bad).toBe(400);
      expect(queries).toHaveLength(0);
    }
    const { res } = await get("/api/crawls/not-a-uuid/pages/42/trace/failure-screenshot", {});
    expect(res.statusCode).toBe(400);
  });
});
