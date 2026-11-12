/**
 * 規則が決めたことを残す・読む・確かめるエンドポイント。
 *
 * 本物の Kysely に SQL を組ませ、実行の直前で取り上げる代役 (`recording-db.ts`) で見る。返す行は
 * 問い合わせの順に試験が並べた物から渡すので、**SQL が Postgres で本当に通るか・数が本当に置き換わるか**は
 * ここでは言えない —— それは開発の DB で確かめる (この repo に DB の試験は無い)。ここで見るのは配線:
 * 規則で分けた物が表と次の段の両方に届くか、エンドポイントが認可と言い分を守るか。
 */
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import {
  registerCrawlRoutes,
  type CrawlRouteDeps,
  type DispatchedCrawl,
} from "../src/api/crawls.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import { WindmillUnreachable, type WindmillVariables } from "../src/crawl/windmill-variables.js";
import type { CrawlRule, CrawlSecret } from "../src/db/database.js";
import { LEVEL_KEY, levelResponder, type LevelOptions } from "./level-responder.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const FIXTURES = "http://capture-fixtures.capture-ledger:8080";
const COMPILED = { typescript: "6.0.3", hostTypes: "v0.2.0", scripts: [] };

const crawlRow = (
  rules: CrawlRule[],
  seeds: string[],
  values: {
    variables?: Record<string, string>;
    secrets?: Record<string, CrawlSecret>;
    userAgent?: string;
  } = {},
) => ({
  id: CRAWL,
  seeds,
  rules,
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
  // 本物の行は必ず持つ (024 の NOT NULL DEFAULT)。偽物も同じ形で
  variables: values.variables ?? {},
  secrets: values.secrets ?? {},
  userAgent: values.userAgent ?? null,
});

interface Built {
  app: FastifyInstance;
  queries: RecordedQuery[];
  /** S3 から読んだ鍵。リンクを見ないページは、ここに出ない。 */
  read: string[];
  /** 次の段として flow へ投げた物。 */
  dispatched: DispatchedCrawl[];
}

const build = async (opts: {
  /** 段の行の答え方 (`level-responder.ts`)。省けば受け取り確認済みの段 */
  level?: LevelOptions;
  results?: readonly (readonly object[])[];
  allowed?: boolean;
  links?: Record<string, unknown>;
  /** Windmill の変数のクライアント。省けば無い配備 (読み直しをしない)。 */
  windmill?: WindmillVariables;
}): Promise<Built> => {
  const { db, queries } = recordingDb(opts.results, levelResponder(opts.level));
  const read: string[] = [];
  const dispatched: DispatchedCrawl[] = [];
  const s3 = {
    send: (command: { input: { Key: string } }) => {
      read.push(command.input.Key);
      const body = opts.links?.[command.input.Key];
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(body ?? {})) },
      });
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
    dispatch: (crawl: DispatchedCrawl) => {
      dispatched.push(crawl);
      return Promise.resolve(undefined);
    },
    s3,
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
    ...(opts.windmill && { windmill: opts.windmill }),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  return { app, queries, read, dispatched };
};

const sqlOf = (queries: RecordedQuery[], table: string): RecordedQuery | undefined =>
  queries.find((q) => q.sql.includes(`"${table}"`) || q.sql.includes(` ${table}`));

describe("段の報告で、規則が決めたことを残す", () => {
  // e2e と同じ並び。外の 2 つのホストは .invalid
  const rules: CrawlRule[] = [
    { skip: "skipped.invalid" },
    { skip: `${FIXTURES}/links/trap/` },
    { follow: "same-host" },
    { capture: "any" },
  ];
  const seed = `${FIXTURES}/links/rules`;

  it("リンクを規則で分け、落とした物は表にだけ、辿る物と撮るだけの物は次の段に入れる", async () => {
    const { app, queries, read } = await build({
      results: [
        [crawlRow(rules, [seed])], // クロールの行
        [{ id: "11" }], // 報告した行を閉じる (returning id)
        [], // crawl_decisions
        [{ url: seed }], // crawl_pages の URL
        [], // 次の段の行
        [], // crawls の集計
      ],
      links: {
        "rules.links.json": {
          links: [
            { href: `${FIXTURES}/links/leaf/1` },
            { href: `${FIXTURES}/links/leaf/1#again` },
            { href: `${FIXTURES}/links/trap/1` },
            { href: "http://skipped.invalid/page" },
            { href: "http://outside.invalid/page" },
            { href: `${FIXTURES}/links/leaf/2`, rel: "nofollow" },
          ],
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: {
        depth: 0,
        compiled: COMPILED,
        results: [{ url: seed, status: "captured", linksLocation: "s3://b/rules.links.json" }],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(read).toEqual(["rules.links.json"]);

    // 決めたことは段 × 規則 × ホスト名で 1 行。同じ URL は 1 本、nofollow は数えない
    const decisions = sqlOf(queries, "crawl_decisions");
    expect(decisions?.sql).toContain(
      'on conflict ("crawl_id", "depth", "rule", "hostname") do update set ' +
        '"action" = "excluded"."action", "links" = "excluded"."links", "samples" = "excluded"."samples"',
    );
    // 行は見つけた順
    expect(decisions?.parameters).toEqual([
      CRAWL,
      1,
      3,
      "follow",
      "capture-fixtures.capture-ledger",
      1,
      [`${FIXTURES}/links/leaf/1`],
      CRAWL,
      1,
      2,
      "skip",
      "capture-fixtures.capture-ledger",
      1,
      [`${FIXTURES}/links/trap/1`],
      CRAWL,
      1,
      1,
      "skip",
      "skipped.invalid",
      1,
      ["http://skipped.invalid/page"],
      CRAWL,
      1,
      4,
      "capture",
      "outside.invalid",
      1,
      ["http://outside.invalid/page"],
    ]);

    // 次の段に入れるのは辿る物と撮るだけの物。見つけたページの行の id を残す
    const next = queries.find((q) => q.sql.startsWith('insert into "crawl_pages"'));
    expect(next?.parameters).toEqual([
      CRAWL,
      `${FIXTURES}/links/leaf/1`,
      1,
      "capture-fixtures.capture-ledger:8080",
      "11",
      "pending",
      CRAWL,
      "http://outside.invalid/page",
      1,
      "outside.invalid",
      "11",
      "pending",
    ]);
  });

  it("最後の段にも links を頼む", async () => {
    // **最後でも数える。** 頼まないと、次に撮る物が残っているかどうかを言えない
    const { app, dispatched } = await build({
      results: [
        [{ ...crawlRow([{ follow: "same-host" }], [seed]), maxDepth: 1 }], // クロールの行
        [{ id: "11" }], // 報告した行を閉じる
        [], // crawl_decisions
        [{ url: seed }], // crawl_pages の URL
        [], // ホストごとの最後の時刻 (次の段がありうるので、終わりの commit の前に引く)
        [{ url: `${FIXTURES}/links/leaf/1`, host: "capture-fixtures.capture-ledger:8080" }], // 次の段の行
      ],
      links: { "hub.links.json": { links: [{ href: `${FIXTURES}/links/leaf/1` }] } },
    });
    await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: {
        depth: 0,
        compiled: COMPILED,
        results: [{ url: seed, status: "captured", linksLocation: "s3://b/hub.links.json" }],
      },
    });
    await app.close();
    expect(dispatched.map((crawl) => [crawl.depth, crawl.captureFormats.links])).toEqual([
      [1, true],
    ]);
  });

  it("撮るだけのページのリンクは読まず、何も残さない", async () => {
    const { app, queries, read } = await build({
      results: [
        [crawlRow(rules, [seed])],
        [{ id: "12" }],
        [
          { url: seed },
          { url: `${FIXTURES}/links/leaf/1` },
          { url: "http://outside.invalid/page" },
        ],
        [], // crawls の集計 (次が無いので締める)
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: {
        depth: 1,
        compiled: COMPILED,
        results: [
          {
            url: "http://outside.invalid/page",
            status: "captured",
            linksLocation: "s3://b/outside.links.json",
          },
        ],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(read).toEqual([]);
    expect(sqlOf(queries, "crawl_decisions")).toBeUndefined();
  });

  it("外へ跳ばされたページのリンクは、頼んだ URL が辿る範囲でも読まない", async () => {
    // 同じホストのリンクが外へリダイレクトした。読めば、撮るだけのはずの外のページのリンクが次の段に入る
    const { app, queries, read } = await build({
      results: [
        [crawlRow(rules, [seed])],
        [{ id: "13" }],
        [{ url: seed }, { url: `${FIXTURES}/links/moved` }],
        [], // crawls の集計 (次が無いので締める)
      ],
      links: {
        "moved.links.json": {
          url: `${FIXTURES}/links/moved`,
          finalUrl: "http://outside.invalid/landed",
          links: [{ href: "http://elsewhere.invalid/next" }, { href: `${FIXTURES}/links/leaf/1` }],
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: {
        depth: 1,
        compiled: COMPILED,
        results: [
          {
            url: `${FIXTURES}/links/moved`,
            status: "captured",
            linksLocation: "s3://b/moved.links.json",
          },
        ],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(read).toEqual(["moved.links.json"]);
    expect(sqlOf(queries, "crawl_decisions")).toBeUndefined();
    expect(queries.find((q) => q.sql.startsWith('insert into "crawl_pages"'))).toBeUndefined();
  });

  it("行の規則が読めなければ 500 で、何も書かない", async () => {
    const { app, queries } = await build({
      results: [[crawlRow([{ follow: "*.site.test" }], [seed])]],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: { depth: 0, compiled: COMPILED, results: [] },
    });
    await app.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "a crawl rule is not readable" });
    // クロールの行を読んだだけ (段の行は、鍵を照らして取り、落ちたので手放した)
    expect(queries.filter((q) => !q.sql.includes('"crawl_levels"'))).toHaveLength(1);
  });
});

/**
 * 次の段を送る前に、シークレットの更新時刻を読み直す。替わっていても続けるが、気づいた段と新しい時刻を行に残す。
 * 値は読まない (`meta` は `decrypt_secret=false`。`windmill-variables.test.ts`)。
 */
describe("次の段を送る前に、シークレットの更新時刻を読み直す", () => {
  const rules: CrawlRule[] = [{ follow: "same-host" }];
  const seed = `${FIXTURES}/links/rules`;
  const PATH = "f/waggle_secrets/api_token";
  const AT_START = "2026-11-01T00:00:00.000000Z";
  const LATER = "2026-11-01T06:00:00.000000Z";
  const secrets = (): Record<string, CrawlSecret> => ({
    api_token: { path: PATH, editedAt: AT_START, rotated: null },
  });
  /** 段の報告 1 回分の DB の答え。次の段が 1 本在るので、読み直しと投げる所まで進む。 */
  const results = (row: object) => [
    [row], // クロールの行
    [{ id: "11" }], // 報告した行を閉じる (returning id)
    [], // crawl_decisions
    [{ url: seed }], // crawl_pages の URL
    [], // ホストごとの最後の時刻 (次の段がありうるので、終わりの commit の前に引く)
    // (替わっていれば) secrets の更新は level-responder が答える
    [{ url: `${FIXTURES}/links/leaf/1`, host: "capture-fixtures.capture-ledger:8080" }], // 次の段の行
  ];
  const links = { "rules.links.json": { links: [{ href: `${FIXTURES}/links/leaf/1` }] } };
  const report = (built: Built) =>
    built.app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: {
        depth: 0,
        compiled: COMPILED,
        results: [{ url: seed, status: "captured", linksLocation: "s3://b/rules.links.json" }],
      },
    });
  const asked: string[] = [];
  const windmillAnswering = (editedAt: string | Error): WindmillVariables => ({
    exists: () => Promise.resolve(true),
    meta: (path) => {
      asked.push(path);
      return editedAt instanceof Error
        ? Promise.reject(editedAt)
        : Promise.resolve({ isSecret: true, editedAt });
    },
  });
  const secretsUpdate = (queries: RecordedQuery[]) =>
    queries.find((q) => q.sql.startsWith('update "crawls" set "secrets"'));

  it("替わっていれば rotated に気づいた段と新しい時刻を書き、次の段は送る（止めない）", async () => {
    asked.length = 0;
    const built = await build({
      results: results(crawlRow(rules, [seed], { variables: { query: "x" }, secrets: secrets() })),
      links,
      windmill: windmillAnswering(LATER),
    });
    const res = await report(built);
    await built.app.close();
    expect(res.statusCode).toBe(200);
    expect(asked).toEqual([PATH]);
    const update = secretsUpdate(built.queries);
    expect(update?.sql).toBe('update "crawls" set "secrets" = $1 where "id" = $2');
    expect(update?.parameters).toEqual([
      JSON.stringify({
        api_token: { path: PATH, editedAt: AT_START, rotated: { depth: 1, editedAt: LATER } },
      }),
      CRAWL,
    ]);
    // 投げる本文は行に固定した値と、名前 → path。更新時刻は flow に要らない
    expect(built.dispatched[0]).toMatchObject({
      depth: 1,
      variables: { query: "x" },
      secrets: { api_token: PATH },
    });
  });

  it("読み直して rotated を書いても archive は消えず、次の段の secret_archive に載る（行の写しから組む）", async () => {
    const NOTE = "f/waggle_secrets/note";
    const built = await build({
      results: results(
        crawlRow(rules, [seed], {
          secrets: {
            api_token: { path: PATH, editedAt: AT_START, rotated: null },
            note: { path: NOTE, editedAt: AT_START, rotated: null, archive: "keep" },
          },
        }),
      ),
      links,
      windmill: windmillAnswering(LATER),
    });
    const res = await report(built);
    await built.app.close();
    expect(res.statusCode).toBe(200);
    expect(secretsUpdate(built.queries)?.parameters).toEqual([
      JSON.stringify({
        api_token: { path: PATH, editedAt: AT_START, rotated: { depth: 1, editedAt: LATER } },
        note: {
          path: NOTE,
          editedAt: AT_START,
          rotated: { depth: 1, editedAt: LATER },
          archive: "keep",
        },
      }),
      CRAWL,
    ]);
    expect(built.dispatched[0]).toMatchObject({
      depth: 1,
      secrets: { api_token: PATH, note: NOTE },
      secretArchive: { note: "keep" },
    });
  });

  it("次の段にも、行に固定した User-Agent を打った字のまま配る。無ければ空の字", async () => {
    const asked = await build({
      results: results(crawlRow(rules, [seed], { userAgent: "{chrome} BrowserHive" })),
      links,
      windmill: windmillAnswering(LATER),
    });
    expect((await report(asked)).statusCode).toBe(200);
    await asked.app.close();
    expect(asked.dispatched[0]).toMatchObject({ depth: 1, userAgent: "{chrome} BrowserHive" });

    const none = await build({
      results: results(crawlRow(rules, [seed])),
      links,
      windmill: windmillAnswering(LATER),
    });
    expect((await report(none)).statusCode).toBe(200);
    await none.app.close();
    expect(none.dispatched[0]).toMatchObject({ depth: 1, userAgent: "" });
  });

  it("同じ時刻なら何も書かない。前に気づいた時刻と同じでも書き直さない", async () => {
    const same = await build({
      results: results(crawlRow(rules, [seed], { secrets: secrets() })),
      links,
      windmill: windmillAnswering(AT_START),
    });
    expect((await report(same)).statusCode).toBe(200);
    await same.app.close();
    expect(secretsUpdate(same.queries)).toBeUndefined();

    const noted = await build({
      results: results(
        crawlRow(rules, [seed], {
          secrets: {
            api_token: { path: PATH, editedAt: AT_START, rotated: { depth: 1, editedAt: LATER } },
          },
        }),
      ),
      links,
      windmill: windmillAnswering(LATER),
    });
    expect((await report(noted)).statusCode).toBe(200);
    await noted.app.close();
    expect(secretsUpdate(noted.queries)).toBeUndefined();
  });

  it("Windmill に訊けなければ、書かずにそのまま送る（flow が解けなければ fail_crawl が締める）", async () => {
    const built = await build({
      results: results(crawlRow(rules, [seed], { secrets: secrets() })),
      links,
      windmill: windmillAnswering(new WindmillUnreachable("connect ECONNREFUSED")),
    });
    expect((await report(built)).statusCode).toBe(200);
    await built.app.close();
    expect(secretsUpdate(built.queries)).toBeUndefined();
    expect(built.dispatched[0]?.secrets).toEqual({ api_token: PATH });
  });

  it("シークレットが無いクロールでは Windmill に訊かない", async () => {
    asked.length = 0;
    const built = await build({
      results: results(crawlRow(rules, [seed])),
      links,
      windmill: windmillAnswering(LATER),
    });
    expect((await report(built)).statusCode).toBe(200);
    await built.app.close();
    expect(asked).toEqual([]);
    expect(built.dispatched[0]).toMatchObject({ variables: {}, secrets: {}, secretArchive: {} });
  });
});

describe("クロール 1 本の判断を読む", () => {
  const rules: CrawlRule[] = [{ skip: "skipped.invalid" }, { follow: "same-host" }];
  const decided = [
    {
      depth: 1,
      rule: 1,
      action: "skip",
      hostname: "skipped.invalid",
      links: 1,
      samples: ["http://skipped.invalid/page"],
    },
  ];
  const robots = [
    {
      hostname: "capture-fixtures.capture-ledger",
      pages: 1,
      samples: [`${FIXTURES}/links/hidden`],
    },
  ];

  it("固定した規則と、段 × 規則 × ホスト名の数と、robots.txt で取らなかったページを返す", async () => {
    const { app, queries } = await build({
      results: [[{ id: CRAWL, rules }], decided, robots],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/crawls/${CRAWL}/decisions`,
      headers: SUBJECT,
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ crawlId: CRAWL, rules, decisions: decided, robots });

    expect(queries[1]?.sql).toBe(
      'select "depth", "rule", "action", "hostname", "links", "samples" from "crawl_decisions" ' +
        'where "crawl_id" = $1 order by "depth", "rule", "hostname"',
    );
    // robots で見送った行だけ。ホスト名はポートを外して表と揃え、例は 10 本まで
    const robotsSql = queries[2]?.sql ?? "";
    expect(robotsSql).toContain("state = 'skipped' and skip_reason = 'robots'");
    expect(robotsSql).toContain("regexp_replace(host, ':[0-9]+$', '')");
    expect(robotsSql).toContain("[1:10]");
    expect(queries[2]?.parameters).toEqual([CRAWL]);
  });

  it("無いクロールは 404", async () => {
    const { app } = await build({ results: [[]] });
    const res = await app.inject({
      method: "GET",
      url: `/api/crawls/${CRAWL}/decisions`,
      headers: SUBJECT,
    });
    await app.close();
    expect(res.statusCode).toBe(404);
  });

  it("許可が無ければ 404 で、DB を引かない", async () => {
    const { app, queries } = await build({ allowed: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/crawls/${CRAWL}/decisions`,
      headers: SUBJECT,
    });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(queries).toEqual([]);
  });
});

describe("ドメインで、クロールを跨いで判断を引く", () => {
  const get = async (query: string, opts: Parameters<typeof build>[0] = {}) => {
    const built = await build(opts);
    const res = await built.app.inject({
      method: "GET",
      url: `/api/decisions?${query}`,
      headers: SUBJECT,
    });
    await built.app.close();
    return { res, queries: built.queries };
  };
  const row = (rule: number, hostname: string) => ({
    crawlId: CRAWL,
    startedAt: "2026-10-25T00:00:00.000Z",
    seeds: [`${FIXTURES}/links/rules`],
    rules: [{ skip: "skipped.invalid" }, { follow: "same-host" }],
    rule,
    action: "skip",
    hostname,
    links: 2,
  });

  it("そのドメインとその下を、ラベルの境目で照らし、当たった規則の当てる物を添える", async () => {
    const { res, queries } = await get("domain=skipped.invalid", {
      results: [[row(1, "skipped.invalid"), row(0, "a.skipped.invalid")]],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      decisions: [
        {
          crawlId: CRAWL,
          startedAt: "2026-10-25T00:00:00.000Z",
          seeds: [`${FIXTURES}/links/rules`],
          rule: 1,
          action: "skip",
          pattern: "skipped.invalid",
          hostname: "skipped.invalid",
          links: 2,
        },
        {
          crawlId: CRAWL,
          startedAt: "2026-10-25T00:00:00.000Z",
          seeds: [`${FIXTURES}/links/rules`],
          rule: 0,
          action: "skip",
          pattern: null,
          hostname: "a.skipped.invalid",
          links: 2,
        },
      ],
      truncated: false,
    });
    // 既定は落とした物を 90 日。LIKE は「.」から始めるので badskipped.invalid は当たらない
    expect(queries[0]?.sql).toContain("(d.hostname = $2 or d.hostname like $3)");
    expect(queries[0]?.parameters).toEqual(["skip", "skipped.invalid", "%.skipped.invalid", 90]);
  });

  it("行が上限を超えたら、上限で切って truncated と言う", async () => {
    const many = Array.from({ length: 501 }, (_, i) => row(1, `h${String(i)}.skipped.invalid`));
    const { res } = await get("domain=skipped.invalid&action=skip&days=7", { results: [many] });
    const body = res.json<{ decisions: unknown[]; truncated: boolean }>();
    expect(body.decisions).toHaveLength(500);
    expect(body.truncated).toBe(true);
  });

  it("規則のドメインとして読めない domain は 400 で、許可を見る前に断る", async () => {
    for (const domain of ["ADS.site.test", "%25.site.test", "a_b.site.test", "site.test:443"]) {
      const { res, queries } = await get(`domain=${domain}`, { allowed: false });
      expect(res.statusCode, domain).toBe(400);
      expect(res.json(), domain).toEqual({ error: "invalid domain" });
      expect(queries).toEqual([]);
    }
  });

  it("days と action の外れは schema の 400", async () => {
    expect((await get("domain=a.invalid&days=0")).res.statusCode).toBe(400);
    expect((await get("domain=a.invalid&days=3651")).res.statusCode).toBe(400);
    expect((await get("domain=a.invalid&action=drop")).res.statusCode).toBe(400);
    expect((await get("days=7")).res.statusCode).toBe(400);
  });

  it("許可が無ければ空で、DB を引かない", async () => {
    const { res, queries } = await get("domain=skipped.invalid", { allowed: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ decisions: [], truncated: false });
    expect(queries).toEqual([]);
  });
});

describe("始める前に規則を確かめる", () => {
  const check = async (query: string, allowed = true) => {
    const built = await build({ allowed });
    const res = await built.app.inject({
      method: "GET",
      url: `/api/crawl-rules/check?${query}`,
      headers: SUBJECT,
    });
    await built.app.close();
    return { res, queries: built.queries };
  };
  const q = (pairs: [string, string][]) =>
    pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  it("行ごとに読めたか・覆われているか、起点ごとにサイトと辿るかを返し、DB は引かない", async () => {
    const { res, queries } = await check(
      q([
        ["seed", "https://www.site.test/"],
        ["rule", "follow:same-site"],
        ["rule", "skip:ads.site.test"],
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      seeds: [{ url: "https://www.site.test/", valid: true, site: "site.test", followed: true }],
      rules: [
        { rule: 1, action: "follow", kind: "scope", pattern: "same-site" },
        { rule: 2, action: "skip", kind: "domain", pattern: "ads.site.test", coveredBy: 1 },
      ],
      ok: false,
    });
    expect(queries).toEqual([]);
  });

  it("前方一致は書き残す形（正規化した URL）で返し、当てる物の : は最初の 1 つで切る", async () => {
    const { res } = await check(
      q([
        ["seed", "https://www.site.test/"],
        ["rule", "skip:HTTPS://WWW.Site.test:443/search"],
        ["rule", "follow:same-site"],
      ]),
    );
    expect(res.json()).toMatchObject({
      rules: [
        { rule: 1, action: "skip", kind: "prefix", pattern: "https://www.site.test/search" },
        { rule: 2, action: "follow", kind: "scope", pattern: "same-site" },
      ],
      ok: true,
    });
  });

  it("読めない規則は invalid で頼まれたまま、読めない起点は valid: false で、ok は false", async () => {
    const { res } = await check(
      q([
        ["seed", "not a url"],
        ["rule", "skip:ADS.site.test"],
      ]),
    );
    expect(res.json()).toEqual({
      seeds: [{ url: "not a url", valid: false }],
      rules: [{ rule: 1, action: "skip", kind: "invalid", pattern: "ADS.site.test" }],
      ok: false,
    });
  });

  it("起点を辿らない並びは、その起点を followed: false で返す", async () => {
    const { res } = await check(
      q([
        ["seed", "https://ads.site.test/"],
        ["rule", "skip:ads.site.test"],
        ["rule", "follow:same-site"],
      ]),
    );
    expect(res.json()).toMatchObject({
      seeds: [{ url: "https://ads.site.test/", followed: false }],
      ok: false,
    });
  });

  it("動きの名前が違う・33 本は schema の 400", async () => {
    expect((await check(q([["rule", "crawl:same-host"]]))).res.statusCode).toBe(400);
    const many = Array.from({ length: 33 }, (): [string, string] => ["rule", "follow:any"]);
    expect((await check(q(many))).res.statusCode).toBe(400);
  });

  it("許可が無ければ 404", async () => {
    expect((await check(q([["rule", "follow:any"]]), false)).res.statusCode).toBe(404);
  });
});

/**
 * 段の報告で締めるのは、走っているクロールだけ (CAPTURE-61)。`/failed` や投げられなかった段で failed に締めた後に
 * 段の報告が届いても、succeeded に戻さない —— 戻すと、failed で締めて署名した合本と、行の状態が食い違う。
 *
 * 条件は行の更新の中に在る (読んだ時の状態で決めると、読んだ後・書く前に締められた行を戻す)。ここで見るのは
 * 組まれた SQL の形で、Postgres が本当に戻さないかは開発の DB で確かめる (この repo に DB の試験は無い)。
 */
describe("段の報告で締めるのは、走っているクロールだけ", () => {
  const seed = `${FIXTURES}/links/rules`;

  /** 次の段が無い報告 (リンクを読まない) を投げ、最後の crawls の UPDATE を返す。 */
  const closeByReport = async (
    state: string,
  ): Promise<{
    body: unknown;
    update: RecordedQuery | undefined;
    counts: RecordedQuery | undefined;
  }> => {
    const { app, queries } = await build({
      results: [
        [{ ...crawlRow([{ follow: "same-host" }], [seed]), state }], // クロールの行
        [{ id: "11" }], // 報告した行を閉じる
        [{ url: seed }], // crawl_pages の URL
        [], // 次の段の行 (pending)
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: { depth: 0, compiled: COMPILED, results: [{ url: seed, status: "captured" }] },
    });
    await app.close();
    return {
      body: res.json(),
      update: queries.find((query) => query.sql.startsWith('update "crawls" set "stop_reason"')),
      counts: queries.find((query) =>
        query.sql.startsWith('update "crawl_levels" set "pages_captured"'),
      ),
    };
  };

  it("succeeded と終わった時刻は、行が running のときだけ書く（数は段の行に書く）", async () => {
    const { body, update, counts } = await closeByReport("running");
    expect(body).toEqual({ next: [], stopReason: "completed" });
    // 読んだ後・書く前に締められた行もあるので、条件は更新の中で見る
    expect(update?.sql).toBe(
      'update "crawls" set "stop_reason" = coalesce("stop_reason", $1), ' +
        '"state" = case when "state" = $2 then $3 else "state" end, ' +
        '"finished_at" = case when "state" = $4 then $5 else "finished_at" end where "id" = $6',
    );
    expect(update?.parameters.slice(0, 4)).toEqual([
      "completed",
      "running",
      "succeeded",
      "running",
    ]);
    expect(update?.parameters[5]).toBe(CRAWL);
    // 段の数は足さずに書く (CAPTURE-180)。クロールの合計は段の行の和で書き直す
    expect(counts?.parameters.slice(0, 2)).toEqual([1, 0]);
  });

  it("読んだ時に締めてあったクロールには、状態を書かない（ページは記録し、次の段は作らない）", async () => {
    const { body, update } = await closeByReport("failed");
    expect(body).toEqual({ next: [], stopReason: null });
    expect(update).toBeUndefined();
  });
});

/**
 * 切った物があるときだけ、打ち切りと言う。まだ撮っていない候補が残っていなければ、深さや枚数の上限に当たっていても
 * 切っていない。**既に行のある URL は `crawl_pages` の答えとして並べる** —— この代役は SQL を流さないので、
 * 既知の URL を除くかどうかは、ここに並べた行と、報告したリンクの組で見える。
 */
describe("切った物があるときだけ、打ち切りと言う", () => {
  const seed = `${FIXTURES}/start`;
  const page = `${FIXTURES}/a`;
  const unseen = `${FIXTURES}/b`;
  const HOST = "capture-fixtures.capture-ledger:8080";

  /** `page` を撮った報告を投げる。そのページのリンクが `hrefs`、既に行のある URL が `known`。 */
  const reportPage = async (opts: {
    depth: number;
    maxDepth: number;
    maxPages?: number;
    /** 前の段までに行に残った理由。 */
    rowReason?: string;
    /** 前の段までに規則が通したリンクの延べ（既定は crawlRow の値）。 */
    pagesDiscovered?: number;
    hrefs: string[];
    known: string[];
    /** 次の段に入ると見込む行。 */
    inserted?: string[];
  }) => {
    const { app, queries } = await build({
      results: [
        [
          {
            ...crawlRow([{ follow: "same-host" }], [seed]),
            maxDepth: opts.maxDepth,
            maxPages: opts.maxPages ?? 20,
            stopReason: opts.rowReason ?? null,
            ...(opts.pagesDiscovered !== undefined && { pagesDiscovered: opts.pagesDiscovered }),
          },
        ], // クロールの行
        [{ id: "11" }], // 報告した行を閉じる
        ...(opts.hrefs.length > 0 ? [[]] : []), // crawl_decisions
        opts.known.map((url) => ({ url })), // crawl_pages の URL
        // 次の段の候補があれば、終わりの commit の前にホストごとの最後の時刻を引く。その後に次の段の行 (pending)
        ...(opts.inserted === undefined
          ? [[]]
          : [[], opts.inserted.map((url) => ({ url, host: HOST }))]),
      ],
      links: { "page.links.json": { links: opts.hrefs.map((href) => ({ href })) } },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: { ...SUBJECT, "idempotency-key": LEVEL_KEY },
      payload: {
        depth: opts.depth,
        compiled: COMPILED,
        results: [{ url: page, status: "captured", linksLocation: "s3://b/page.links.json" }],
      },
    });
    await app.close();
    return {
      body: res.json<{ next: { url: string }[]; stopReason: string | null }>(),
      queries,
      update: queries.find((query) => query.sql.startsWith('update "crawls" set "stop_reason"')),
      insert: queries.find((query) => query.sql.startsWith('insert into "crawl_pages"')),
      /** 段に書いた撮れた数・リンクの数 (CAPTURE-180) と、クロールに残した理由 */
      summary: [
        ...(queries
          .find((query) => query.sql.startsWith('update "crawl_levels" set "pages_captured"'))
          ?.parameters.slice(0, 2) ?? []),
        queries.find((query) => query.sql.startsWith('update "crawls" set "stop_reason"'))
          ?.parameters[0],
      ],
    };
  };

  it("最後の段のリンクが既に行のある URL だけなら、切っていない", async () => {
    const { body, queries, summary, insert } = await reportPage({
      depth: 1,
      maxDepth: 1,
      hrefs: [seed],
      known: [seed, page],
    });
    expect(body).toEqual({ next: [], stopReason: "completed" });
    expect(insert).toBeUndefined();
    // 撮れた 1・リンク 1。**リンクは既知の URL も数える** (延べ)
    expect(summary).toEqual([1, 1, "completed"]);
    expect(queries.map((query) => query.sql)).toContain(
      'select "url", "depth", "state" from "crawl_pages" where "crawl_id" = $1',
    );
  });

  it("最後の段に新しい URL があれば、深さで切った", async () => {
    const { body, summary, insert } = await reportPage({
      depth: 1,
      maxDepth: 1,
      hrefs: [seed, unseen],
      known: [seed, page],
    });
    expect(body).toEqual({ next: [], stopReason: "max_depth" });
    expect(insert).toBeUndefined();
    expect(summary).toEqual([1, 2, "max_depth"]);
  });

  it("リンクが無ければ、深さ 0 でも切っていない", async () => {
    const { body, summary } = await reportPage({ depth: 0, maxDepth: 0, hrefs: [], known: [page] });
    expect(body).toEqual({ next: [], stopReason: "completed" });
    expect(summary).toEqual([1, 0, "completed"]);
  });

  describe("辿るよう頼んだのにリンクが 1 本も無ければ no_links（CAPTURE-245）", () => {
    it("深さ 1 を頼み、起点の段でリンクが 0 本なら no_links", async () => {
      const { body, summary } = await reportPage({
        depth: 0,
        maxDepth: 1,
        pagesDiscovered: 0,
        hrefs: [],
        known: [page],
      });
      expect(body).toEqual({ next: [], stopReason: "no_links" });
      expect(summary).toEqual([1, 0, "no_links"]);
    });

    it("深さ 0 なら、0 本でも completed（辿らないと頼んだので）", async () => {
      const { body } = await reportPage({
        depth: 0,
        maxDepth: 0,
        pagesDiscovered: 0,
        hrefs: [],
        known: [page],
      });
      expect(body).toEqual({ next: [], stopReason: "completed" });
    });

    it("前の段でリンクを見つけていれば、この段で 0 本でも completed", async () => {
      const { body } = await reportPage({
        depth: 1,
        maxDepth: 2,
        pagesDiscovered: 1,
        hrefs: [],
        known: [seed, page],
      });
      expect(body).toEqual({ next: [], stopReason: "completed" });
    });

    it("リンクはあったが規則が全部落としたなら no_links（数えるのは規則が通した本数）", async () => {
      const { body, summary } = await reportPage({
        depth: 0,
        maxDepth: 1,
        pagesDiscovered: 0,
        hrefs: ["http://outside.invalid/x"],
        known: [page],
      });
      expect(body).toEqual({ next: [], stopReason: "no_links" });
      expect(summary).toEqual([1, 0, "no_links"]);
    });

    it("先に立った上限の理由が行にあれば、そちらを残す", async () => {
      const { body, update } = await reportPage({
        depth: 1,
        maxDepth: 2,
        pagesDiscovered: 0,
        rowReason: "max_pages",
        hrefs: [],
        known: [seed, page],
      });
      expect(body).toEqual({ next: [], stopReason: "max_pages" });
      expect(update?.sql).toContain('"stop_reason" = coalesce("stop_reason", $1)');
    });
  });

  it("深さ 0 で新しい URL があれば、深さで切った", async () => {
    const { body, summary } = await reportPage({
      depth: 0,
      maxDepth: 0,
      hrefs: [unseen],
      known: [page],
    });
    expect(body).toEqual({ next: [], stopReason: "max_depth" });
    expect(summary).toEqual([1, 1, "max_depth"]);
  });

  it("枠を使い切っていても、候補が無ければ枚数で切ったとは言わない", async () => {
    const { body } = await reportPage({
      depth: 1,
      maxDepth: 5,
      maxPages: 2,
      hrefs: [seed],
      known: [seed, page],
    });
    expect(body).toEqual({ next: [], stopReason: "completed" });
  });

  it("枠を使い切って新しい URL があれば、枚数で切った", async () => {
    const { body } = await reportPage({
      depth: 1,
      maxDepth: 5,
      maxPages: 2,
      hrefs: [unseen],
      known: [seed, page],
    });
    expect(body).toEqual({ next: [], stopReason: "max_pages" });
  });

  it("枚数で切った後に候補が無くなっても、返事は行の理由のまま", async () => {
    // 行は coalesce で max_pages のまま。返事だけ completed にすると、run のログが「全部辿った」と言う
    const { body, update } = await reportPage({
      depth: 1,
      maxDepth: 5,
      maxPages: 3,
      rowReason: "max_pages",
      hrefs: [],
      known: [seed, page, unseen],
    });
    expect(body).toEqual({ next: [], stopReason: "max_pages" });
    expect(update?.sql).toContain('"stop_reason" = coalesce("stop_reason", $1)');
  });

  it("枚数で切った後に深さでも切ったら、返事は先に立った理由", async () => {
    const { body } = await reportPage({
      depth: 1,
      maxDepth: 1,
      rowReason: "max_pages",
      hrefs: [unseen],
      known: [seed, page],
    });
    expect(body).toEqual({ next: [], stopReason: "max_pages" });
  });

  it("既に行のある URL は枠を取らない", async () => {
    // 枠は 1 本。既知の URL を先に見つけても、新しい URL が入る
    const { body, update, insert } = await reportPage({
      depth: 0,
      maxDepth: 5,
      maxPages: 3,
      hrefs: [seed, unseen],
      known: [seed, page],
      inserted: [unseen],
    });
    expect(insert?.parameters).toContain(unseen);
    expect(insert?.parameters).not.toContain(seed);
    expect(body).toEqual({ next: [{ url: unseen, host: HOST, depth: 1 }], stopReason: null });
    // 切っておらず、続くので、クロールの状態も理由も書かない (数は段の行と合計の書き直し)
    expect(update).toBeUndefined();
  });
});
