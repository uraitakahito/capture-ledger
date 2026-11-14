/**
 * 035-change-digests
 *
 * 前回からの変化 (CAPTURE-167) の、Claude を使わない側の物。
 *
 * - `archive_pages.text_sha256`・`text_chars`・`text_withheld`: 検めるときに `pages.jsonl` の行から入れる
 *   (`replay-bundle/inspect.ts`。もう読んでいる物なので、読み込みは増えない)。digest が同じページは WACZ を開かずに
 *   「同じ」と言える。**文字そのものは持たない** —— 文字は WACZ に在り、全文検索の索引も写しにすぎない
 * - `archives.browserhive_version`・`browser_version`: 撮った BrowserHive と Chrome の版 (BrowserHive WACZ の `datapackage.json` の `browserhive:capture`)。
 *   組の鍵には入れず、前と今で違えば差分の見出しに出す
 * - `crawls.recipe_sha256`: 撮り方の digest (`crawl/recipe-digest.ts`)。新しい行は `crawlValues` が入れ、古い行は
 *   `changes:backfill` が行の列から埋める。索引は「同じ予定・同じ撮り方の前の回」を引くため
 * - `page_changes`: ページ 1 つの差分。2 本の WACZ から作り直せる物だけ (`changes/change-of.ts`)。主キーは
 *   (crawl_id, url) —— 回の中でページの URL は 1 度しか撮らない (`crawl_pages` の重複排除)
 *
 * ## down
 *
 * 足した物を外す。`page_changes` の行は消える (作り直せる物)。
 */
import { sql, type Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("archive_pages")
    .addColumn("text_sha256", "text")
    .addColumn("text_chars", "integer")
    .addColumn("text_withheld", "text")
    .execute();
  await db.schema
    .alterTable("archives")
    .addColumn("browserhive_version", "text")
    .addColumn("browser_version", "text")
    .execute();
  await db.schema.alterTable("crawls").addColumn("recipe_sha256", "text").execute();
  await db.schema
    .createIndex("crawls_schedule_recipe_started_idx")
    .on("crawls")
    .expression(sql`schedule_id, recipe_sha256, started_at desc`)
    .execute();

  // #region page-changes
  await db.schema
    .createTable("page_changes")
    .addColumn("crawl_id", "uuid", (col) =>
      col.notNull().references("crawls.id").onDelete("cascade"),
    )
    .addColumn("prev_crawl_id", "uuid", (col) =>
      col.notNull().references("crawls.id").onDelete("cascade"),
    )
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("archive_id", "uuid", (col) => col.references("archives.id").onDelete("set null"))
    .addColumn("prev_archive_id", "uuid", (col) =>
      col.references("archives.id").onDelete("set null"),
    )
    .addColumn("stage", "text")
    .addColumn("state", "text", (col) =>
      col.notNull().check(sql`state in ('diffed', 'prev_missing')`),
    )
    .addColumn("added", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("removed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("hunks", "jsonb", (col) =>
      col
        .notNull()
        .defaultTo(sql`'[]'::jsonb`)
        .check(sql`jsonb_typeof(hunks) = 'array'`),
    )
    .addColumn("diff_version", "integer", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("page_changes_pkey", ["crawl_id", "url"])
    .execute();
  // #endregion page-changes
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("page_changes").execute();
  await db.schema.dropIndex("crawls_schedule_recipe_started_idx").execute();
  await db.schema.alterTable("crawls").dropColumn("recipe_sha256").execute();
  await db.schema
    .alterTable("archives")
    .dropColumn("browserhive_version")
    .dropColumn("browser_version")
    .execute();
  await db.schema
    .alterTable("archive_pages")
    .dropColumn("text_sha256")
    .dropColumn("text_chars")
    .dropColumn("text_withheld")
    .execute();
};
