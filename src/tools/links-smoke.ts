#!/usr/bin/env node
/**
 * リンクを 1 本ずつ残す表 (`crawl_links`・`039`) を、本物の Postgres に当てる。
 *
 * 試験は DB を立てない。`test/recording-db.ts` は Kysely が組んだ SQL を記録するが、次のことは見られない。
 * **それを見るのは、ここだけ。**
 *
 *   - 置き換え (消してから入れる) で、同じ段を 2 度書いても行が増えないこと
 *   - `url_hash` の生成列が `crawl_pages.url_hash` と同じ式で、行き先のページと結べること
 *   - `outcome` の CHECK と、クロールを消したときの cascade
 *   - 1 ページの上限いっぱいの行が、1 回の INSERT の引数の上限に収まること
 *   - 読む側の SQL (URL ごとの最初の 1 本・出入りの数・木に無い辺・別々の URL の数) が通り、数が合うこと
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build:tools && DATABASE_URL=postgres://… node dist/tools/links-smoke.js
 *
 * 向ける DB は使い捨ての物にすること。自分の組織 (`smoke-<pid>`) の、締めたクロール 1 本とそのページだけを足して、
 * 最後に消す。どれか 1 つでも期待と違えば、全部を並べてから終了コード 1。
 */
import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { LINKS_PER_PAGE, linkRows } from "../crawl/link-outcomes.js";
import { distinctDiscovered, readLinkGraph, readPageLinksOf } from "../crawl/links-read.js";
import { pageParents, replaceLinks } from "../crawl/links-store.js";
import type { PageLink } from "../crawl/rules.js";
import { createKyselyClient } from "../db/kysely.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

const db = createKyselyClient(databaseUrl);
const org = `smoke-${String(process.pid)}`;
const crawlId = randomUUID();
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

const SITE = "https://site.test";
const link = (path: string, text = ""): PageLink => ({
  url: `${SITE}${path}`,
  host: "site.test",
  hostname: "site.test",
  action: "follow",
  rule: 1,
  nofollow: false,
  text,
});
const insertPage = async (path: string, depth: number, from: string | null): Promise<string> => {
  const row = await sql<{ id: string }>`
    insert into crawl_pages (crawl_id, url, depth, host, state, discovered_from)
    values (${crawlId}, ${`${SITE}${path}`}, ${depth}, 'site.test', 'captured', ${from})
    returning id`.execute(db);
  return row.rows[0]!.id;
};
const counts = async (): Promise<Record<string, number>> => {
  const rows = await sql<{ outcome: string; n: number }>`
    select outcome, count(*)::int as n from crawl_links where crawl_id = ${crawlId} group by outcome`.execute(
    db,
  );
  return Object.fromEntries(rows.rows.map((row) => [row.outcome, row.n]));
};

try {
  await sql`
    insert into crawls (id, seeds, rules, max_depth, max_pages, per_host_delay_ms, host_parallelism, org_id,
      requested_by, state, started_at, finished_at)
    values (${crawlId}, ${[`${SITE}/hub`]}, '[{"follow":"same-origin"}]', 1, 3, 2000, 4, ${org}, 'smoke',
      'succeeded', now(), now())`.execute(db);
  const hub = await insertPage("/hub", 0, null);
  const leaf1 = await insertPage("/leaf/1", 1, hub);
  const leaf2 = await insertPage("/leaf/2", 1, hub);

  // hub の形で枚数 3: 4 本のうち 2 本が入り、2 本は枚数で切る。落とした物と nofollow も 1 本ずつ
  const hubLinks: PageLink[] = [
    link("/leaf/1", "leaf 1"),
    link("/leaf/2"),
    link("/leaf/3"),
    link("/hidden"),
    {
      url: "https://other.test/page",
      host: "other.test",
      hostname: "other.test",
      action: "skip",
      rule: 0,
      nofollow: false,
      text: "",
    },
    { url: `${SITE}/n`, host: "site.test", hostname: "site.test", nofollow: true, text: "" },
  ];
  const write = async (links: PageLink[]) => {
    const { rows, dropped } = linkRows(
      crawlId,
      [{ from: hub, links }],
      await pageParents(db, crawlId),
      "max_pages",
    );
    await db.transaction().execute((trx) => replaceLinks(trx, crawlId, [hub], rows));
    return dropped;
  };

  await write(hubLinks);
  const first = await counts();
  check(
    "行き先の行から決めた物が入る (入れた 2・枚数で切った 2・落とした 1・nofollow 1)",
    first["followed"] === 2 &&
      first["max_pages"] === 2 &&
      first["skip"] === 1 &&
      first["nofollow"] === 1,
    JSON.stringify(first),
  );
  const stamped = await sql<{ at: Date | null }>`
    select links_recorded_at as at from crawls where id = ${crawlId}`.execute(db);
  const firstAt = stamped.rows[0]?.at ?? null;
  check("クロールに、記録した時刻が立つ", firstAt !== null, String(firstAt));

  await write(hubLinks);
  const second = await counts();
  const again = await sql<{ at: Date | null }>`
    select links_recorded_at as at from crawls where id = ${crawlId}`.execute(db);
  check(
    "同じ段を 2 度書いても行が増えず、最初の時刻が残る",
    JSON.stringify(second) === JSON.stringify(first) &&
      again.rows[0]?.at?.getTime() === firstAt?.getTime(),
    `${JSON.stringify(second)} ${String(again.rows[0]?.at)}`,
  );

  const joined = await sql<{ url: string; outcome: string; rule: number | null }>`
    select l.url, l.outcome, l.rule from crawl_links l
      join crawl_pages p on p.crawl_id = l.crawl_id and p.url_hash = l.url_hash
     where l.crawl_id = ${crawlId} order by l.seq`.execute(db);
  check(
    "url_hash で行き先のページと結べる (行の在る 2 本だけ)",
    joined.rows.length === 2 && joined.rows.every((row) => row.outcome === "followed"),
    JSON.stringify(joined.rows),
  );
  const unruled = await sql<{ n: number }>`
    select count(*)::int as n from crawl_links where crawl_id = ${crawlId} and rule is null`.execute(
    db,
  );
  check("規則を当てていない行 (nofollow) は rule が NULL", unruled.rows[0]?.n === 1);

  let refused = false;
  try {
    await sql`
      insert into crawl_links (crawl_id, from_page, seq, url, hostname, outcome)
      values (${crawlId}, ${hub}, 9999, 'https://site.test/x', 'site.test', 'bogus')`.execute(db);
  } catch {
    refused = true;
  }
  check("知らない outcome は CHECK が断る", refused);

  // ── 読む側 (`crawl/links-read.ts`) ───────────────────────────────────────
  // 葉 1 にもリンクを書く: 起点へ戻る・葉 3 (起点が先に見つけて枚数で切った URL。ここでは深さで切る)・
  // 起点と同じ別のホストの URL・もう 1 つの別のホスト
  const other = (url: string): PageLink => ({
    url,
    host: new URL(url).host,
    hostname: new URL(url).hostname,
    action: "skip",
    rule: 0,
    nofollow: false,
    text: "",
  });
  const leafRows = linkRows(
    crawlId,
    [
      {
        from: leaf1,
        links: [
          link("/hub", "戻る"),
          link("/leaf/3"),
          other("https://other.test/page"),
          other("https://other2.test/"),
        ],
      },
    ],
    await pageParents(db, crawlId),
    "max_depth",
  );
  await replaceLinks(db, crawlId, [leaf1], leafRows.rows);

  const graph = await readLinkGraph(db, crawlId);
  check(
    "内訳は URL ごと: 行の在る 2 つは結末で、行の無い URL は最初に見つけたリンクの理由で数える",
    JSON.stringify(graph?.summary) ===
      JSON.stringify({
        pending: 0,
        captured: 2,
        failed: 0,
        skipped: 0,
        maxPages: 2,
        maxDepth: 0,
        closed: 0,
        skip: 2,
        nofollow: 1,
        hosts: 2,
      }),
    JSON.stringify(graph?.summary),
  );
  check(
    "束は最初に見つけたページに付く (葉 3 は起点の枚数の束で、葉 1 の深さの束にならない)",
    JSON.stringify(graph?.bundles) ===
      JSON.stringify([{ from: hub, outcome: "max_pages", urls: 2 }]),
    JSON.stringify(graph?.bundles),
  );
  const outOf = (id: string) => graph?.pages.find((page) => page.id === id);
  check(
    "ページごとの出入りの数",
    JSON.stringify(outOf(hub)?.out) ===
      JSON.stringify({
        followed: 2,
        known: 0,
        maxPages: 2,
        maxDepth: 0,
        closed: 0,
        skip: 1,
        nofollow: 1,
      }) &&
      outOf(hub)?.in === 1 &&
      outOf(leaf1)?.out?.known === 1 &&
      outOf(leaf1)?.out?.maxDepth === 1 &&
      outOf(leaf1)?.out?.skip === 2 &&
      outOf(leaf1)?.in === 1 &&
      outOf(leaf2)?.in === 1 &&
      outOf(leaf2)?.out?.followed === 0,
    JSON.stringify(graph?.pages.map((page) => [page.id, page.out, page.in])),
  );
  check(
    "ページの親と、木に無い辺 (葉 1 → 起点)",
    outOf(hub)?.parent === null &&
      outOf(leaf1)?.parent === hub &&
      JSON.stringify(graph?.cross) === JSON.stringify([[leaf1, hub]]) &&
      graph?.crossTruncated === false,
    JSON.stringify(graph?.cross),
  );
  check(
    "別のホストはホスト名ごと",
    JSON.stringify(graph?.hosts) ===
      JSON.stringify([
        { hostname: "other.test", urls: 1 },
        { hostname: "other2.test", urls: 1 },
      ]),
    JSON.stringify(graph?.hosts),
  );
  const distinct = await distinctDiscovered(db, crawlId);
  check(
    "規則が通した別々の URL の数は、起点を除いて 4 (葉 1・葉 2・葉 3・hidden)",
    distinct === 4,
    String(distinct),
  );
  const ofHub = await readPageLinksOf(db, crawlId, hub);
  check(
    "1 ページの出入り: 出るリンクはあった順で、行き先のページの id が付く。入るリンクは元のページ",
    ofHub?.out.length === 6 &&
      ofHub.out[0]?.to === leaf1 &&
      ofHub.out[0].text === "leaf 1" &&
      ofHub.out[1]?.to === leaf2 &&
      ofHub.out[2]?.to === null &&
      ofHub.out[2].outcome === "max_pages" &&
      JSON.stringify(ofHub.in) === JSON.stringify([{ from: leaf1, text: "戻る" }]),
    JSON.stringify(ofHub),
  );
  check(
    "ほかのクロールのページは読ませない",
    (await readPageLinksOf(db, randomUUID(), hub)) === undefined,
  );

  // 1 ページの上限を超えるリンク: 上限いっぱいを 1 回で書け、超えた数が返る
  const many = Array.from({ length: LINKS_PER_PAGE + 5 }, (_, i) => link(`/many/${String(i)}`));
  const dropped = await write(many);
  const total = await sql<{ n: number }>`
    select count(*)::int as n from crawl_links where crawl_id = ${crawlId}`.execute(db);
  check(
    "上限いっぱいの行を書け、そのページの前の行は置き換わる (葉 1 の 4 行は残る)",
    dropped === 5 && total.rows[0]?.n === LINKS_PER_PAGE + 4,
    `${String(dropped)} ${String(total.rows[0]?.n)}`,
  );

  await sql`delete from crawls where id = ${crawlId}`.execute(db);
  const left = await sql<{ n: number }>`
    select count(*)::int as n from crawl_links where crawl_id = ${crawlId}`.execute(db);
  check("クロールを消すと、リンクの行も消える", left.rows[0]?.n === 0, String(left.rows[0]?.n));
} finally {
  await sql`delete from crawls where org_id = ${org}`.execute(db);
  await db.destroy();
}

for (const { name, ok, detail } of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` —— ${detail}`}`);
}
const failed = results.filter((result) => !result.ok).length;
if (failed > 0) {
  console.error(`\n${String(failed)} 件が期待と違う (${String(results.length)} 件中)`);
  process.exit(1);
}
console.log(`✓ links smoke: ${String(results.length)} 件とも期待どおり (組織 ${org} の行は消した)`);
