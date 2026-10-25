/**
 * 規則が決めたことを残す・読む・確かめる口。
 *
 * 本物の Kysely に SQL を組ませ、実行の直前で取り上げる代役 (`recording-db.ts`) で見る。返す行は
 * 問い合わせの順に試験が並べた物から渡すので、**SQL が Postgres で本当に通るか・数が本当に置き換わるか**は
 * ここでは言えない —— それは開発の DB で確かめる (この repo に DB の試験は無い)。ここで見るのは配線:
 * 規則で分けた物が表と次の段の両方に届くか、口が認可と言い分を守るか。
 */
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerCrawlRoutes, type CrawlRouteDeps } from "../src/api/crawls.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import type { CrawlRule } from "../src/db/database.js";
import { recordingDb, type RecordedQuery } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const FIXTURES = "http://capture-fixtures.capture-ledger:8080";
const COMPILED = { typescript: "6.0.3", hostTypes: "v0.2.0", scripts: [] };

const crawlRow = (rules: CrawlRule[], seeds: string[]) => ({
  id: CRAWL,
  seeds,
  rules,
  orgId: "acme",
  requestedBy: "alice",
  state: "running",
  maxDepth: 2,
  maxPages: 20,
  perHostDelayMs: 0,
  hostParallelism: 1,
  pagesDiscovered: 1,
  pagesCaptured: 0,
  artifactKeyPrefix: null,
  scripts: [],
});

interface Built {
  app: FastifyInstance;
  queries: RecordedQuery[];
  /** S3 から読んだ鍵。リンクを見ないページは、ここに出ない。 */
  read: string[];
}

const build = async (opts: {
  results?: readonly (readonly object[])[];
  allowed?: boolean;
  links?: Record<string, unknown>;
}): Promise<Built> => {
  const { db, queries } = recordingDb(opts.results);
  const read: string[] = [];
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
    dispatch: () => Promise.resolve(undefined),
    s3,
    bucket: "b",
    capture: parseCaptureFormats("wacz", false),
  } as unknown as CrawlRouteDeps);
  await app.ready();
  return { app, queries, read };
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
        [{ count: "1" }], // crawl_pages の数
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
      headers: SUBJECT,
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

  it("撮るだけのページのリンクは読まず、何も残さない", async () => {
    const { app, queries, read } = await build({
      results: [
        [crawlRow(rules, [seed])],
        [{ id: "12" }],
        [{ count: "3" }],
        [], // crawls の集計 (次が無いので締める)
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: SUBJECT,
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
        [{ count: "1" }],
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
      headers: SUBJECT,
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
      results: [[crawlRow([{ follow: "*.example.com" }], [seed])]],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/pages`,
      headers: SUBJECT,
      payload: { depth: 0, compiled: COMPILED, results: [] },
    });
    await app.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "a crawl rule is not readable" });
    expect(queries).toHaveLength(1);
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
    for (const domain of [
      "ADS.example.com",
      "%25.example.com",
      "a_b.example.com",
      "example.com:443",
    ]) {
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
        ["seed", "https://www.example.com/"],
        ["rule", "follow:same-site"],
        ["rule", "skip:ads.example.com"],
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      seeds: [
        { url: "https://www.example.com/", valid: true, site: "example.com", followed: true },
      ],
      rules: [
        { rule: 1, action: "follow", kind: "scope", pattern: "same-site" },
        { rule: 2, action: "skip", kind: "domain", pattern: "ads.example.com", coveredBy: 1 },
      ],
      ok: false,
    });
    expect(queries).toEqual([]);
  });

  it("前方一致は書き残す形（正規化した URL）で返し、当てる物の : は最初の 1 つで切る", async () => {
    const { res } = await check(
      q([
        ["seed", "https://www.example.com/"],
        ["rule", "skip:HTTPS://WWW.Example.com:443/search"],
        ["rule", "follow:same-site"],
      ]),
    );
    expect(res.json()).toMatchObject({
      rules: [
        { rule: 1, action: "skip", kind: "prefix", pattern: "https://www.example.com/search" },
        { rule: 2, action: "follow", kind: "scope", pattern: "same-site" },
      ],
      ok: true,
    });
  });

  it("読めない規則は invalid で頼まれたまま、読めない起点は valid: false で、ok は false", async () => {
    const { res } = await check(
      q([
        ["seed", "not a url"],
        ["rule", "skip:ADS.example.com"],
      ]),
    );
    expect(res.json()).toEqual({
      seeds: [{ url: "not a url", valid: false }],
      rules: [{ rule: 1, action: "skip", kind: "invalid", pattern: "ADS.example.com" }],
      ok: false,
    });
  });

  it("起点を辿らない並びは、その起点を followed: false で返す", async () => {
    const { res } = await check(
      q([
        ["seed", "https://ads.example.com/"],
        ["rule", "skip:ads.example.com"],
        ["rule", "follow:same-site"],
      ]),
    );
    expect(res.json()).toMatchObject({
      seeds: [{ url: "https://ads.example.com/", followed: false }],
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
