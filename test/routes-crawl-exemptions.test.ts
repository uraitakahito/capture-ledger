/**
 * robots.txt の例外がクロールを通る道 (t-6bc6・`047`)。始める時の資格・最初の段と次の段の引数・段の行に残る物・
 * 段の報告の `robotsExemptionId`。
 *
 * 本物の Kysely に SQL を組ませる代役 (`recording-db.ts`) で見る。資格の決め方そのものは
 * `exemptions-eligibility.test.ts`、引く SQL と残りの枚数は `exemptions-dispatch.test.ts`、Postgres で通るかは
 * `src/tools/robots-exemptions-smoke.ts`。ここが見るのは、route が**それを呼び、答えを運ぶ**こと。
 */
import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import {
  registerCrawlRoutes,
  type CrawlRouteDeps,
  type DispatchedCrawl,
} from "../src/api/crawls.js";
import type { Identity } from "../src/api/identity.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import { flowArgs } from "../src/crawl/dispatch.js";
import { LEVEL_KEY, levelResponder, type LevelOptions } from "./level-responder.js";
import { recordingDb, type RecordedQuery, type Responder } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const SEED = "https://site.test/exempt/";
const LEAF = "https://site.test/exempt/a";
const HOST = "site.test";
const UA = "BrowserHive/1.0 (+https://site.test/bot)";
const COMPILED = { typescript: "6.0.3", hostTypes: "v0.2.0", scripts: [] };

/** DB が返す例外の行 (`exemptionsForLevel` の select の形)。 */
const exemptionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "7",
  host: HOST,
  pathPattern: "/exempt/",
  scope: "links",
  userAgent: UA,
  reason: "証拠として残す",
  dailyLimit: 100,
  linkLimit: 20,
  createdBy: "alice-sub",
  createdByName: "alice",
  createdAt: new Date("2026-11-20T00:00:00.000Z"),
  expiresAt: new Date("2026-12-28T03:00:00.000Z"),
  usedLast24h: 1,
  usedLinks: 0,
  ...overrides,
});

/** その行から組む、flow の引数の要素。 */
const dispatched = (remaining: number) => ({
  id: "7",
  host: HOST,
  pathPattern: "/exempt/",
  scope: "links",
  userAgent: UA,
  remaining,
  declaration: {
    exemptionId: "7",
    reason: "証拠として残す",
    pathPattern: "/exempt/",
    scope: "links",
    grantedBy: "alice",
    grantedAt: "2026-11-20T00:00:00.000Z",
    expiresAt: "2026-12-28T03:00:00.000Z",
  },
});

const isExemptionDraw = (sql: string): boolean =>
  sql.includes('from "robots_exemptions"') && sql.includes('"used_last24h"');

interface Built {
  app: FastifyInstance;
  queries: RecordedQuery[];
  sent: DispatchedCrawl[];
  asked: { request: Record<string, unknown>; options: unknown }[];
}

const build = async (opts: {
  db: ReturnType<typeof recordingDb>;
  identity?: Identity;
  identityMode?: CrawlRouteDeps["identityMode"];
  allowed?: (object: string) => boolean;
}): Promise<Built> => {
  const { db, queries } = opts.db;
  const sent: DispatchedCrawl[] = [];
  const asked: Built["asked"] = [];
  const allowed = opts.allowed ?? (() => true);
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  registerCrawlRoutes(app, {
    db,
    fga: {
      check: (request: Record<string, string>, options: unknown) => {
        asked.push({ request, options });
        return Promise.resolve({ allowed: allowed(request["object"]!) });
      },
    },
    resolveIdentity: () =>
      Promise.resolve(opts.identity ?? { subject: "alice-sub", organizations: ["acme"] }),
    identityMode: opts.identityMode ?? "jwt",
    dispatch: (crawl: DispatchedCrawl) => {
      sent.push(crawl);
      return Promise.resolve(crawl.levelKey);
    },
    s3: {
      send: () =>
        Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(JSON.stringify({ links: [{ href: LEAF }] })),
          },
        }),
    },
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
    tsCompile: {
      compile: () =>
        Promise.resolve({ ok: true, typescript: "6.0.3", hostTypes: "v0.6.0", declarations: [] }),
    },
    writeReplayBundle: () => Promise.resolve(undefined),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  return { app, queries, sent, asked };
};

describe("POST /api/crawls: 資格を 1 度決めて行に残し、最初の段に効く行を引く", () => {
  /** 始める道の問い合わせに答える係。起点の行を返し、例外の行を引かれたら `rows` を返す。ほかは空。 */
  const starting = (rows: readonly object[]): Responder => ({
    answer: (sql) => {
      if (sql.startsWith('insert into "crawl_pages"')) return [{ url: SEED, host: HOST }];
      if (isExemptionDraw(sql)) return rows;
      return [];
    },
  });
  const start = async (opts: Omit<Parameters<typeof build>[0], "db">, rows = [exemptionRow()]) => {
    const built = await build({ ...opts, db: recordingDb([], starting(rows)) });
    const res = await built.app.inject({
      method: "POST",
      url: "/api/crawls",
      headers: { "idempotency-key": randomUUID() },
      // 走らせる物は無い (空を明示する。省くと、登録済みのスクリプトが無い配備として断る)
      payload: { seeds: [SEED], maxDepth: 1, scripts: [] },
    });
    await built.app.close();
    const crawl = built.queries.find((query) => query.sql.startsWith('insert into "crawls"'));
    const level = built.queries.find((query) => query.sql.startsWith('insert into "crawl_levels"'));
    const draw = built.queries.find((query) => isExemptionDraw(query.sql));
    /** `crawls` の行に書いた資格 (列の並びから引く)。 */
    const columns = /\(([^)]*)\) values/.exec(crawl?.sql ?? "")?.[1]?.split(", ") ?? [];
    const eligibility = crawl?.parameters[columns.indexOf('"exemption_eligibility"')];
    return { ...built, res, crawl, level, draw, eligibility };
  };

  it("人が jwt の経路で始め、クロールの組織で始めてよければ human。効く行を引いて最初の段に載せ、段の行に残す", async () => {
    const { res, sent, eligibility, draw, level, queries, asked } = await start({});
    expect(res.statusCode).toBe(202);
    expect(eligibility).toBe("human");

    // 引くのは、クロールの行と起点と同じトランザクションの中 (段の行を足す前)
    const sqls = queries.map((query) => query.sql);
    const at = sqls.indexOf(draw!.sql);
    expect(at).toBeGreaterThan(sqls.indexOf("begin"));
    expect(at).toBeGreaterThan(
      sqls.findIndex((sql) => sql.startsWith('insert into "crawl_pages"')),
    );
    expect(at).toBeLessThan(sqls.indexOf(level!.sql));
    expect(sqls.indexOf(level!.sql)).toBeLessThan(sqls.indexOf("commit"));
    // クロールの組織と起点のホストで、深さ 0 (範囲で絞らない)。human は当たるクロールで絞らない
    expect(draw?.parameters).toEqual(expect.arrayContaining(["acme", HOST]));
    expect(draw?.sql).not.toContain('"scope" =');
    expect(draw?.sql).not.toContain("applies_to");

    // 深さ 0 の残りは 24 時間の上限から (100 − 1)
    expect(sent).toHaveLength(1);
    expect(sent[0]?.robotsExemptions).toEqual([dispatched(99)]);
    expect(flowArgs(sent[0]!)["robots_exemptions"]).toEqual([dispatched(99)]);
    // 段の行 (`crawl_levels.args`) に、送る段そのものが残る
    const args = JSON.parse(
      level!.parameters.find(
        (value) => typeof value === "string" && value.startsWith("{"),
      ) as string,
    ) as DispatchedCrawl;
    expect(args.robotsExemptions).toEqual([dispatched(99)]);
    expect(typeof args.robotsExemptions[0]?.remaining).toBe("number");
    expect(typeof args.robotsExemptions[0]?.id).toBe("string");

    // maySubmit の 1 回と、資格の 1 回。どちらも contextual tuple を送らない
    expect(asked.map(({ request }) => request)).toEqual([
      { user: "user:alice-sub", relation: "can_submit", object: "organization:acme" },
      { user: "user:alice-sub", relation: "can_submit", object: "organization:acme" },
    ]);
  });

  it("当たる行が無ければ、空の並びを載せる", async () => {
    const { sent, eligibility } = await start({}, []);
    expect(eligibility).toBe("human");
    expect(sent[0]?.robotsExemptions).toEqual([]);
    expect(flowArgs(sent[0]!)).toMatchObject({ robots_exemptions: [] });
  });

  /** review-2 の穴: `maySubmit` は B の許しで通すが、クロールは名乗りの 1 つ目 (A) の物になる。 */
  it("名乗りが [A, B] で許しは B だけなら、クロールは始まるが資格は none で、A の行を引かない", async () => {
    const { res, crawl, eligibility, draw, sent, asked } = await start({
      identity: { subject: "carol-sub", organizations: ["a", "b"] },
      allowed: (object) => object === "organization:b",
    });
    expect(res.statusCode).toBe(202);
    expect(crawl?.parameters).toContain("a");
    expect(eligibility).toBe("none");
    expect(draw).toBeUndefined();
    expect(sent[0]?.robotsExemptions).toEqual([]);
    // 資格は、クロールの組織 (A) 1 つについて訊く
    expect(asked.at(-1)?.request).toEqual({
      user: "user:carol-sub",
      relation: "can_submit",
      object: "organization:a",
    });
  });

  it("機械の主体は machine で、applies_to = 'all' の行だけを引く", async () => {
    const { eligibility, draw } = await start({
      identity: { subject: "client-id", organizations: ["acme"], machine: true },
    });
    expect(eligibility).toBe("machine");
    expect(draw?.sql).toContain('"applies_to" = ');
    expect(draw?.parameters).toContain("all");
  });

  it("ヘッダで名乗る経路は none で、行を引かない", async () => {
    const { res, eligibility, draw, sent } = await start({ identityMode: "header" });
    expect(res.statusCode).toBe(202);
    expect(eligibility).toBe("none");
    expect(draw).toBeUndefined();
    expect(sent[0]?.robotsExemptions).toEqual([]);
  });
});

/** 走行中のクロールの行 (`routes-crawl-levels.test.ts` と同じ形に、資格を足した物)。 */
const crawlRow = (overrides: Record<string, unknown> = {}) => ({
  id: CRAWL,
  seeds: [SEED],
  rules: [{ follow: "same-host" }],
  orgId: "acme",
  requestedBy: "alice-sub",
  state: "running",
  stopReason: null,
  maxDepth: 2,
  maxPages: 20,
  perHostDelayMs: 0,
  hostParallelism: 1,
  pagesDiscovered: 1,
  pagesCaptured: 0,
  artifactKeyPrefix: null,
  captureScripts: [],
  variables: {},
  secrets: {},
  userAgent: null,
  recordRandom: false,
  exemptionEligibility: "human",
  ...overrides,
});

/** 段の行の係に、例外の行の問い合わせ (引く・番号を確かめる) の答えを足す。 */
const withExemptions = (
  level: LevelOptions,
  answers: { draw?: readonly object[]; known?: readonly object[] },
): Responder => {
  const inner = levelResponder(level);
  return {
    answer: (sql, parameters) => {
      if (isExemptionDraw(sql)) return answers.draw ?? [];
      if (sql.startsWith('select "id" from "robots_exemptions"')) return answers.known ?? [];
      return inner.answer(sql, parameters);
    },
    ...(inner.seen && { seen: inner.seen }),
  };
};

const reportTo = (app: FastifyInstance, results: object[]) =>
  app.inject({
    method: "POST",
    url: `/api/crawls/${CRAWL}/pages`,
    headers: { "idempotency-key": LEVEL_KEY },
    payload: { depth: 0, compiled: COMPILED, results },
  });

/** 深さ 0 を報告し、葉が次の段になる並び (`routes-crawl-levels.test.ts` の「終わりの commit」と同じ)。 */
const nextLevelResults = (crawl: object) => [
  [crawl],
  [{ id: "11" }], // 報告した行を閉じる
  [], // crawl_decisions
  [{ url: SEED, depth: 0, state: "captured" }], // crawl_pages の URL
  [], // ホストごとの最後の時刻
  [{ url: LEAF, host: HOST }], // 次の段の行 (pending)
];
const CAPTURED = { url: SEED, status: "captured", linksLocation: "s3://b/seed.links.json" };

describe("次の段: 段の報告が、次の段に効く行を引いて載せる", () => {
  it("終わりの commit のトランザクションの中で、次の段のホストと深さで引き、段の行に残してから投げる", async () => {
    const db = recordingDb(
      nextLevelResults(crawlRow()),
      withExemptions({}, { draw: [exemptionRow({ usedLast24h: 1, usedLinks: 0 })] }),
    );
    const { app, queries, sent } = await build({ db });
    const res = await reportTo(app, [CAPTURED]);
    await app.close();
    expect(res.statusCode).toBe(200);

    const sqls = queries.map((query) => query.sql);
    const draw = queries.find((query) => isExemptionDraw(query.sql));
    const created = queries.find((query) => query.sql.startsWith('insert into "crawl_levels"'));
    // 錠を取った後 (最後のトランザクションの中)、次の段の行を足す前
    expect(sqls.indexOf(draw!.sql)).toBeGreaterThan(sqls.lastIndexOf("begin"));
    expect(sqls.indexOf(draw!.sql)).toBeLessThan(sqls.indexOf(created!.sql));
    expect(sqls.indexOf(created!.sql)).toBeLessThan(sqls.lastIndexOf("commit"));
    // クロールの組織・次の段のホスト・深さ 1 (links の行だけ)
    expect(draw?.parameters).toEqual(expect.arrayContaining([CRAWL, "acme", HOST, "links"]));
    expect(draw?.sql).toContain('"scope" = ');

    // 深さ 1 の残りは、リンクの上限 (20 − 0) と 24 時間の上限 (100 − 1) の小さい方
    expect(sent).toHaveLength(1);
    expect(sent[0]?.depth).toBe(1);
    expect(sent[0]?.robotsExemptions).toEqual([dispatched(20)]);
    expect(flowArgs(sent[0]!)["robots_exemptions"]).toEqual([dispatched(20)]);
    const args = JSON.parse(
      created!.parameters.find(
        (value) => typeof value === "string" && value.startsWith("{"),
      ) as string,
    ) as DispatchedCrawl;
    expect(args.robotsExemptions).toEqual([dispatched(20)]);
  });

  it("machine のクロールは applies_to = 'all' の行だけを引く", async () => {
    const db = recordingDb(
      nextLevelResults(crawlRow({ exemptionEligibility: "machine" })),
      withExemptions({}, {}),
    );
    const { app, queries, sent } = await build({ db });
    await reportTo(app, [CAPTURED]);
    await app.close();
    const draw = queries.find((query) => isExemptionDraw(query.sql));
    expect(draw?.sql).toContain('"applies_to" = ');
    expect(sent[0]?.robotsExemptions).toEqual([]);
  });

  it("資格が none のクロールは行を引かず、空の並びを載せる", async () => {
    const db = recordingDb(
      nextLevelResults(crawlRow({ exemptionEligibility: "none" })),
      withExemptions({}, { draw: [exemptionRow()] }),
    );
    const { app, queries, sent } = await build({ db });
    const res = await reportTo(app, [CAPTURED]);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(queries.some((query) => query.sql.includes("robots_exemptions"))).toBe(false);
    expect(sent[0]?.robotsExemptions).toEqual([]);
  });
});

describe("段の報告の robotsExemptionId", () => {
  const closing = (queries: RecordedQuery[]) =>
    queries.filter((query) => query.sql.startsWith('update "crawl_pages" set "state"'));
  const OLD_SQL =
    'update "crawl_pages" set "state" = $1, "skip_reason" = $2, "task_id" = $3, "correlation_id" = $4, ' +
    '"submitted_at" = $5, "finished_at" = $6 where "crawl_id" = $7 and "url" = $8 returning "id"';

  it("外した頁の行に、行の番号を書く。撮れなかった頁（failed）にも書く", async () => {
    const db = recordingDb(
      [[crawlRow({ maxDepth: 0 })]],
      withExemptions({}, { known: [{ id: "7" }] }),
    );
    const { app, queries } = await build({ db });
    const res = await reportTo(app, [
      { url: SEED, status: "captured", robotsExemptionId: "7" },
      { url: LEAF, status: "failed", skipReason: "timeout", robotsExemptionId: "7" },
    ]);
    await app.close();
    expect(res.statusCode).toBe(200);

    // 番号は、クロールの組織の行かを、書く前に確かめる (同じ番号は 1 度だけ訊く)
    const known = queries.find((query) =>
      query.sql.startsWith('select "id" from "robots_exemptions"'),
    );
    expect(known?.sql).toBe(
      'select "id" from "robots_exemptions" where "org_id" = $1 and "id" in ($2)',
    );
    expect(known?.parameters).toEqual(["acme", "7"]);
    const sqls = queries.map((query) => query.sql);
    expect(sqls.indexOf(known!.sql)).toBeLessThan(sqls.indexOf("begin"));

    const [seed, leaf] = closing(queries);
    expect(seed?.sql).toBe(
      'update "crawl_pages" set "state" = $1, "skip_reason" = $2, "task_id" = $3, "correlation_id" = $4, ' +
        '"submitted_at" = $5, "finished_at" = $6, "robots_exemption_id" = $7 ' +
        'where "crawl_id" = $8 and "url" = $9 returning "id"',
    );
    expect(seed?.parameters).toEqual(["captured", null, null, null, null, null, "7", CRAWL, SEED]);
    expect(leaf?.parameters.slice(0, 2)).toEqual(["failed", "timeout"]);
    expect(leaf?.parameters[6]).toBe("7");
  });

  it("欄の無い報告は今までと同じ SQL で、例外の表を引かない", async () => {
    const db = recordingDb([[crawlRow({ maxDepth: 0 })]], withExemptions({}, {}));
    const { app, queries } = await build({ db });
    const res = await reportTo(app, [{ url: SEED, status: "captured" }]);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(closing(queries).map((query) => query.sql)).toEqual([OLD_SQL]);
    expect(queries.some((query) => query.sql.includes("robots_exemption"))).toBe(false);
  });

  it("外した頁と外していない頁が混ざれば、列に触るのは外した頁だけ", async () => {
    const db = recordingDb(
      [[crawlRow({ maxDepth: 0 })]],
      withExemptions({}, { known: [{ id: "7" }] }),
    );
    const { app, queries } = await build({ db });
    await reportTo(app, [
      { url: SEED, status: "captured", robotsExemptionId: "7" },
      { url: LEAF, status: "captured" },
    ]);
    await app.close();
    const [seed, leaf] = closing(queries);
    expect(seed?.sql).toContain('"robots_exemption_id" = $7');
    expect(leaf?.sql).toBe(OLD_SQL);
  });

  it("上限で見送った頁（robots-exemption-limit）は、理由の字のまま閉じ、番号は持たない", async () => {
    const db = recordingDb([[crawlRow({ maxDepth: 0 })]], withExemptions({}, {}));
    const { app, queries } = await build({ db });
    const res = await reportTo(app, [
      { url: SEED, status: "skipped", skipReason: "robots-exemption-limit" },
    ]);
    await app.close();
    expect(res.statusCode).toBe(200);
    const [seed] = closing(queries);
    expect(seed?.sql).toBe(OLD_SQL);
    expect(seed?.parameters.slice(0, 2)).toEqual(["skipped", "robots-exemption-limit"]);
    // 全部を見送ったクロールは failed で締め、文に理由が出る (`crawl/close.ts`)
    const closed = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "stop_reason" = case'),
    );
    expect(closed?.parameters).toContain(
      "1 枚も撮れませんでした（取れず 0・見送り 1）。最初の理由: robots-exemption-limit",
    );
  });

  it("クロールの組織の行でない番号（別の組織の行・無い行）は 400 で、何も書かない", async () => {
    const db = recordingDb(
      [[crawlRow({ maxDepth: 0 })]],
      // 7 は在るが、8 はこの組織に無い
      withExemptions({}, { known: [{ id: "7" }] }),
    );
    const { app, queries } = await build({ db });
    const res = await reportTo(app, [
      { url: SEED, status: "captured", robotsExemptionId: "7" },
      { url: LEAF, status: "captured", robotsExemptionId: "8" },
    ]);
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "robotsExemptionId is not a robots exemption of this crawl's organization",
      robotsExemptionIds: ["8"],
    });
    expect(closing(queries)).toEqual([]);
    expect(queries.some((query) => query.sql.startsWith("insert"))).toBe(false);
  });

  it("番号の字の形が違えば schema の 400（数字だけ・頭に 0 を置かない・18 桁まで）", async () => {
    for (const robotsExemptionId of ["", "0", "07", "7a", "-7", "1".repeat(19)]) {
      const db = recordingDb([[crawlRow()]], withExemptions({}, {}));
      const { app, queries } = await build({ db });
      const res = await reportTo(app, [{ url: SEED, status: "captured", robotsExemptionId }]);
      await app.close();
      expect(res.statusCode, String(robotsExemptionId)).toBe(400);
      expect(queries).toEqual([]);
    }
  });
});
