import { describe, it, expect } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import {
  registerReplayBundleRoutes,
  type ReplayBundleRouteDeps,
} from "../src/api/replay-bundle.js";
import type { UninspectedArchive } from "../src/replay-bundle/inspect.js";
import { linkArchivesToCrawl } from "../src/replay-bundle/write.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

/**
 * 合本の口 (`POST /api/crawls/:id/replay-bundle`)。索引の口の試験 (`routes-search.test.ts`) と同じ作り。
 *
 * DB は本物の Kysely に SQL を組ませて記録する代役 (`recording-db.ts`)。返す行は試験が並べた物なので、**SQL が
 * Postgres で本当に通るか・「前へだけ」を DB が本当に守るかはここでは言えない** (この repo に DB の試験は無い。
 * dev の Postgres で確かめる)。ここで見るのは、組まれた SQL の形 (払い出しと読みが 1 つのトランザクション・
 * 前へだけの条件)、保管庫に書く物、答えの形。WACZ を検める所は差し替え口 (`inspectOne`) にして、zip は
 * `replay-bundle-inspect.test.ts` が見る。
 */

const CRAWL = "3f2a1b2c-0000-4000-8000-000000000001";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const NOW = new Date("2026-11-05T03:30:00.000Z");

interface Put {
  bucket: string;
  key: string;
  contentType: string | undefined;
  body: unknown;
}

const build = async (opts: {
  results?: readonly (readonly object[])[];
  allowed?: boolean;
  identity?: boolean;
  inspectOne?: (archive: UninspectedArchive) => Promise<void>;
  /** 保管庫への書き込みを、この誤りで落とす。 */
  putError?: Error;
}): Promise<{ app: FastifyInstance; queries: RecordedQuery[]; puts: Put[] }> => {
  const { db, queries } = recordingDb(opts.results);
  const puts: Put[] = [];
  const s3 = {
    send: (command: {
      input: { Bucket: string; Key: string; Body?: Buffer; ContentType?: string };
    }) => {
      const { Bucket, Key, Body, ContentType } = command.input;
      if (opts.putError !== undefined) return Promise.reject(opts.putError);
      puts.push({
        bucket: Bucket,
        key: Key,
        contentType: ContentType,
        body: Body === undefined ? undefined : (JSON.parse(Body.toString("utf8")) as unknown),
      });
      return Promise.resolve({});
    },
  };
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
    return reply.code(500).send({ error: "internal error", message: error.message });
  });
  registerReplayBundleRoutes(app, {
    db,
    fga: { check: () => Promise.resolve({ allowed: opts.allowed ?? true }) },
    s3,
    bucket: "browserhive",
    resolveIdentity: () =>
      Promise.resolve(
        opts.identity === false ? undefined : { subject: "alice", organizations: ["acme"] },
      ),
    inspectOne: opts.inspectOne ?? (() => Promise.resolve()),
    now: () => NOW,
  } as unknown as ReplayBundleRouteDeps);
  await app.ready();
  return { app, queries, puts };
};

const post = async (
  opts: Parameters<typeof build>[0],
  payload: unknown = { depth: 1 },
  url = `/api/crawls/${CRAWL}/replay-bundle`,
) => {
  const built = await build(opts);
  const res = await built.app.inject({
    method: "POST",
    url,
    headers: SUBJECT,
    payload: payload as object,
  });
  await built.app.close();
  return { res, queries: built.queries, puts: built.puts };
};

/** まだ検めていないアーカイブ (差し替え口に渡る物)。 */
const uninspected = (id: string): UninspectedArchive => ({
  id,
  bucket: "browserhive",
  objectKey: `${id}_${CRAWL}.wacz`,
  manifestKey: `${id}_${CRAWL}.result.json`,
});

/** 検めたアーカイブの行 (読みの select の形)。 */
const member = (id: string, depth: number, capturedAt: string, indexEmpty = false) => ({
  id,
  objectKey: `${id}_${CRAWL}.wacz`,
  waczSha256: id.repeat(64).slice(0, 64),
  indexEmpty,
  capturedAt: new Date(capturedAt),
  depth,
});

/** 頁の行 (`archive_pages` の select の形)。文書の行 1 つ。 */
const page = (archiveId: string, url: string, ts: string) => ({
  archiveId,
  ordinal: 0,
  pageId: archiveId,
  url,
  ts,
  title: url,
  stage: null,
  keys: [url],
});

/**
 * 問い合わせの順に返す行: クロール → まだ検めていない物 → (begin) 版の払い出し → 検めたアーカイブ → 頁の行
 * (commit) → (書けたら) アーカイブの版 → 指す版。
 */
const results = (
  opts: { rev?: number; pending?: UninspectedArchive[]; members?: object[]; pages?: object[] } = {},
) => [
  [{ id: CRAWL, orgId: "acme" }],
  opts.pending ?? [],
  [{ rev: opts.rev ?? 3 }],
  opts.members ?? [
    member("b", 1, "2026-11-05T01:00:05.000Z"),
    member("a", 0, "2026-11-05T01:00:09.000Z"),
    member("e", 1, "2026-11-05T01:00:07.000Z", true),
  ],
  opts.pages ?? [
    page("b", "http://site.test/b", "2026-11-05T01:00:05.000Z"),
    page("a", "http://site.test/", "2026-11-05T01:00:09.000Z"),
    page("e", "http://site.test/empty", "2026-11-05T01:00:07.000Z"),
  ],
];

const sqls = (queries: RecordedQuery[]) => queries.map((query) => query.sql);

describe("合本の口の入口", () => {
  it("身元が解けなければ 401", async () => {
    const { res, queries } = await post({ identity: false });
    expect(res.statusCode).toBe(401);
    expect(queries).toEqual([]);
  });

  it("can_submit が無ければ 404 で、DB を引かない", async () => {
    const { res, queries } = await post({ allowed: false });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(queries).toEqual([]);
  });

  it("id や本文の形が違えば 400 で、許可を見る前に断る", async () => {
    const cases: [string, unknown][] = [
      ["/api/crawls/not-a-uuid/replay-bundle", { depth: 1 }],
      [`/api/crawls/${CRAWL}/replay-bundle`, {}],
      [`/api/crawls/${CRAWL}/replay-bundle`, { depth: -1 }],
      [`/api/crawls/${CRAWL}/replay-bundle`, { depth: 1.5 }],
      [`/api/crawls/${CRAWL}/replay-bundle`, { depth: 1, rev: 9 }],
    ];
    for (const [url, payload] of cases) {
      const { res, queries } = await post({ allowed: false }, payload, url);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(queries, JSON.stringify(payload)).toEqual([]);
    }
  });

  it("クロールが無ければ 404 で、検めも書きもしない", async () => {
    let inspected = 0;
    const { res, queries, puts } = await post({
      results: [[]],
      inspectOne: () => {
        inspected += 1;
        return Promise.resolve();
      },
    });
    expect(res.statusCode).toBe(404);
    expect(sqls(queries)).toEqual(['select "id", "org_id" from "crawls" where "id" = $1']);
    expect(inspected).toBe(0);
    expect(puts).toEqual([]);
  });
});

describe("合本を書く", () => {
  it("200 で版・頁の数・WACZ の数・外した数・検められなかった数を返し、2 つの物を版の置き場に JSON で書く", async () => {
    const { res, puts } = await post({ results: results() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rev: 3,
      pages: 2,
      members: 2,
      skipped: 1,
      failed: 0,
      error: null,
    });
    // pages.json が先 (replay.json は pagesQueryUrl でそれを指す)。bucket は設定の物
    expect(puts.map((put) => [put.bucket, put.key, put.contentType])).toEqual([
      ["browserhive", `org/acme/crawls/${CRAWL}/r3/pages.json`, "application/json"],
      ["browserhive", `org/acme/crawls/${CRAWL}/r3/replay.json`, "application/json"],
    ]);
    expect(puts[1]?.body).toMatchObject({
      title: "クロール 3f2a1b2c の合本 r3",
      pagesQueryUrl: `/q/org/acme/crawls/${CRAWL}/r3/pages`,
      totalPages: 2,
      replayBundle: {
        version: 1,
        crawlId: CRAWL,
        rev: 3,
        depth: 1,
        builtAt: NOW.toISOString(),
        members: 2,
        skipped: 1,
      },
    });
    // 起点の WACZ が先頭。記録が 0 の WACZ (e) は入らない
    const replay = puts[1]?.body as { resources: { name: string }[] };
    expect(replay.resources.map((resource) => resource.name)).toEqual([
      `a_${CRAWL}.wacz`,
      `b_${CRAWL}.wacz`,
    ]);
    expect(puts[0]?.body).toMatchObject({ version: 1, crawlId: CRAWL, rev: 3 });
  });

  it("まだ検めていない WACZ を検め、1 本の失敗は failed に数えて続ける", async () => {
    const seen: string[] = [];
    const { res, puts } = await post({
      results: results({ pending: [uninspected("x"), uninspected("y"), uninspected("z")] }),
      inspectOne: (archive) => {
        seen.push(archive.id);
        return archive.id === "y" ? Promise.reject(new Error("zip ではない")) : Promise.resolve();
      },
    });
    expect(seen).toEqual(["x", "y", "z"]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rev: 3, failed: 1, error: null });
    expect(puts).toHaveLength(2);
  });

  it("まだ検めていない物はクロールの id で引き、答えの鍵は capture_submissions から", async () => {
    const { queries } = await post({ results: results() });
    expect(queries[1]?.sql).toBe(
      'select "a"."id", "a"."bucket", "a"."object_key", "s"."manifest_key" from "archives" as "a" ' +
        'left join "capture_submissions" as "s" on "s"."task_id" = "a"."task_id" ' +
        'where "a"."crawl_id" = $1 and "a"."inspected_at" is null order by "a"."captured_at"',
    );
    expect(queries[1]?.parameters).toEqual([CRAWL]);
  });

  it("版の払い出しと、アーカイブと頁の行の読みは 1 つのトランザクション（払い出しの行の鍵が読みを順に並べる）", async () => {
    const { queries } = await post({ results: results() });
    expect(sqls(queries).slice(2, 7)).toEqual([
      "begin",
      'update "crawls" set "replay_bundle_next_rev" = "replay_bundle_next_rev" + $1 where "id" = $2 ' +
        'returning "replay_bundle_next_rev" - $3 as "rev"',
      'select distinct on ("a"."id") "a"."id", "a"."object_key", "a"."wacz_sha256", "a"."index_empty", ' +
        '"a"."captured_at", "p"."depth" from "archives" as "a" ' +
        'left join "crawl_pages" as "p" on "p"."crawl_id" = "a"."crawl_id" and "p"."task_id" = "a"."task_id"::text ' +
        'where "a"."crawl_id" = $1 and "a"."inspected_at" is not null order by "a"."id", "p"."depth"',
      'select "ap"."archive_id", "ap"."ordinal", "ap"."page_id", "ap"."url", "ap"."ts", "ap"."title", ' +
        '"ap"."stage", "ap"."keys" from "archive_pages" as "ap" ' +
        'inner join "archives" as "a" on "a"."id" = "ap"."archive_id" where "a"."crawl_id" = $1',
      "commit",
    ]);
    expect(queries[3]?.parameters).toEqual([1, CRAWL, 1]);
  });

  it("台帳が指す版は前へだけ —— 書き終えた版がいまより大きいときだけ差し替え、理由を消す", async () => {
    const { queries } = await post({ results: results({ rev: 7 }) });
    const pointer = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "replay_bundle_rev"'),
    );
    expect(pointer?.sql).toBe(
      'update "crawls" set "replay_bundle_rev" = $1, "replay_bundle_key" = $2, "replay_bundle_pages" = $3, ' +
        '"replay_bundle_built_at" = $4, "replay_bundle_error" = $5 ' +
        'where "id" = $6 and ("replay_bundle_rev" is null or "replay_bundle_rev" < $7)',
    );
    expect(pointer?.parameters).toEqual([
      7,
      `org/acme/crawls/${CRAWL}/r7/replay.json`,
      2,
      NOW.toISOString(),
      null,
      CRAWL,
      7,
    ]);
  });

  it("入れた WACZ に、最初に入った版を書く（小さい版を残す。外した WACZ には書かない）", async () => {
    const { queries } = await post({ results: results({ rev: 7 }) });
    const tail = sqls(queries).slice(-4);
    expect(tail).toEqual([
      "begin",
      'update "archives" set "replay_bundle_rev" = $1 where "id" in ($2, $3) ' +
        'and ("replay_bundle_rev" is null or "replay_bundle_rev" > $4)',
      expect.stringMatching(/^update "crawls" set "replay_bundle_rev"/) as unknown as string,
      "commit",
    ]);
    expect(queries[queries.length - 3]?.parameters).toEqual([7, "a", "b", 7]);
  });

  it("保管庫に書けなければ 200 で error を返し、理由を前へだけ残し、指す版もアーカイブの版も動かさない", async () => {
    const { res, queries } = await post({
      results: results(),
      putError: new Error("connect ECONNREFUSED 127.0.0.1:8333"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rev: 3,
      pages: 2,
      members: 2,
      skipped: 1,
      failed: 0,
      error: "could not write r3 to the store: connect ECONNREFUSED 127.0.0.1:8333",
    });
    const last = queries[queries.length - 1];
    expect(last?.sql).toBe(
      'update "crawls" set "replay_bundle_error" = $1 where "id" = $2 ' +
        'and ("replay_bundle_rev" is null or "replay_bundle_rev" < $3)',
    );
    expect(last?.parameters).toEqual([
      "could not write r3 to the store: connect ECONNREFUSED 127.0.0.1:8333",
      CRAWL,
      3,
    ]);
    expect(sqls(queries).some((sql) => sql.startsWith('update "archives"'))).toBe(false);
    expect(sqls(queries).some((sql) => sql.includes('"replay_bundle_key"'))).toBe(false);
  });

  it("入れる WACZ が無ければ書かず、rev は null（指す版を動かさない）", async () => {
    const { res, queries, puts } = await post({
      results: results({
        members: [member("e", 0, "2026-11-05T01:00:00.000Z", true)],
        pages: [page("e", "http://site.test/", "2026-11-05T01:00:00.000Z")],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rev: null,
      pages: 0,
      members: 0,
      skipped: 1,
      failed: 0,
      error: null,
    });
    expect(puts).toEqual([]);
    expect(sqls(queries).at(-1)).toBe("commit");
  });
});

/**
 * 作り直しの道具 (`pnpm run replay-bundle:rebuild`) が、合本を書く前に打つ。027 より前の行は `crawl_id` が空なので、
 * 台帳の他の口と同じ `crawl_pages.task_id` でクロールに繋ぐ。
 */
describe("027 より前のアーカイブをクロールに繋ぐ（作り直しの道具）", () => {
  it("crawl_id が空で、そのクロールの頁の行が同じ task_id を持つ物だけに入れる", async () => {
    const { db, queries } = recordingDb();
    await linkArchivesToCrawl(db, CRAWL);
    expect(queries[0]?.sql).toBe(
      'update "archives" set "crawl_id" = $1 where "crawl_id" is null and exists ' +
        '(select "p"."id" from "crawl_pages" as "p" where "p"."crawl_id" = $2 ' +
        'and "p"."task_id" = "archives"."task_id"::text)',
    );
    expect(queries[0]?.parameters).toEqual([CRAWL, CRAWL]);
  });
});
