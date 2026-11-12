/**
 * 段の報告の鍵と段の行 (CAPTURE-180・`038`)。同じ段の報告の 2 回目・鍵の照らし・報告中・取り直し・締めたクロール・
 * 次の段の作り方・`/failed` の照らし・一覧の `dispatch`。
 *
 * 本物の Kysely に SQL を組ませる代役 (`recording-db.ts`) と、段の行に答える係 (`level-responder.ts`) で見る。
 * 並べた行が Postgres で本当にそう返るか (主キーの待ち・期限切れの取り直し) は、使い捨ての Postgres で見る。
 */
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import {
  registerCrawlRoutes,
  type CrawlRouteDeps,
  type DispatchedCrawl,
} from "../src/api/crawls.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import { LEVEL_KEY, levelResponder, type LevelOptions } from "./level-responder.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const FIXTURES = "http://capture-fixtures.capture-ledger:8080";
const SEED = `${FIXTURES}/links/hub`;
const LEAF = `${FIXTURES}/links/leaf/1`;
const HOST = "capture-fixtures.capture-ledger:8080";
const COMPILED = { typescript: "6.0.3", hostTypes: "v0.2.0", scripts: [] };

const crawlRow = (overrides: Record<string, unknown> = {}) => ({
  id: CRAWL,
  seeds: [SEED],
  rules: [{ follow: "same-host" }],
  orgId: "acme",
  requestedBy: "alice",
  state: "running",
  stopReason: null,
  maxDepth: 2,
  maxPages: 20,
  perHostDelayMs: 0,
  hostParallelism: 1,
  pagesDiscovered: 1,
  pagesCaptured: 0,
  artifactKeyPrefix: null,
  scripts: [],
  variables: {},
  secrets: {},
  userAgent: null,
  ...overrides,
});

const build = async (
  results: readonly (readonly object[])[],
  level: LevelOptions = {},
): Promise<{ app: FastifyInstance; queries: RecordedQuery[]; dispatched: DispatchedCrawl[] }> => {
  const { db, queries } = recordingDb(results, levelResponder(level));
  const dispatched: DispatchedCrawl[] = [];
  const s3 = {
    send: () =>
      Promise.resolve({
        Body: {
          transformToString: () => Promise.resolve(JSON.stringify({ links: [{ href: LEAF }] })),
        },
      }),
  };
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  registerCrawlRoutes(app, {
    db,
    fga: { check: () => Promise.resolve({ allowed: true }) },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    dispatch: (crawl: DispatchedCrawl) => {
      dispatched.push(crawl);
      return Promise.resolve(crawl.levelKey);
    },
    s3,
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
    writeReplayBundle: () => Promise.resolve(undefined),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  return { app, queries, dispatched };
};

/** 深さ 0 の段の報告。起点を撮り、葉へのリンクを 1 本持つ。 */
/** `key` が null なら鍵を付けない。 */
const report = (app: FastifyInstance, key: string | null = LEVEL_KEY) =>
  app.inject({
    method: "POST",
    url: `/api/crawls/${CRAWL}/pages`,
    headers: key === null ? SUBJECT : { ...SUBJECT, "idempotency-key": key },
    payload: {
      depth: 0,
      compiled: COMPILED,
      results: [{ url: SEED, status: "captured", linksLocation: "s3://b/hub.links.json" }],
    },
  });

const touched = (queries: RecordedQuery[], prefix: string): boolean =>
  queries.some((query) => query.sql.startsWith(prefix));

describe("段の報告の鍵", () => {
  it("鍵が無ければ 400 で、何も書かない", async () => {
    const { app, queries } = await build([[crawlRow()]]);
    const res = await report(app, null);
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Idempotency-Key header is required (the level_key of this level)",
    });
    expect(queries.some((query) => query.sql.startsWith("update"))).toBe(false);
  });

  it("段の鍵と違えば 422 で、何も書かない（別の段の flow・古い flow の報告。待っても通らない）", async () => {
    const { app, queries } = await build([[crawlRow()]]);
    const res = await report(app, "00000000-0000-4000-8000-000000000000");
    await app.close();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "Idempotency-Key is not the key of this level" });
    expect(queries.some((query) => query.sql.startsWith("update"))).toBe(false);
  });

  it("段の行の無い段は 422（段の行を入れる前に始めたクロール）", async () => {
    const { app } = await build([[crawlRow()]], { missing: true });
    const res = await report(app);
    await app.close();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "no such level of this crawl" });
  });

  it("報告済みの段の 2 回目は、最初の答えを返し、記録もクロールの行も書かず、次の段も投げない", async () => {
    const first = { next: [{ url: LEAF, host: HOST, depth: 1 }], stopReason: null };
    const { app, queries, dispatched } = await build([[crawlRow()]], {
      state: "reported",
      answer: first,
    });
    const res = await report(app);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(first);
    expect(queries.some((query) => query.sql.startsWith("update"))).toBe(false);
    expect(touched(queries, 'insert into "crawl_pages"')).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("報告中（期限の内）の段は 409 で、flow の再試行に任せる", async () => {
    const { app, queries } = await build([[crawlRow()]], { busy: true });
    const res = await report(app);
    await app.close();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "this level is being reported" });
    expect(touched(queries, 'update "crawl_pages"')).toBe(false);
  });

  it("取るときは、投げる前・投げた・受け取り確認済みと、期限の切れた報告中だけを取る", async () => {
    const { app, queries } = await build([
      [crawlRow()],
      [{ id: "11" }], // 報告した行を閉じる
      [], // crawl_decisions
      [{ url: SEED, depth: 0, state: "captured" }], // crawl_pages の URL
      [], // ホストごとの最後の時刻
      [{ url: LEAF, host: HOST }], // 次の段の行 (pending)
    ]);
    await report(app);
    await app.close();
    const claim = queries.find((query) =>
      query.sql.startsWith('update "crawl_levels" set "state" = $1, "report_token" = $2'),
    );
    expect(claim?.sql).toContain('"state" in ($');
    expect(claim?.sql).toContain('"lease_until" <= $');
    expect(claim?.parameters[0]).toBe("reporting");
    // 保管庫を読んだ後に期限を延ばす (頁の多い段でも、生きている試みの期限が切れない)。自分の印のときだけ
    const renewals = queries.filter((query) =>
      query.sql.startsWith('update "crawl_levels" set "lease_until" = $1'),
    );
    expect(renewals.length).toBeGreaterThanOrEqual(1);
    expect(renewals[0]?.sql).toContain('"report_token" = $');
  });
});

describe("終わりの commit", () => {
  const results = [
    [crawlRow()],
    [{ id: "11" }], // 報告した行を閉じる
    [], // crawl_decisions
    [{ url: SEED, depth: 0, state: "captured" }], // crawl_pages の URL
    [], // ホストごとの最後の時刻
    [{ url: LEAF, host: HOST }], // 次の段の行 (pending)
  ];

  it("報告済みにし、答えを保存し、次の段の行を新しい段の鍵で作ってから、その段を投げる", async () => {
    const { app, queries, dispatched } = await build(results);
    const res = await report(app);
    await app.close();
    expect(res.statusCode).toBe(200);
    const answer = { next: [{ url: LEAF, host: HOST, depth: 1 }], stopReason: null };
    expect(res.json()).toEqual(answer);
    const reported = queries.find((query) =>
      query.sql.startsWith('update "crawl_levels" set "state" = $1, "reported_at" = $2'),
    );
    expect(reported?.parameters[0]).toBe("reported");
    expect(reported?.parameters).toContain(JSON.stringify(answer));
    const created = queries.find((query) => query.sql.startsWith('insert into "crawl_levels"'));
    expect(created).toBeDefined();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.depth).toBe(1);
    expect(dispatched[0]?.levelKey).not.toBe(LEVEL_KEY);
    expect(created?.parameters).toContain(dispatched[0]?.levelKey);
    // 全部が 1 つのトランザクションの中
    const sqls = queries.map((query) => query.sql);
    const begin = sqls.indexOf("begin");
    expect(begin).toBeGreaterThan(-1);
    expect(sqls.indexOf(reported!.sql)).toBeGreaterThan(begin);
    expect(sqls.indexOf(created!.sql)).toBeLessThan(sqls.indexOf("commit"));
  });

  it("リンクを 1 本ずつ残す: 次の段のページを入れた後に行を読み、この段のページの行を置き換える（039）", async () => {
    // 行を読むと、葉は起点 (id 11) が見つけた行。起点の行は見つけたページが無い
    const { app, queries } = await build(results, {
      pageParents: [
        { url: SEED, discoveredFrom: null },
        { url: LEAF, discoveredFrom: "11" },
      ],
    });
    const res = await report(app);
    await app.close();
    expect(res.statusCode).toBe(200);
    const sqls = queries.map((query) => query.sql);
    const at = (prefix: string): number => sqls.findIndex((sql) => sql.startsWith(prefix));
    const inserted = at('insert into "crawl_pages"');
    const read = at('select "url", "discovered_from" from "crawl_pages"');
    const removed = at('delete from "crawl_links"');
    const written = at('insert into "crawl_links"');
    // 入れた行を読んでから決める。消してから入れる (足さない)。全部が終わりのトランザクションの中
    expect(inserted).toBeGreaterThan(sqls.indexOf("begin"));
    expect(read).toBeGreaterThan(inserted);
    expect(removed).toBeGreaterThan(read);
    expect(written).toBeGreaterThan(removed);
    expect(written).toBeLessThan(sqls.indexOf("commit"));
    // 消すのは、この段でリンクを読んだページ (起点の行 11) の行だけ
    expect(queries[removed]?.parameters).toEqual([CRAWL, "11"]);
    // 行: クロール・リンクのあったページ・順・URL・ホスト名・文字・規則・どうなったか
    expect(queries[written]?.parameters).toEqual([
      CRAWL,
      "11",
      0,
      LEAF,
      "capture-fixtures.capture-ledger",
      "",
      1,
      "followed",
    ]);
    const stamped = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "links_recorded_at"'),
    );
    expect(stamped?.sql).toContain('"links_recorded_at" is null');
  });

  it("行の無いリンクは、深さの内なら「枚数で切った」と残る", async () => {
    const { app, queries } = await build(results, {
      pageParents: [{ url: SEED, discoveredFrom: null }],
    });
    await report(app);
    await app.close();
    const written = queries.find((query) => query.sql.startsWith('insert into "crawl_links"'));
    expect(written?.parameters.at(-1)).toBe("max_pages");
  });

  it("期限切れで別の試みに取り直されていたら 409 で、報告済みにも次の段にもしない", async () => {
    const { app, queries, dispatched } = await build(results, { superseded: true });
    const res = await report(app);
    await app.close();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "another attempt took over this level report" });
    expect(touched(queries, 'update "crawl_levels" set "state" = $1, "reported_at"')).toBe(false);
    expect(touched(queries, 'insert into "crawl_levels"')).toBe(false);
    expect(queries.map((query) => query.sql)).toContain("rollback");
    expect(dispatched).toEqual([]);
  });

  it("取り直した 2 回目でも、次の段は深さ n+1 の pending の行から作る（入った行が 0 でも途中で完了と読まない）", async () => {
    // 前の試みが葉を pending で入れていた。リンクは全部既知なので、今回入る行は 0
    const { app, queries, dispatched } = await build([
      [crawlRow()],
      [{ id: "11" }],
      [],
      [
        { url: SEED, depth: 0, state: "captured" },
        { url: LEAF, depth: 1, state: "pending" },
      ],
      [], // ホストごとの最後の時刻 (pending の行が在るので、次の段がありうる)
      [{ url: LEAF, host: HOST }], // 次の段の行 (pending)
    ]);
    const res = await report(app);
    await app.close();
    expect(res.json()).toEqual({ next: [{ url: LEAF, host: HOST, depth: 1 }], stopReason: null });
    expect(touched(queries, 'insert into "crawl_pages"')).toBe(false);
    expect(dispatched.map((level) => level.frontier.map((page) => page.url))).toEqual([[LEAF]]);
    // 締めていない
    expect(touched(queries, 'update "crawls" set "stop_reason"')).toBe(false);
  });

  it("数は段の行に書き、クロールの合計は段の行の和で書き直す（足し算をしない）", async () => {
    const { app, queries } = await build(results);
    await report(app);
    await app.close();
    const counts = queries.find((query) =>
      query.sql.startsWith('update "crawl_levels" set "pages_captured" = $1'),
    );
    expect(counts?.parameters.slice(0, 2)).toEqual([1, 1]);
    const totals = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "pages_captured" = $1, "pages_discovered" = $2'),
    );
    expect(totals).toBeDefined();
    expect(
      queries.some((query) => query.sql.includes('"pages_captured" = "pages_captured" +')),
    ).toBe(false);
  });

  it("リンクの記録が在れば、クロールの合計の「見つけた数」は、規則が通した別々の URL の数を書く（段の和ではない）", async () => {
    const { app, queries } = await build(results, { distinctDiscovered: 7 });
    await report(app);
    await app.close();
    const totals = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "pages_captured" = $1, "pages_discovered" = $2'),
    );
    // 撮れた数は段の和 (この段の 1)、見つけた数は別々の URL の数
    expect(totals?.parameters.slice(0, 2)).toEqual([1, 7]);
    // 段の行には、段の数 (この段で規則が通した本数) をそのまま書く
    const counts = queries.find((query) =>
      query.sql.startsWith('update "crawl_levels" set "pages_captured" = $1'),
    );
    expect(counts?.parameters.slice(0, 2)).toEqual([1, 1]);
  });

  it("リンクの記録が無ければ、今までどおり段の和を書く", async () => {
    const { app, queries } = await build(results);
    await report(app);
    await app.close();
    const totals = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "pages_captured" = $1, "pages_discovered" = $2'),
    );
    // 並べたクロールの行の 1 (前の段までの和) に、この段の 1 を足した 2
    expect(totals?.parameters.slice(0, 2)).toEqual([1, 2]);
  });

  it("no_links の判定は段の和で見る: 別々の URL が 0 でも、規則が通したリンクが在れば「リンクなし」にしない", async () => {
    // 最後の段 (次の段の行が無い)。起点へ戻るリンクしか無いと、別々の URL は 0 だが、通したリンクは 1 本在る
    const { app } = await build(
      [
        [crawlRow({ pagesDiscovered: 0 })],
        [{ id: "11" }],
        [],
        [
          { url: SEED, depth: 0, state: "captured" },
          { url: LEAF, depth: 1, state: "captured" },
        ],
        [],
      ],
      { distinctDiscovered: 0 },
    );
    const res = await report(app);
    await app.close();
    expect(res.json()).toEqual({ next: [], stopReason: "completed" });
  });
});

describe("締めたクロールに届いた段の報告（CAPTURE-77）", () => {
  it("締めた段の報告はページを記録するが、状態は書かず、次の段の行を作らず、投げない", async () => {
    const { app, queries, dispatched } = await build(
      [
        [crawlRow({ state: "failed", stopReason: "failed" })],
        [{ id: "11" }], // 報告した行を閉じる (ページは記録する)
        [], // crawl_decisions
      ],
      { state: "abandoned" },
    );
    const res = await report(app);
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: [], stopReason: "failed" });
    expect(touched(queries, 'update "crawl_pages"')).toBe(true);
    expect(touched(queries, 'update "crawl_levels" set "state"')).toBe(false);
    expect(touched(queries, 'insert into "crawl_levels"')).toBe(false);
    expect(touched(queries, 'insert into "crawl_pages"')).toBe(false);
    expect(touched(queries, 'update "crawls" set "stop_reason"')).toBe(false);
    expect(dispatched).toEqual([]);
    // リンクは残す。規則が通しても次の段に入らないので「締まっていた」(039)
    const written = queries.find((query) => query.sql.startsWith('insert into "crawl_links"'));
    expect(written?.parameters.at(-1)).toBe("closed");
  });
});

describe("/failed の照らし", () => {
  const fail = async (body: object, newestDepth = 0) => {
    const { app, queries } = await build([[{ id: CRAWL }]], { newestDepth });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/failed`,
      headers: SUBJECT,
      payload: body,
    });
    await app.close();
    return { res, queries };
  };

  it("一番新しい段の鍵なら締め、一番新しい段を「締めた」にする", async () => {
    const { res, queries } = await fail({ reason: "boom", depth: 0, levelKey: LEVEL_KEY });
    expect(res.json()).toEqual({ closed: true });
    const abandon = queries.find((query) =>
      query.sql.startsWith('update "crawl_levels" set "state" = $1'),
    );
    expect(abandon?.parameters[0]).toBe("abandoned");
    expect(abandon?.sql).toContain("max(");
  });

  it("古い段の flow の失敗では締めない（次の段を撮っている健全なクロール）", async () => {
    const { res, queries } = await fail({ reason: "boom", depth: 0, levelKey: LEVEL_KEY }, 1);
    expect(res.json()).toEqual({ closed: false });
    expect(touched(queries, 'update "crawls"')).toBe(false);
  });

  it("鍵の違う失敗では締めない（同じ深さを手で流し直した別の run）", async () => {
    const { res } = await fail({
      reason: "boom",
      depth: 0,
      levelKey: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.json()).toEqual({ closed: false });
  });

  it("鍵の無い要求は人の「締める」として、いまどおり締める", async () => {
    const { res } = await fail({ reason: "手で締めた" }, 3);
    expect(res.json()).toEqual({ closed: true });
  });

  it("depth と levelKey は揃って来る（片方だけは 400）", async () => {
    expect((await fail({ depth: 0 })).res.statusCode).toBe(400);
    expect((await fail({ levelKey: LEVEL_KEY })).res.statusCode).toBe(400);
  });
});

describe("一覧と 1 本の dispatch", () => {
  it("一番新しい段の深さ・状態・送った回数・最後の誤りを、段の行から 1 つの副問い合わせで読む", async () => {
    const dispatch = { depth: 1, state: "sent", attempts: 3, lastError: "crawl webhook → 502" };
    const { app, queries } = await build([[{ ...crawlRow(), dispatch }]]);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${CRAWL}`, headers: SUBJECT });
    await app.close();
    expect(res.json<{ dispatch: unknown }>().dispatch).toEqual(dispatch);
    expect(queries[0]?.sql).toContain("from crawl_levels l where l.crawl_id = crawls.id");
    expect(queries[0]?.sql).toContain("order by l.depth desc limit 1");
  });
});
