#!/usr/bin/env node
/**
 * 同じ URL の取り込みの一覧と、好きな 2 本の差分 (CAPTURE-462) の読む SQL を、本物の Postgres に当てる
 * (CI の check の job。migration `042` の後)。
 *
 * 生成列 (`archives.source_url_hash`) の式・`digest($1::text, 'sha256')` との突き合わせ・新しい順・`before` の絞り・
 * 続きの 1 行・**索引が使われること**は、試験の記録する DB では確かめられない。索引は名前で見る —— `archives` には
 * 撮った時刻の索引 (`archives_captured_at_idx`) が既に在るので、「順に読んでいない」を見るだけでは、新しい索引を
 * 張り忘れても緑のまま。
 *
 * 自分の物 (組織 smoke-<pid>・鍵が smoke-<pid>/ で始まるアーカイブ) だけを足して、最後に消す。**使い捨ての DB を
 * 指して走らせること** —— 統計を取り直す (`analyze archives`)。
 */
import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { HISTORY_PAGE_SIZE, historyListQuery, historyReadsOf } from "../changes/history.js";
import { createKyselyClient } from "../db/kysely.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

const db = createKyselyClient(databaseUrl);
const reads = historyReadsOf(db);
const org = `smoke-${String(process.pid)}`;
const prefix = `${org}/`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

const INDEX = "archives_source_url_hash_captured_at_idx";
const HOST = `https://${org}.test`;
const URL_A = `${HOST}/a`;
/** URL_A が頭に一致する別の URL。同じ URL の行だけが返ることを見る。 */
const URL_A_LONGER = `${HOST}/a/b`;
const URL_MANY = `${HOST}/many`;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const RECIPE = "a".repeat(64);
const schedule = randomUUID();
const [scheduled, manual] = [randomUUID(), randomUUID()];

/** 締まった古いクロール。前回からの変化の周回が拾う窓 (48 時間) の外に置く。 */
const insertCrawl = async (id: string, scheduleId: string | null) => {
  await sql`
    insert into crawls (id, seeds, rules, max_depth, max_pages, per_host_delay_ms, host_parallelism, org_id,
      requested_by, state, started_at, finished_at, schedule_id, recipe_sha256)
    values (${id}, ${[URL_A]}, '[]', 0, 30, 2000, 4, ${org}, 'smoke', 'succeeded',
      '2020-01-01T00:00:00Z', '2020-01-01T00:05:00Z', ${scheduleId}, ${RECIPE})`.execute(db);
};

interface Page {
  stage: string | null;
  sha: string | null;
  withheld?: string;
}

const insertArchive = async (
  url: string,
  capturedAt: string,
  options: { crawlId?: string; inspected?: boolean; pages?: Page[] } = {},
) => {
  const id = randomUUID();
  const key = `${prefix}${id}.browserhive.wacz`;
  const crawlId = options.crawlId ?? null;
  if (options.inspected === false) {
    await sql`
      insert into archives (id, task_id, bucket, object_key, source_url, captured_at, crawl_id)
      values (${id}, ${randomUUID()}, 'smoke', ${key}, ${url}, ${capturedAt}, ${crawlId})`.execute(
      db,
    );
    return id;
  }
  await sql`
    insert into archives (id, task_id, bucket, object_key, source_url, captured_at, crawl_id, wacz_sha256,
      wacz_bytes, index_empty, inspected_at, browserhive_version)
    values (${id}, ${randomUUID()}, 'smoke', ${key}, ${url}, ${capturedAt}, ${crawlId}, 'x', 123456, false,
      now(), '32.0.3')`.execute(db);
  for (const [ordinal, page] of (options.pages ?? []).entries()) {
    await sql`
      insert into archive_pages (archive_id, ordinal, url, keys, stage, text_sha256, text_chars, text_withheld)
      values (${id}, ${ordinal}, ${url}, '{}', ${page.stage}, ${page.sha}, ${page.sha === null ? null : 10},
        ${page.withheld ?? null})`.execute(db);
  }
  return id;
};

const DOC: Page = { stage: null, sha: "doc" };
const LOADED: Page = { stage: "after-load", sha: "loaded" };
const BEHAVED: Page = { stage: "after-behaviors", sha: "behaved" };

try {
  await sql`
    insert into crawl_schedules (id, org_id, name, cron, next_run_at, request, recipe, pinned_at, created_by)
    values (${schedule}, ${org}, ${`smoke ${org}`}, '0 4 * * *', now(), '{}', '{}', now(), 'smoke')`.execute(
    db,
  );
  await insertCrawl(scheduled, schedule);
  await insertCrawl(manual, null);

  // URL_A の 4 本 (新しい順に: 予定の回・手のクロール・クロールの外・検めていない) と、頭が一致する別の URL の 1 本
  const newest = await insertArchive(URL_A, ago(10), {
    crawlId: scheduled,
    pages: [DOC, LOADED, BEHAVED],
  });
  const second = await insertArchive(URL_A, ago(20), { crawlId: manual, pages: [DOC, LOADED] });
  const third = await insertArchive(URL_A, ago(30), {
    pages: [DOC, { stage: "after-behaviors", sha: null, withheld: "no-archive" }],
  });
  const oldest = await insertArchive(URL_A, ago(40), { inspected: false });
  const longer = await insertArchive(URL_A_LONGER, ago(5), { pages: [DOC] });
  // 続きの 1 行を見るための 51 本と、索引が効く大きさにするための別々の URL の行
  await sql`
    insert into archives (id, task_id, bucket, object_key, source_url, captured_at)
    select gen_random_uuid(), gen_random_uuid(), 'smoke', ${prefix}::text || 'many-' || g::text,
      ${URL_MANY}::text, ${ago(0)}::timestamptz - make_interval(mins => g)
    from generate_series(1, ${HISTORY_PAGE_SIZE + 1}::int) g`.execute(db);
  await sql`
    insert into archives (id, task_id, bucket, object_key, source_url, captured_at)
    select gen_random_uuid(), gen_random_uuid(), 'smoke', ${prefix}::text || 'filler-' || g::text,
      ${HOST}::text || '/filler/' || g::text, ${ago(0)}::timestamptz - make_interval(mins => g)
    from generate_series(1, 2000) g`.execute(db);
  await sql`analyze archives`.execute(db);

  // ── 生成列 ─────────────────────────────────────────────
  const hashed = await sql<{ same: boolean }>`
    select source_url_hash = digest(source_url, 'sha256') as same from archives where id = ${newest}`.execute(
    db,
  );
  check("生成列は URL の sha256", hashed.rows[0]?.same === true, JSON.stringify(hashed.rows));

  // ── 一覧 ───────────────────────────────────────────────
  const page = await reads.list(URL_A, undefined);
  check(
    "同じ URL の行だけが、撮った時刻の新しい順に引ける (頭が一致する別の URL は入らない)",
    JSON.stringify(page.rows.map((row) => row.id)) ===
      JSON.stringify([newest, second, third, oldest]) &&
      !page.rows.some((row) => row.id === longer),
    JSON.stringify(page.rows.map((row) => row.id)),
  );
  check("続きが無ければ next は null", page.next === null, String(page.next));
  check(
    "予定の回の行は、クロール・予定の名前・撮り方を持つ",
    page.rows[0]?.crawlId === scheduled &&
      page.rows[0].scheduleId === schedule &&
      page.rows[0].scheduleName === `smoke ${org}` &&
      page.rows[0].recipeSha256 === RECIPE &&
      page.rows[0].browserhiveVersion === "32.0.3",
    JSON.stringify(page.rows[0]),
  );
  check(
    "手のクロールの行は予定が無く、クロールの外の行はクロールも無い",
    page.rows[1]?.crawlId === manual &&
      page.rows[1].scheduleId === null &&
      page.rows[2]?.crawlId === null &&
      page.rows[2].recipeSha256 === null,
    JSON.stringify(page.rows.slice(1, 3)),
  );
  check(
    "検めていない行は inspectedAt が null",
    page.rows[3]?.inspectedAt === null && page.rows[0]?.inspectedAt instanceof Date,
    JSON.stringify(page.rows[3]),
  );
  const older = await reads.list(URL_A, page.rows[1]?.capturedAt);
  check(
    "before は、その時刻より前の行だけを返す",
    JSON.stringify(older.rows.map((row) => row.id)) === JSON.stringify([third, oldest]),
    JSON.stringify(older.rows.map((row) => row.id)),
  );

  const many = await reads.list(URL_MANY, undefined);
  check(
    "1 ページより多ければ、1 ページぶんを返し、next は最後の行の撮った時刻",
    many.rows.length === HISTORY_PAGE_SIZE &&
      many.next?.getTime() === many.rows[HISTORY_PAGE_SIZE - 1]?.capturedAt.getTime(),
    `${String(many.rows.length)} 行・next ${String(many.next)}`,
  );
  const rest = await reads.list(URL_MANY, many.next ?? undefined);
  check(
    "next を before に渡すと、残りの 1 行で終わる",
    rest.rows.length === 1 && rest.next === null,
    `${String(rest.rows.length)} 行・next ${String(rest.next)}`,
  );

  // ── 索引 ───────────────────────────────────────────────
  const plan = await db.transaction().execute(async (trx) => {
    await sql`set local enable_seqscan = off`.execute(trx);
    return historyListQuery(trx, URL_A, undefined).explain();
  });
  check(
    `一覧の SQL は ${INDEX} を使う`,
    JSON.stringify(plan).includes(INDEX),
    JSON.stringify(plan),
  );

  // ── 比べる行 ─────────────────────────────────────────────
  const lines = await reads.comparedLines([newest, second, third, oldest]);
  check(
    "写しと文書の行の両方を持つ取り込みは、比べる行が after-behaviors の写し",
    lines.get(newest)?.stage === "after-behaviors" && lines.get(newest)?.textSha256 === "behaved",
    JSON.stringify(lines.get(newest)),
  );
  check(
    "after-behaviors の写しが無い取り込みは、文書の行 (after-load の写しは選ばない)",
    lines.get(second)?.stage === null && lines.get(second)?.textSha256 === "doc",
    JSON.stringify(lines.get(second)),
  );
  check(
    "伏せた写しは、伏せた訳を持つ行のまま選ぶ",
    lines.get(third)?.stage === "after-behaviors" &&
      lines.get(third)?.textWithheld === "no-archive",
    JSON.stringify(lines.get(third)),
  );
  check("検めていない取り込みには行が無い", !lines.has(oldest));

  // ── 2 本 ───────────────────────────────────────────────
  const pair = await reads.pair(newest, second);
  check(
    "2 本は、今と前の順で、大きさ (数)・クロールの組織・撮り方・比べる行を持つ",
    pair.after?.id === newest &&
      pair.before?.id === second &&
      pair.after.waczBytes === 123456 &&
      pair.after.orgId === org &&
      pair.after.recipeSha256 === RECIPE &&
      pair.after.line?.stage === "after-behaviors" &&
      pair.before.line?.stage === null,
    JSON.stringify(pair),
  );
  const outside = await reads.pair(third, oldest);
  check(
    "クロールの外の取り込みは組織が無く、検めていない取り込みは大きさが無い",
    outside.after?.orgId === null &&
      outside.after.crawlId === null &&
      outside.before?.waczBytes === null &&
      outside.before.inspectedAt === null,
    JSON.stringify(outside),
  );
  const missing = await reads.pair(newest, randomUUID());
  check(
    "無い取り込みは undefined",
    missing.after?.id === newest && missing.before === undefined,
    JSON.stringify(missing),
  );
} finally {
  // 自分の物だけ。ページの行 → アーカイブ → クロール → 予定
  await sql`delete from archive_pages where archive_id in (
    select id from archives where bucket = 'smoke' and object_key like ${`${prefix}%`})`.execute(
    db,
  );
  await sql`delete from archives where bucket = 'smoke' and object_key like ${`${prefix}%`}`.execute(
    db,
  );
  await sql`delete from crawls where org_id = ${org}`.execute(db);
  await sql`delete from crawl_schedules where org_id = ${org}`.execute(db);
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
console.log(
  `✓ history smoke: ${String(results.length)} 件とも期待どおり (組織 ${org} の行は消した)`,
);
