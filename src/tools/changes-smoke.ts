#!/usr/bin/env node
/**
 * 前回からの変化 (CAPTURE-167) の store と読む SQL を、本物の Postgres に当てる (CI の check の job)。
 *
 * `for update skip locked`・`make_interval`・`on conflict ... where kind = 'change'` (`034` の部分の一意)・jsonb の
 * 差分・`array(...)`・同じだったページ (`unchanged`。周回と同じ組の作り方で、`page_changes` に無い組) は、試験の記録する
 * DB では確かめられない。自分の組織 (smoke-<pid>) の予定・回・アーカイブだけを
 * 足して、最後に消す。**使い捨ての DB を指して走らせること** —— 拾う SQL はほかの組織の回も拾う。
 */
import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { pairsOf } from "../changes/pairs.js";
import { changeReadsOf } from "../changes/reads.js";
import { changeStoreOf } from "../changes/store.js";
import { createKyselyClient } from "../db/kysely.js";
import { scheduleStoreOf } from "../schedules/store.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

const db = createKyselyClient(databaseUrl);
const store = changeStoreOf(db);
const reads = changeReadsOf(db);
const org = `smoke-${String(process.pid)}`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const schedule = randomUUID();
const [prev, other, current] = [randomUUID(), randomUUID(), randomUUID()];
const RECIPE = "a".repeat(64);
const OTHER_RECIPE = "b".repeat(64);

const insertCrawl = async (id: string, recipe: string, startedAt: string, finishedAt: string) => {
  await sql`
    insert into crawls (id, seeds, rules, max_depth, max_pages, per_host_delay_ms, host_parallelism, org_id,
      requested_by, state, started_at, finished_at, schedule_id, recipe_sha256)
    values (${id}, ${["https://site.test/"]}, '[]', 0, 30, 2000, 4, ${org}, 'smoke', 'succeeded',
      ${startedAt}, ${finishedAt}, ${schedule}, ${recipe})`.execute(db);
};
const insertArchive = async (crawlId: string, url: string, sha: string) => {
  const id = randomUUID();
  await sql`
    insert into archives (id, task_id, bucket, object_key, source_url, captured_at, crawl_id, wacz_sha256, wacz_bytes,
      index_empty, inspected_at, browserhive_version)
    values (${id}, ${randomUUID()}, 'smoke', ${`${id}.wacz`}, ${url}, now(), ${crawlId}, 'x', 1, false, now(), '29.0.2')`.execute(
    db,
  );
  await sql`
    insert into archive_pages (archive_id, ordinal, url, keys, stage, text_sha256)
    values (${id}, 0, ${url}, ${[url]}, null, 'doc'),
           (${id}, 1, ${`urn:browserhive:snapshot:after-behaviors:${url}`}, '{}', 'after-behaviors', ${sha})`.execute(
    db,
  );
  return id;
};

try {
  await sql`
    insert into crawl_schedules (id, org_id, name, cron, next_run_at, request, recipe, pinned_at, created_by)
    values (${schedule}, ${org}, ${`smoke ${org}`}, '0 4 * * *', now(), '{}', '{}', now(), 'smoke')`.execute(
    db,
  );
  await insertCrawl(prev, RECIPE, ago(31 * HOUR), ago(30 * HOUR));
  await insertCrawl(other, OTHER_RECIPE, ago(21 * HOUR), ago(20 * HOUR));
  await insertCrawl(current, RECIPE, ago(10 * 60_000), ago(5 * 60_000));
  // a は同じ文字、b は違う文字、c は digest が違うが空行だけの違い (周回は page_changes に残さない)
  const prevA = await insertArchive(prev, "https://site.test/a", "same");
  const prevB = await insertArchive(prev, "https://site.test/b", "old");
  const prevC = await insertArchive(prev, "https://site.test/c", "blank-old");
  await insertArchive(other, "https://site.test/a", "same");
  const curA = await insertArchive(current, "https://site.test/a", "same");
  const curB = await insertArchive(current, "https://site.test/b", "new");
  const curC = await insertArchive(current, "https://site.test/c", "blank-new");

  // ── 比べる回を拾う ───────────────────────────────────────
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    const run = await store.claimRunToCompare(NOW, 300_000);
    if (run === undefined) break;
    order.push(run.crawlId);
    const before = await store.previousRun(run);
    if (run.crawlId === current) {
      check("前の回は、同じ撮り方の回 (撮り方の違う回を飛ばす)", before === prev, String(before));
      const pages = await store.comparedPages(current);
      check(
        "回のページは URL ごとに 1 つ、after-behaviors の行",
        pages.length === 3 && pages.every((p) => p.stage === "after-behaviors"),
        JSON.stringify(pages),
      );
      const pairs = pairsOf(pages, await store.comparedPages(prev));
      check("比べる組は 3 つ", pairs.length === 3, JSON.stringify(pairs));
      await store.finishCompare(
        current,
        {
          state: "diffed",
          prevCrawlId: prev,
          pagesCompared: pairs.length,
          pagesChanged: 1,
          pages: [
            {
              url: "https://site.test/b",
              archiveId: curB,
              prevArchiveId: prevB,
              stage: "after-behaviors",
              state: "diffed",
              added: 1,
              removed: 1,
              hunks: [["-old", "+new"]],
            },
          ],
        },
        NOW,
      );
    } else {
      check(
        `${run.crawlId === prev ? "最初の回" : "撮り方の違う回"} には前の回が無い`,
        before === undefined,
        String(before),
      );
      await store.finishCompare(
        run.crawlId,
        { state: "no_previous", prevCrawlId: null, pagesCompared: 0, pagesChanged: 0, pages: [] },
        NOW,
      );
    }
  }
  check(
    "締まった順に 1 本ずつ拾う",
    JSON.stringify(order) === JSON.stringify([prev, other, current]),
    JSON.stringify(order),
  );
  check("拾い終えたら何も拾わない", (await store.claimRunToCompare(NOW, 300_000)) === undefined);

  await sql`update crawl_changes set state = 'comparing', lease_until = ${ago(60_000)} where crawl_id = ${other}`.execute(
    db,
  );
  const stale = await store.claimRunToCompare(NOW, 300_000);
  check("期限の切れた比べ中を拾い直す", stale?.crawlId === other, String(stale?.crawlId));
  await store.finishCompare(
    other,
    { state: "no_previous", prevCrawlId: null, pagesCompared: 0, pagesChanged: 0, pages: [] },
    NOW,
  );

  // ── 要約する回を拾う ───────────────────────────────────────
  const job = await store.claimRunToSummarize(NOW, 300_000);
  check(
    "差分ありの回を要約中にして拾う",
    job?.crawlId === current && job.orgId === org,
    JSON.stringify(job),
  );
  const changes = await store.pageChangesOf(current);
  check(
    "差分は jsonb の配列で戻る",
    changes.length === 1 && JSON.stringify(changes[0]?.hunks) === '[["-old","+new"]]',
    JSON.stringify(changes),
  );
  const derivation = {
    orgId: org,
    crawlId: current,
    target: { crawlId: current },
    inputSha256: `smoke-${org}`,
    model: "claude-opus-5-5",
    promptVersion: "change-v1",
    effort: "low",
    output: { headline: "中身の変化は無い", pages: [] },
    usage: {},
    usd: 0.01,
  };
  await store.finishSummary(
    current,
    { derivation, headline: "中身の変化は無い", significance: "minor" },
    NOW,
  );
  const found = await store.findSummary(derivation.inputSha256, "change-v1");
  check("要約を派生の層に残し、同じ入力で引ける", found !== undefined);

  // 同じ入力を別の回で残すと、部分の一意にぶつかって前の行を指す
  await sql`update crawl_changes set state = 'summarizing' where crawl_id = ${other}`.execute(db);
  await store.finishSummary(
    other,
    { derivation: { ...derivation, crawlId: other }, headline: "h", significance: "none" },
    NOW,
  );
  const ids = await sql<{ derivationId: string | null }>`
    select derivation_id from crawl_changes where crawl_id in (${current}, ${other})`.execute(db);
  check(
    "同じ入力の 2 度目は、前の要約を指す (034 の部分の一意)",
    ids.rows.length === 2 &&
      ids.rows[0]?.derivationId === found?.id &&
      ids.rows[1]?.derivationId === found?.id,
    JSON.stringify(ids.rows),
  );

  // やり直しの時刻まで拾わない
  await sql`update crawl_changes set state = 'summarizing' where crawl_id = ${other}`.execute(db);
  await store.failAttempt(
    other,
    { error: "529", terminal: false, nextAttemptAt: new Date(NOW.getTime() + HOUR) },
    NOW,
  );
  const later = await sql<{ state: string; attempts: number }>`
    select state, attempts from crawl_changes where crawl_id = ${other}`.execute(db);
  check(
    "失敗は差分ありに戻して数える",
    later.rows[0]?.state === "diffed" && later.rows[0].attempts === 1,
    JSON.stringify(later.rows),
  );
  check(
    "やり直しの時刻までは拾わない",
    (await store.claimRunToSummarize(NOW, 300_000)) === undefined,
  );

  // ── 読む ───────────────────────────────────────────────
  const runs = (await reads.listRuns(undefined)).filter((r) => r.scheduleId === schedule);
  check(
    "一覧は新しい順で、今回と前の回の WACZ の id を持つ",
    runs[0]?.crawlId === current &&
      runs[0].archiveIds.length === 6 &&
      runs[0].scheduleName === `smoke ${org}`,
    JSON.stringify(runs[0]),
  );
  const detail = await reads.runDetail(current);
  check(
    "1 本はページの差分と前後の WACZ と要約を返す",
    detail?.pages.length === 1 &&
      detail.pages[0]?.after?.archiveId === curB &&
      detail.pages[0].before?.archiveId === prevB &&
      detail.pages[0].after.browserhiveVersion === "29.0.2" &&
      detail.summary?.promptVersion === "change-v1",
    JSON.stringify(detail),
  );
  check(
    "1 本は前の回の始まった時刻を持つ",
    detail?.run.prevCrawlId === prev &&
      detail.run.prevStartedAt?.toISOString() === ago(31 * HOUR) &&
      detail.run.prevScheduledFor === null,
    JSON.stringify(detail?.run),
  );
  check(
    "同じだったページは、同じ文字の a と空行だけ違う c (URL の順・前と今の WACZ)",
    JSON.stringify(
      detail?.unchanged.map((p) => [p.url, p.before.archiveId, p.after.archiveId, p.stage]),
    ) ===
      JSON.stringify([
        ["https://site.test/a", prevA, curA, "after-behaviors"],
        ["https://site.test/c", prevC, curC, "after-behaviors"],
      ]) && detail?.unchanged[0]?.after.browserhiveVersion === "29.0.2",
    JSON.stringify(detail?.unchanged),
  );
  check(
    "違ったページと同じだったページを足すと、比べた数",
    detail?.pages.length !== undefined &&
      detail.pages.length + detail.unchanged.length === detail.run.pagesCompared,
    JSON.stringify(detail?.run),
  );
  const first = await reads.runDetail(prev);
  check(
    "前の回の無い回は、前の時刻も同じだったページも無い",
    first?.run.prevCrawlId === null &&
      first.run.prevStartedAt === null &&
      first.unchanged.length === 0,
    JSON.stringify(first),
  );
  const recent = await scheduleStoreOf(db).recentRuns(schedule);
  check(
    "予定の回に変化の写しが載る",
    recent[0]?.crawlId === current &&
      recent[0].change?.state === "summarized" &&
      recent[0].change.significance === "minor",
    JSON.stringify(recent[0]),
  );
} finally {
  // 自分の組織の物だけ。派生の層 → 回の状態と差分 (回を消すと消える) → アーカイブ → 回 → 予定
  await sql`delete from derivations where org_id = ${org}`.execute(db);
  await sql`delete from archive_pages where archive_id in (select id from archives where bucket = 'smoke' and crawl_id in (select id from crawls where org_id = ${org}))`.execute(
    db,
  );
  await sql`delete from archives where crawl_id in (select id from crawls where org_id = ${org})`.execute(
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
  `✓ changes smoke: ${String(results.length)} 件とも期待どおり (組織 ${org} の行は消した)`,
);
