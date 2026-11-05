import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import {
  registerReplayBundleRoutes,
  type ReplayBundleRouteDeps,
} from "../src/api/replay-bundle.js";
import type { CrawlState } from "../src/db/database.js";
import { replayDigestBytes } from "../src/replay-bundle/format.js";
import type { UninspectedArchive } from "../src/replay-bundle/inspect.js";
import {
  createReplayBundleSigner,
  type ReplayBundleSigner,
  type SignOutcome,
} from "../src/replay-bundle/sign.js";
import type { SignedData } from "../src/replay-bundle/verify-signed-data.js";
import { linkArchivesToCrawl } from "../src/replay-bundle/write.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";
import { createTestCa, OPENSSL, type TestCa } from "./signing-ca.js";

/**
 * 合本の口 (`POST /api/crawls/:id/replay-bundle`)。索引の口の試験 (`routes-search.test.ts`) と同じ作り。
 *
 * DB は本物の Kysely に SQL を組ませて記録する代役 (`recording-db.ts`)。返す行は試験が並べた物なので、**SQL が
 * Postgres で本当に通るか・「前へだけ」を DB が本当に守るかはここでは言えない** (この repo に DB の試験は無い。
 * dev の Postgres で確かめる)。ここで見るのは、組まれた SQL の形 (払い出しと読みが 1 つのトランザクション・
 * 前へだけの条件)、保管庫に書く物、答えの形。WACZ を検める所は差し替え口 (`inspectOne`) にして、zip は
 * `replay-bundle-inspect.test.ts` が見る。
 *
 * 署名 (CAPTURE-61) は 2 つの形で見る。いつ頼むか・何を頼むか・どの順に置くかは、頼まれた hash を記録する代役の
 * 窓口で。署名が付かない時に合本を署名なしで書いて理由を残すかは、本物の窓口 (`replay-bundle/sign.ts`) と本物の
 * 検めに、fetch を差し替えて試験の CA (`test/signing-ca.ts`) の署名を返させて。
 */

const CRAWL = "3f2a1b2c-0000-4000-8000-000000000001";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const NOW = new Date("2026-11-05T03:30:00.000Z");

interface Put {
  bucket: string;
  key: string;
  contentType: string | undefined;
  /** 置いたバイト列そのもの (署名した hash と比べる)。 */
  bytes: Buffer;
  body: unknown;
}

/** 置いたバイト列の sha256 (`sha256:<hex>`)。 */
const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const build = async (opts: {
  results?: readonly (readonly object[])[];
  allowed?: boolean;
  identity?: boolean;
  inspectOne?: (archive: UninspectedArchive) => Promise<void>;
  /** 保管庫への書き込みを、この誤りで落とす。 */
  putError?: Error;
  /** 署名の窓口。省けば署名の設定が無い配備。 */
  signer?: ReplayBundleSigner;
}): Promise<{ app: FastifyInstance; queries: RecordedQuery[]; puts: Put[] }> => {
  const { db, queries } = recordingDb(opts.results);
  const puts: Put[] = [];
  const s3 = {
    send: (command: {
      input: { Bucket: string; Key: string; Body?: Buffer; ContentType?: string };
    }) => {
      const { Bucket, Key, Body, ContentType } = command.input;
      if (opts.putError !== undefined) return Promise.reject(opts.putError);
      const bytes = Body ?? Buffer.alloc(0);
      puts.push({
        bucket: Bucket,
        key: Key,
        contentType: ContentType,
        bytes,
        body: JSON.parse(bytes.toString("utf8")) as unknown,
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
    ...(opts.signer && { signer: opts.signer }),
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
  inspectedAt: new Date("2026-11-05T02:00:00.000Z"),
  depth,
});

/** まだ検めていないアーカイブの行 (同じ読みに出る。sha256 も index_empty も無い)。 */
const notInspected = (id: string, depth: number, capturedAt: string) => ({
  id,
  objectKey: `${id}_${CRAWL}.wacz`,
  waczSha256: null,
  indexEmpty: null,
  capturedAt: new Date(capturedAt),
  inspectedAt: null,
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

/** 払い出しの returning (版と、行の鍵の下で読んだクロールの状態)。 */
const issuedRow = (rev: number, state: CrawlState) =>
  state === "running"
    ? { rev, state, stopReason: null, finishedAt: null }
    : {
        rev,
        state,
        stopReason: state === "failed" ? "failed" : "completed",
        finishedAt: new Date("2026-11-05T03:29:58.000Z"),
      };

/**
 * 問い合わせの順に返す行: クロール → まだ検めていない物 → (begin) 版の払い出し → クロールのアーカイブ (検めて
 * いない物も) → 頁の行 (commit) → (書けたら) アーカイブの版 → 指す版 → (署名したら) 署名した版。
 */
const results = (
  opts: {
    rev?: number;
    state?: CrawlState;
    pending?: UninspectedArchive[];
    members?: object[];
    pages?: object[];
  } = {},
) => [
  [{ id: CRAWL, orgId: "acme" }],
  opts.pending ?? [],
  [issuedRow(opts.rev ?? 3, opts.state ?? "running")],
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
      // 走っているクロールの版には署名しない (署名する時でないので、理由も無い)
      signed: false,
      signError: null,
      digestKey: null,
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
        // 払い出しの returning で読んだ状態
        crawlState: "running",
        stopReason: null,
        finishedAt: null,
        members: 2,
        skipped: 1,
        skippedResources: [{ name: `e_${CRAWL}.wacz`, hash: `sha256:${"e".repeat(64)}` }],
        // pages.json のバイト列の sha256
        pagesHash: sha256(puts[0]?.bytes ?? Buffer.alloc(0)),
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

  it("版の払い出し（クロールの状態も）と、アーカイブと頁の行の読みは 1 つのトランザクション（払い出しの行の鍵が読みを順に並べる）", async () => {
    const { queries } = await post({ results: results() });
    expect(sqls(queries).slice(2, 7)).toEqual([
      "begin",
      'update "crawls" set "replay_bundle_next_rev" = "replay_bundle_next_rev" + $1 where "id" = $2 ' +
        'returning "replay_bundle_next_rev" - $3 as "rev", "state", "stop_reason", "finished_at"',
      // 検めていない物も同じ問い合わせで読む (未検めを数える。別の問い合わせにすると snapshot がずれる)
      'select distinct on ("a"."id") "a"."id", "a"."object_key", "a"."wacz_sha256", "a"."index_empty", ' +
        '"a"."captured_at", "a"."inspected_at", "p"."depth" from "archives" as "a" ' +
        'left join "crawl_pages" as "p" on "p"."crawl_id" = "a"."crawl_id" and "p"."task_id" = "a"."task_id"::text ' +
        'where "a"."crawl_id" = $1 order by "a"."id", "p"."depth"',
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
        '"replay_bundle_built_at" = $4, "replay_bundle_error" = $5, "replay_bundle_sign_error" = $6 ' +
        'where "id" = $7 and ("replay_bundle_rev" is null or "replay_bundle_rev" < $8)',
    );
    expect(pointer?.parameters).toEqual([
      7,
      `org/acme/crawls/${CRAWL}/r7/replay.json`,
      2,
      NOW.toISOString(),
      null,
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
      signed: false,
      signError: null,
      digestKey: null,
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
      signed: false,
      signError: null,
      digestKey: null,
    });
    expect(puts).toEqual([]);
    expect(sqls(queries).at(-1)).toBe("commit");
  });
});

/** 頼まれた hash と、そのときの問い合わせを記録する代役の窓口。答えは `answer` が決める。 */
const recordingSigner = (
  queries: () => RecordedQuery[],
  answer: (hash: string) => SignOutcome = (hash) => ({
    signed: true,
    signedData: { hash, signature: "c2ln", domain: "sign.test", domainCert: "" },
  }),
) => {
  const calls: { hash: string; sqlsAtCall: string[] }[] = [];
  const signer: ReplayBundleSigner = {
    sign: (hash) => {
      calls.push({ hash, sqlsAtCall: sqls(queries()) });
      return Promise.resolve(answer(hash));
    },
  };
  return { signer, calls };
};

/**
 * 代役の窓口が問い合わせを見られるよう、`build` の queries を後から渡す形で投げる。
 * `post` と同じだが、窓口を作るのに queries が要る。
 */
const postSigned = async (
  opts: Omit<Parameters<typeof build>[0], "signer">,
  answer?: (hash: string) => SignOutcome,
) => {
  let seen: RecordedQuery[] = [];
  const { signer, calls } = recordingSigner(() => seen, answer);
  const built = await build({ ...opts, signer });
  seen = built.queries;
  const res = await built.app.inject({
    method: "POST",
    url: `/api/crawls/${CRAWL}/replay-bundle`,
    headers: SUBJECT,
    payload: { depth: 1 },
  });
  await built.app.close();
  return { res, queries: built.queries, puts: built.puts, calls };
};

const SIGNED_UPDATE =
  'update "crawls" set "replay_bundle_signed_rev" = $1, "replay_bundle_digest_key" = $2 ' +
  'where "id" = $3 and ("replay_bundle_signed_rev" is null or "replay_bundle_signed_rev" < $4)';

describe("合本に署名する（CAPTURE-61）", () => {
  it("走っているクロールの版には署名を頼まない（理由も残さない）", async () => {
    const { res, calls, puts } = await postSigned({ results: results({ state: "running" }) });
    expect(calls).toEqual([]);
    expect(res.json()).toMatchObject({ signed: false, signError: null, digestKey: null });
    expect(puts.map((put) => put.key.split("/").at(-1))).toEqual(["pages.json", "replay.json"]);
  });

  it("署名の設定が無ければ、終わったクロールの版でも署名しない（理由も残さない）", async () => {
    const { res, puts } = await post({ results: results({ state: "succeeded" }) });
    expect(res.json()).toMatchObject({ signed: false, signError: null, digestKey: null });
    expect(puts).toHaveLength(2);
  });

  it("未検めのアーカイブが残れば、終わっていても署名を頼まず、理由を指す版と一緒に残す", async () => {
    const { res, calls, puts, queries } = await postSigned({
      results: results({
        state: "succeeded",
        members: [
          member("a", 0, "2026-11-05T01:00:09.000Z"),
          notInspected("u", 1, "2026-11-05T01:00:10.000Z"),
        ],
        pages: [page("a", "http://site.test/", "2026-11-05T01:00:09.000Z")],
      }),
    });
    expect(calls).toEqual([]);
    const reason =
      "not signed: 1 archive(s) of the crawl are not inspected yet, so r3 may not hold every WACZ " +
      "of it (rebuild once they can be read)";
    expect(res.json()).toMatchObject({ rev: 3, members: 1, signed: false, signError: reason });
    // 検めていない物は合本に入らない
    const replay = puts.find((put) => put.key.endsWith("/replay.json"))?.body as {
      resources: { name: string }[];
    };
    expect(replay.resources.map((resource) => resource.name)).toEqual([`a_${CRAWL}.wacz`]);
    const pointer = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "replay_bundle_rev"'),
    );
    expect(pointer?.parameters[5]).toBe(reason);
    expect(sqls(queries)).not.toContain(SIGNED_UPDATE);
  });

  it("終わったクロールの版は、保管庫に置いた replay.json のバイト列の sha256 に署名を頼む", async () => {
    const { calls, puts } = await postSigned({ results: results({ state: "succeeded" }) });
    const replay = puts.find((put) => put.key.endsWith("/replay.json"));
    expect(calls.map((call) => call.hash)).toEqual([sha256(replay?.bytes ?? Buffer.alloc(0))]);
    // 署名する replay.json は、終わった状態を書いている
    expect(replay?.body).toMatchObject({
      replayBundle: { crawlState: "succeeded", stopReason: "completed" },
    });
  });

  it("failed で締めたクロールの版にも署名する", async () => {
    const { calls, res } = await postSigned({ results: results({ state: "failed" }) });
    expect(calls).toHaveLength(1);
    expect(res.json()).toMatchObject({ signed: true });
  });

  it("署名はトランザクションの外で頼む（TSA を待つ間、クロールの行の鍵を持たない）", async () => {
    const { calls } = await postSigned({ results: results({ state: "succeeded" }) });
    const atCall = calls[0]?.sqlsAtCall ?? [];
    expect(atCall.filter((sql) => sql === "begin")).toHaveLength(1);
    expect(atCall.filter((sql) => sql === "commit")).toHaveLength(1);
    expect(atCall.at(-1)).toBe("commit");
  });

  it("書く順は pages.json → replay-digest.json → replay.json で、digest は {path, hash, signedData}", async () => {
    const { puts, calls } = await postSigned({ results: results({ state: "succeeded" }) });
    expect(puts.map((put) => [put.key, put.contentType])).toEqual([
      [`org/acme/crawls/${CRAWL}/r3/pages.json`, "application/json"],
      [`org/acme/crawls/${CRAWL}/r3/replay-digest.json`, "application/json"],
      [`org/acme/crawls/${CRAWL}/r3/replay.json`, "application/json"],
    ]);
    const hash = calls[0]?.hash ?? "";
    const signedData = { hash, signature: "c2ln", domain: "sign.test", domainCert: "" };
    expect(puts[1]?.bytes.equals(replayDigestBytes(hash, signedData as SignedData))).toBe(true);
  });

  it("署名した版を、指す版とは別に前へだけ進め、答えに digest の鍵を返す", async () => {
    const { res, queries } = await postSigned({ results: results({ rev: 7, state: "succeeded" }) });
    expect(res.json()).toMatchObject({
      rev: 7,
      signed: true,
      signError: null,
      digestKey: `org/acme/crawls/${CRAWL}/r7/replay-digest.json`,
    });
    // 指す版・署名した版の 2 つの前へだけの UPDATE が、1 つのトランザクションの中
    expect(sqls(queries).slice(-5)).toEqual([
      "begin",
      expect.stringMatching(/^update "archives" set "replay_bundle_rev"/) as unknown as string,
      expect.stringMatching(/^update "crawls" set "replay_bundle_rev"/) as unknown as string,
      SIGNED_UPDATE,
      "commit",
    ]);
    expect(queries.at(-2)?.parameters).toEqual([
      7,
      `org/acme/crawls/${CRAWL}/r7/replay-digest.json`,
      CRAWL,
      7,
    ]);
    // 指す版の署名の理由は消す
    const pointer = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "replay_bundle_rev"'),
    );
    expect(pointer?.parameters[5]).toBeNull();
  });

  it("署名が付かなければ、署名した版を動かさず、理由を指す版と一緒に残す", async () => {
    const { res, queries, puts } = await postSigned(
      { results: results({ state: "succeeded" }) },
      () => ({ signed: false, reason: "http://wacz-signer.test:8080/sign — returned 502" }),
    );
    expect(res.json()).toMatchObject({
      signed: false,
      signError: "http://wacz-signer.test:8080/sign — returned 502",
      digestKey: null,
    });
    expect(puts.map((put) => put.key.split("/").at(-1))).toEqual(["pages.json", "replay.json"]);
    expect(sqls(queries)).not.toContain(SIGNED_UPDATE);
  });
});

/**
 * 署名が付かない時は、合本を署名なしで書いて理由を残す。本物の窓口 (`replay-bundle/sign.ts`) と本物の検めに、
 * fetch を差し替えて答えさせる。署名は試験の CA (`test/signing-ca.ts`) の本物 —— 置き換えの文字列では、
 * 検めを消しても通ってしまう。
 */
describe("署名が付かなければ、署名なしで書いて理由を残す（本物の窓口と検め）", () => {
  const URL = "http://wacz-signer.test:8080/sign";
  let ca: TestCa;
  let other: TestCa;

  beforeAll(async () => {
    [ca, other] = await Promise.all([createTestCa(), createTestCa()]);
  });

  afterAll(async () => {
    await Promise.all([ca.dispose(), other.dispose()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** wacz-signer の代わりに答える。頼まれた hash と頭を記録する。 */
  const answering = (respond: (hash: string, signal: AbortSignal) => Promise<Response>) => {
    const requests: { url: string; hash: string; authorization: string | null }[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      // 窓口は本文を JSON の文字列で送る
      const { hash } = JSON.parse(init.body as string) as { hash: string };
      requests.push({ url, hash, authorization: new Headers(init.headers).get("authorization") });
      return respond(hash, init.signal!);
    });
    return requests;
  };

  const json = (body: unknown): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  const write = async (timeoutMs = 2_000) => {
    const signer = createReplayBundleSigner({
      url: URL,
      token: "dev-token",
      anchors: ca.anchors,
      timeoutMs,
      opensslBin: OPENSSL,
    });
    const built = await build({ results: results({ state: "succeeded" }), signer });
    const res = await built.app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/replay-bundle`,
      headers: SUBJECT,
      payload: { depth: 1 },
    });
    await built.app.close();
    return { res, queries: built.queries, puts: built.puts };
  };

  /** 署名なしで書き、理由を指す版と一緒に残したか。 */
  const expectUnsigned = (
    got: Awaited<ReturnType<typeof write>>,
    reason: string | RegExp,
  ): void => {
    const body = got.res.json<{ signed: boolean; signError: string; digestKey: string | null }>();
    expect(got.res.statusCode).toBe(200);
    expect(body.signed).toBe(false);
    expect(body.digestKey).toBeNull();
    if (typeof reason === "string") expect(body.signError).toBe(reason);
    else expect(body.signError).toMatch(reason);
    // 合本は書く (replay は開ける)。digest は書かない
    expect(got.puts.map((put) => put.key.split("/").at(-1))).toEqual(["pages.json", "replay.json"]);
    const pointer = got.queries.find((query) =>
      query.sql.startsWith('update "crawls" set "replay_bundle_rev"'),
    );
    expect(pointer?.parameters[5]).toBe(body.signError);
    expect(sqls(got.queries)).not.toContain(SIGNED_UPDATE);
  };

  it("署名が検めを通れば digest を書く（頼み方は POST /sign・Bearer・{hash}）", async () => {
    const requests = answering(async (hash) => json(await ca.sign(hash)));
    const { res, puts } = await write();
    expect(res.json()).toMatchObject({ signed: true, signError: null });
    expect(requests).toEqual([
      { url: URL, hash: requests[0]?.hash, authorization: "Bearer dev-token" },
    ]);
    const replay = puts.find((put) => put.key.endsWith("/replay.json"));
    expect(requests[0]?.hash).toBe(sha256(replay?.bytes ?? Buffer.alloc(0)));
    const digest = puts.find((put) => put.key.endsWith("/replay-digest.json"))?.body;
    expect(digest).toMatchObject({ path: "replay.json", hash: requests[0]?.hash });
  });

  it("別の hash に署名した物が返れば、署名なしで書く", async () => {
    answering(async () => json(await ca.sign(`sha256:${"0".repeat(64)}`)));
    expectUnsigned(await write(), /signedData\.hash .* is not the hash of these bytes/);
  });

  it("時刻印の無い物が返れば、署名なしで書く", async () => {
    answering(async (hash) => {
      const signedData = await ca.sign(hash);
      delete signedData.timeSignature;
      return json(signedData);
    });
    expectUnsigned(await write(), `${URL} — timestamp is missing: signedData has no timeSignature`);
  });

  it("502（wacz-signer が TSA に届かない）なら、署名なしで書く", async () => {
    answering(() => Promise.resolve(new Response("bad gateway", { status: 502 })));
    expectUnsigned(await write(), `${URL} — returned 502`);
  });

  it("時間切れなら、署名なしで書く", async () => {
    answering(
      (_hash, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        }),
    );
    expectUnsigned(await write(100), /timeout/i);
  });

  it("検めを通らない（錨に届かない CA の）署名が返れば、署名なしで書く", async () => {
    answering(async (hash) => json(await other.sign(hash)));
    expectUnsigned(await write(), `${URL} — certificate chain does not reach a trusted root`);
  });

  it("signedData の形でない物が返れば、署名なしで書く", async () => {
    answering(() => json({ valid: true }));
    expectUnsigned(await write(), `${URL} — returned no signedData`);
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
