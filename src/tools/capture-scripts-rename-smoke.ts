#!/usr/bin/env node
/**
 * `049` (capture scripts の名・時点の名。CAPTURE-506) を、本物の Postgres に当てる。
 *
 * CI の migration の往復 (down → up) は、`049` が落ちずに走ることしか見ない。行の入った表で、次のことはここで見る。
 *
 *   - 表 `capture_scripts`・列 `crawls.capture_scripts` と、制約と索引の名 (`capture_scripts_*`・`crawls_capture_scripts_check`)。
 *     古い名の物が 1 つも残らないこと
 *   - 3 表 (`archive_pages`・`archive_screenshots`・`page_changes`) の `stage` の古い値が新しい名になり、写しの urn
 *     (`archive_pages.url`) は撮った字のままなこと。`archive_screenshots` の主キー (archive_id, stage) の組
 *     (after-load と after-behaviors の 2 行) が、after-load と after-capture-scripts の 2 行になること
 *   - down が値と名を戻すこと
 *
 * 走らせ方: `049` を down で外し、古い名の行を足し、up で当て、見て、down と up をもう 1 度してから、足した行を消す。
 * **共有の DB に向けない** (migration を外す間、ほかの物が新しい名の表を読めない)。CI の check job が、migration を
 * 当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build:tools && DATABASE_URL=postgres://… node dist/tools/capture-scripts-rename-smoke.js
 *
 * 足すのは、組織が `smoke-<pid>` のクロール 2 本と、それに繋がる取り込み 1 本と、id が `smoke-<pid>` の capture script
 * 1 本だけ。どれか 1 つでも期待と違えば、全部を並べてから終了コード 1。
 */
import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";

import { createKyselyClient } from "../db/kysely.js";
import { runMigrator } from "../db/migrator-runner.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 名の替わる表を、型を通さずに読む
const db: Kysely<any> = createKyselyClient(databaseUrl);
const MIGRATIONS = {
  migrationFolder: new URL("../db/migrations/", import.meta.url),
  migrationTableName: "kysely_migration",
  migrationLockTableName: "kysely_migration_lock",
};
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

const org = `smoke-${String(process.pid)}`;
const scriptId = `smoke-${String(process.pid)}`;
const [crawl, prevCrawl, archive] = [randomUUID(), randomUUID(), randomUUID()];
const URL_A = "https://site.test/a";
const OLD = "after-behaviors";
const NEW = "after-capture-scripts";

const migrate = async (direction: "up" | "down", expected: string) => {
  const { error, results: ran } = await runMigrator(db, MIGRATIONS, direction);
  if (error instanceof Error) throw error;
  if (error !== undefined) throw new Error(`migrate ${direction} failed`, { cause: error });
  const names = (ran ?? []).map((r) => r.migrationName);
  if (names.join(",") !== expected) {
    throw new Error(`migrate ${direction} ran [${names.join(",")}], not ${expected}`);
  }
};

const names = async () => {
  const constraints = await sql<{ name: string }>`
    select conname as name from pg_constraint
    where conrelid in (to_regclass('scripts'), to_regclass('capture_scripts'), 'crawls'::regclass)
      and conname like '%scripts%'`.execute(db);
  const indexes = await sql<{ name: string }>`
    select indexname as name from pg_indexes where indexname like '%scripts%'`.execute(db);
  const tables = await sql<{ name: string }>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_name in ('scripts', 'capture_scripts')`.execute(db);
  const columns = await sql<{ name: string }>`
    select column_name as name from information_schema.columns
    where table_schema = 'public' and table_name = 'crawls' and column_name in ('scripts', 'capture_scripts')`.execute(
    db,
  );
  const sorted = (rows: { rows: { name: string }[] }) => rows.rows.map((r) => r.name).sort();
  return {
    constraints: sorted(constraints),
    indexes: sorted(indexes),
    tables: sorted(tables),
    columns: sorted(columns),
  };
};

const stages = async () => {
  const pages = await sql<{ url: string; stage: string | null }>`
    select url, stage from archive_pages where archive_id = ${archive} order by ordinal`.execute(
    db,
  );
  const shots = await sql<{ stage: string }>`
    select stage from archive_screenshots where archive_id = ${archive}`.execute(db);
  const changes = await sql<{ stage: string | null }>`
    select stage from page_changes where crawl_id = ${crawl}`.execute(db);
  return {
    pages: pages.rows.map((r) => [r.url, r.stage]),
    shots: shots.rows.map((r) => r.stage).sort(),
    changes: changes.rows.map((r) => r.stage),
  };
};

const insertCrawl = async (id: string, scriptsColumn: "scripts" | "capture_scripts") => {
  await sql`
    insert into crawls (id, seeds, rules, max_depth, max_pages, per_host_delay_ms, host_parallelism, org_id,
      requested_by, state, started_at, finished_at, ${sql.ref(scriptsColumn)})
    values (${id}, ${["https://site.test/"]}, '[]', 0, 30, 2000, 4, ${org}, 'smoke', 'succeeded',
      now(), now(), ${JSON.stringify([{ id: scriptId, version: 1 }])})`.execute(db);
};

const cleanup = async () => {
  // 取り込みは crawls を消しても残る (archives.crawl_id は SET NULL) ので、先に消す
  await sql`delete from archives where id = ${archive}`.execute(db);
  await sql`delete from crawls where org_id = ${org}`.execute(db);
  await sql`delete from capture_scripts where id = ${scriptId}`.execute(db);
};

const main = async () => {
  // ---- 049 を外して、古い名の行を足す ----
  await migrate("down", "049-rename-capture-scripts");
  const before = await names();
  check(
    "049 の前は古い名 (表 scripts・列 crawls.scripts)",
    before.tables.join() === "scripts" && before.columns.join() === "scripts",
    JSON.stringify(before),
  );

  await sql`
    insert into scripts (id, version, phase, source, options)
    values (${scriptId}, 1, 'behavior', 'x;', '{}')`.execute(db);
  await insertCrawl(prevCrawl, "scripts");
  await insertCrawl(crawl, "scripts");
  await sql`
    insert into archives (id, task_id, bucket, object_key, source_url, captured_at, crawl_id, wacz_sha256, wacz_bytes,
      index_empty, inspected_at, browserhive_version)
    values (${archive}, ${randomUUID()}, 'smoke', ${`${org}/${archive}.wacz`}, ${URL_A}, now(), ${crawl}, 'x', 1,
      false, now(), '32.2.1')`.execute(db);
  await sql`
    insert into archive_pages (archive_id, ordinal, url, keys, stage)
    values (${archive}, 0, ${URL_A}, ${[URL_A]}, null),
           (${archive}, 1, ${`urn:browserhive:snapshot:after-load:${URL_A}`}, '{}', 'after-load'),
           (${archive}, 2, ${`urn:browserhive:snapshot:${OLD}:${URL_A}`}, '{}', ${OLD})`.execute(
    db,
  );
  await sql`
    insert into archive_screenshots (archive_id, stage, skipped)
    values (${archive}, 'after-load', 'disabled'), (${archive}, ${OLD}, 'disabled')`.execute(db);
  await sql`
    insert into page_changes (crawl_id, prev_crawl_id, url, state, diff_version, archive_id, stage)
    values (${crawl}, ${prevCrawl}, ${URL_A}, 'prev_missing', 1, ${archive}, ${OLD})`.execute(db);

  // ---- 049 を当てる ----
  await migrate("up", "049-rename-capture-scripts");
  const after = await names();
  check(
    "表は capture_scripts だけ",
    after.tables.join() === "capture_scripts",
    after.tables.join(),
  );
  check(
    "crawls の列は capture_scripts だけ",
    after.columns.join() === "capture_scripts",
    after.columns.join(),
  );
  const oldNamed = [...after.constraints, ...after.indexes].filter(
    (name) => !name.startsWith("capture_scripts_") && name !== "crawls_capture_scripts_check",
  );
  check("制約と索引に、古い名の物が残らない", oldNamed.length === 0, oldNamed.join(", "));
  check(
    "制約は 10 個 (表の 9 つと crawls の列の 1 つ)、索引は 2 つ",
    after.constraints.length === 10 && after.indexes.length === 2,
    JSON.stringify({ constraints: after.constraints, indexes: after.indexes }),
  );
  const moved = await sql<{ n: number }>`
    select count(*)::int as n from capture_scripts where id = ${scriptId}`.execute(db);
  check("capture script の行は動かない", moved.rows[0]?.n === 1);
  const pinned = await sql<{ n: number }>`
    select count(*)::int as n from crawls where org_id = ${org} and jsonb_array_length(capture_scripts) = 1`.execute(
    db,
  );
  check("クロールの列の中身は動かない", pinned.rows[0]?.n === 2);

  const renamed = await stages();
  check(
    "archive_pages の時点は新しい名に、写しの urn は撮った字のまま",
    JSON.stringify(renamed.pages) ===
      JSON.stringify([
        [URL_A, null],
        [`urn:browserhive:snapshot:after-load:${URL_A}`, "after-load"],
        [`urn:browserhive:snapshot:${OLD}:${URL_A}`, NEW],
      ]),
    JSON.stringify(renamed.pages),
  );
  check(
    "archive_screenshots の 2 行は after-load と after-capture-scripts (主キーの組がぶつからない)",
    renamed.shots.join() === ["after-load", NEW].sort().join(),
    renamed.shots.join(),
  );
  check("page_changes の時点は新しい名", renamed.changes.join() === NEW, renamed.changes.join());

  // ---- down で戻り、up でまた当たる ----
  await migrate("down", "049-rename-capture-scripts");
  const reverted = await stages();
  const back = await names();
  check(
    "down は名と時点の値を戻す",
    back.tables.join() === "scripts" &&
      back.columns.join() === "scripts" &&
      reverted.shots.join() === ["after-load", OLD].sort().join() &&
      reverted.changes.join() === OLD &&
      reverted.pages[2]?.[1] === OLD,
    JSON.stringify({ back, reverted }),
  );
  await migrate("up", "049-rename-capture-scripts");
};

try {
  await main();
} catch (err) {
  check("走りきる", false, String(err));
} finally {
  try {
    await cleanup();
  } catch (err) {
    check("足した行を消す", false, String(err));
  }
  await db.destroy();
}

let failed = 0;
for (const { name, ok, detail } of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail !== "" ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error(`${String(failed)} 件が期待と違う`);
  process.exit(1);
}
