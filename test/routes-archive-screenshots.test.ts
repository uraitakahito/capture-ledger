/**
 * 節目のスクリーンショットを返すエンドポイント (`GET /api/archives/:id/screenshots/:stage`) と、アーカイブの一覧の
 * 行の `screenshot` (CAPTURE-432)。
 *
 * WACZ は BrowserHive と同じ形に組み (`stage-screenshot-wacz.ts`)、位置は検める時と同じ関数で求める。DB は組まれた
 * SQL を記録する代役 (`recording-db.ts`)、保管庫は Range を記録して**その範囲ちょうど**を返す偽物、OpenFGA は訊いた
 * 内容を記録する偽物。
 */
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyError } from "fastify";
import { registerRoutes, type RouteDeps } from "../src/api/routes.js";
import { locateStageScreenshots } from "../src/archive/stage-screenshots.js";
import { recordingDb } from "./recording-db.js";
import { screenshotWacz, webpBytes, type Shot } from "./stage-screenshot-wacz.js";

const ARCHIVE = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const KEY = "task_crawl.browserhive.wacz";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const load: Shot = {
  stage: "after-load",
  documentUrl: "http://site.test/a",
  date: "2026-11-15T01:00:00.100Z",
  record: "urn:uuid:11111111-1111-4111-8111-111111111111",
  picture: webpBytes("L"),
};
const behaviors: Shot = {
  stage: "after-behaviors",
  documentUrl: "http://site.test/a",
  date: "2026-11-15T01:00:05.300Z",
  record: "urn:uuid:22222222-2222-4222-8222-222222222222",
  picture: webpBytes("B", 80),
};
const ZIP = screenshotWacz([load, behaviors]);

/** DB が返す行 (エンドポイントの select の形)。位置は検める時と同じ関数で求めた物。 */
const placeOf = async (stage: string) => {
  const rows = await locateStageScreenshots(ZIP);
  const row = rows?.find((r) => r.stage === stage);
  if (row?.kind !== "located") throw new Error(`not located: ${stage}`);
  return {
    bucket: "browserhive",
    objectKey: KEY,
    waczOffset: String(row.waczOffset), // bigint は node-pg が文字列で返す
    waczLength: row.waczLength,
    bytes: row.bytes,
    recordId: row.recordId,
  };
};

const build = async (opts: {
  results?: readonly (readonly object[])[];
  view?: boolean;
  store?: Record<string, Buffer | Error>;
  signedIn?: boolean;
}) => {
  const { db, queries } = recordingDb(opts.results);
  const ranges: string[] = [];
  const asked: { relation: string; object: string; consistency: unknown }[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string; Range?: string } }) => {
      const { Bucket, Key, Range } = command.input;
      ranges.push(`${Bucket}/${Key} ${Range ?? "(whole)"}`);
      const stored = opts.store?.[`${Bucket}/${Key}`];
      if (stored === undefined) {
        return Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
      }
      if (stored instanceof Error) return Promise.reject(stored);
      const m = /^bytes=(\d+)-(\d+)$/.exec(Range ?? "");
      const bytes = m === null ? stored : stored.subarray(Number(m[1]), Number(m[2]) + 1);
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)) },
      });
    },
  };
  const fga = {
    check: (body: { relation: string; object: string }, options?: { consistency?: unknown }) => {
      asked.push({
        relation: body.relation,
        object: body.object,
        consistency: options?.consistency,
      });
      return Promise.resolve({ allowed: opts.view ?? true });
    },
    batchCheck: (req: { checks: { object: string }[] }) =>
      Promise.resolve({
        result: req.checks.map((c) => ({
          allowed: opts.view ?? true,
          request: { object: c.object },
        })),
      }),
  };
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
    return reply.code(500).send({ error: "internal error", message: error.message });
  });
  registerRoutes(app, {
    db,
    fga,
    s3,
    resolveIdentity: () =>
      Promise.resolve(
        opts.signedIn === false ? undefined : { subject: "alice", organizations: ["acme"] },
      ),
  } as unknown as RouteDeps);
  await app.ready();
  return { app, queries, ranges, asked };
};

const get = async (url: string, opts: Parameters<typeof build>[0] = {}) => {
  const built = await build(opts);
  const res = await built.app.inject({ method: "GET", url, headers: SUBJECT });
  await built.app.close();
  return { res, queries: built.queries, ranges: built.ranges, asked: built.asked };
};

const shotUrl = (stage = "after-load", id = ARCHIVE) => `/api/archives/${id}/screenshots/${stage}`;

describe("節目のスクリーンショットを返す", () => {
  it("絵の本文を image/webp で返し、nosniff と sandbox と private immutable を付ける（保管庫は Range 1 本）", async () => {
    const place = await placeOf("after-load");
    const { res, ranges } = await get(shotUrl(), {
      results: [[place]],
      store: { [`browserhive/${KEY}`]: ZIP },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.headers["cache-control"]).toBe("private, max-age=300, immutable");
    expect(res.rawPayload.equals(load.picture)).toBe(true);
    const start = Number(place.waczOffset);
    expect(ranges).toEqual([
      `browserhive/${KEY} bytes=${String(start)}-${String(start + place.waczLength - 1)}`,
    ]);
  });

  it("見てよくなければ 404 で、DB も保管庫も読まない", async () => {
    const { res, queries, ranges } = await get(shotUrl(), {
      view: false,
      store: { [`browserhive/${KEY}`]: ZIP },
    });
    expect(res.statusCode).toBe(404);
    expect(queries).toEqual([]);
    expect(ranges).toEqual([]);
  });

  it("can_view を、その archive について強一貫で訊く", async () => {
    const { asked } = await get(shotUrl(), { results: [[]] });
    expect(asked).toEqual([
      { relation: "can_view", object: `archive:${ARCHIVE}`, consistency: "HIGHER_CONSISTENCY" },
    ]);
  });

  it("名乗りが無ければ 401", async () => {
    expect((await get(shotUrl(), { signedIn: false })).res.statusCode).toBe(401);
  });

  it("行が無ければ 404 で、保管庫を読まない", async () => {
    const { res, ranges } = await get(shotUrl(), { results: [[]] });
    expect(res.statusCode).toBe(404);
    expect(ranges).toEqual([]);
  });

  it("残さなかった・位置を引けなかった行（位置が NULL）は 404 で、保管庫を読まない", async () => {
    const empty = {
      bucket: "browserhive",
      objectKey: KEY,
      waczOffset: null,
      waczLength: null,
      bytes: null,
      recordId: null,
    };
    const { res, ranges } = await get(shotUrl(), { results: [[empty]] });
    expect(res.statusCode).toBe(404);
    expect(ranges).toEqual([]);
  });

  it("時点は SQL の条件に入る", async () => {
    const { queries } = await get(shotUrl("after-behaviors"), { results: [[]] });
    expect(queries[0]?.sql).toBe(
      'select "a"."bucket", "a"."object_key", "sh"."wacz_offset", "sh"."wacz_length", "sh"."bytes", "sh"."record_id" ' +
        'from "archive_screenshots" as "sh" inner join "archives" as "a" on "a"."id" = "sh"."archive_id" ' +
        'where "sh"."archive_id" = $1 and "sh"."stage" = $2',
    );
    expect(queries[0]?.parameters).toEqual([ARCHIVE, "after-behaviors"]);
  });

  it("位置が別の時点のレコードを指していたら 502（間違った絵を返さない）", async () => {
    const { res } = await get(shotUrl("after-behaviors"), {
      results: [[await placeOf("after-load")]],
      store: { [`browserhive/${KEY}`]: ZIP },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "screenshot record unreadable" });
  });

  it("WACZ が保管庫に無ければ 404", async () => {
    const { res } = await get(shotUrl(), { results: [[await placeOf("after-load")]], store: {} });
    expect(res.statusCode).toBe(404);
  });

  it("保管庫に届かなければ 502", async () => {
    const { res } = await get(shotUrl(), {
      results: [[await placeOf("after-load")]],
      store: { [`browserhive/${KEY}`]: new Error("connect ECONNREFUSED 127.0.0.1:8333") },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "storage unreachable" });
  });

  it("上限より大きい行は、保管庫を読まずに 502", async () => {
    const { res, ranges } = await get(shotUrl(), {
      results: [[{ ...(await placeOf("after-load")), waczLength: 4 * 1024 * 1024 }]],
      store: { [`browserhive/${KEY}`]: ZIP },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "screenshot too large" });
    expect(ranges).toEqual([]);
  });
});

describe("アーカイブの一覧の行は、読み込みの後の絵の手がかりを持つ", () => {
  const base = {
    taskId: "550e8400-e29b-41d4-a716-446655440000",
    sourceUrl: "http://site.test/",
    labels: [],
    waczComplete: true,
    capturedAt: new Date("2026-11-15T01:00:00.000Z"),
    objectKey: KEY,
  };
  const none = { shotStage: null, shotSkipped: null, shotBytes: null, shotProblem: null };
  const ids = [
    "a0000000-0000-4000-8000-000000000001",
    "a0000000-0000-4000-8000-000000000002",
    "a0000000-0000-4000-8000-000000000003",
    "a0000000-0000-4000-8000-000000000004",
  ];

  it("絵が在る・残さなかった・位置を引けなかった・記録が無い の 4 つの形で返し、join の列は答えに漏らさない", async () => {
    const { res, queries } = await get("/api/archives", {
      results: [
        [
          { ...base, id: ids[0], ...none, shotStage: "after-load", shotBytes: 47692 },
          { ...base, id: ids[1], ...none, shotStage: "after-load", shotSkipped: "withheld" },
          { ...base, id: ids[2], ...none, shotStage: "after-load", shotProblem: "no-index-line" },
          { ...base, id: ids[3], ...none },
        ],
      ],
    });
    expect(res.statusCode).toBe(200);
    const { archives } = res.json<{ archives: Record<string, unknown>[] }>();
    expect(archives.map((a) => a["screenshot"])).toEqual([
      { stage: "after-load", bytes: 47692 },
      { stage: "after-load", skipped: "withheld" },
      { stage: "after-load", problem: "no-index-line" },
      null,
    ]);
    expect(Object.keys(archives[0] ?? {})).toEqual([
      "id",
      "taskId",
      "sourceUrl",
      "labels",
      "waczComplete",
      "capturedAt",
      "objectKey",
      "screenshot",
    ]);
    expect(queries[0]?.sql).toBe(
      'select "archives"."id", "archives"."task_id", "archives"."source_url", "archives"."labels", ' +
        '"archives"."wacz_complete", "archives"."captured_at", "archives"."object_key", ' +
        '"sh"."stage" as "shot_stage", "sh"."skipped" as "shot_skipped", "sh"."bytes" as "shot_bytes", ' +
        '"sh"."problem" as "shot_problem" from "archives" ' +
        'left join "archive_screenshots" as "sh" on "sh"."archive_id" = "archives"."id" and "sh"."stage" = \'after-load\' ' +
        'order by "archives"."captured_at" desc limit $1',
    );
  });

  it("見てよくない行は、手がかりごと出ない", async () => {
    const { res } = await get("/api/archives", {
      view: false,
      results: [[{ ...base, id: ids[0], ...none, shotStage: "after-load", shotBytes: 47692 }]],
    });
    expect(res.json()).toEqual({ archives: [] });
  });
});
