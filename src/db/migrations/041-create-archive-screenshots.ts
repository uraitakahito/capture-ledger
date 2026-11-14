/**
 * 041-create-archive-screenshots
 *
 * 節目のスクリーンショット (CAPTURE-8・CAPTURE-432)。BrowserHive WACZ の中の絵 (WARC の `resource`) の在り処を、
 * WACZ を検める時 (`replay-bundle/inspect.ts`) に時点ごとに 1 行ずつ書く (`archive/stage-screenshots.ts`)。
 * 絵そのものは写さない —— 読む時は、ここの位置で保管庫を Range で 1 本読む。
 *
 * ## 1 行は 3 つの形のどれか
 *
 *   位置   `wacz_offset`・`wacz_length`・`bytes`・`record_id` が在る (絵が在る)
 *   理由   `skipped` だけ (BrowserHive が残さなかった。値は `datapackage.json` のまま: secret・withheld など)
 *   問題   `problem` だけ (欄は在るのに位置を引けなかった: no-index-line・warc-not-stored など)
 *
 * 時点と理由の語彙は BrowserHive の物なので、CHECK では閉じない (閉じると、理由が 1 つ増えた日に INSERT が落ちる)。
 *
 * ## 検めていない WACZ と、絵の欄の無い WACZ
 *
 * どちらも行が 0 なので、`archives.screenshots_recorded_at` で分ける。NULL は「絵について検めていない」
 * (この表を足す前に検めた WACZ。`pnpm run screenshots:backfill` が拾う)。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("archive_screenshots")
    // #region archive-screenshots-columns
    .addColumn("archive_id", "uuid", (col) =>
      col.notNull().references("archives.id").onDelete("cascade"),
    )
    // 時点 (`after-load`・`after-behaviors`)。
    .addColumn("stage", "text", (col) => col.notNull().check(sql`stage <> ''`))
    // BrowserHive が残さなかった理由。
    .addColumn("skipped", "text", (col) => col.check(sql`skipped <> ''`))
    // 絵のレコード (gzip の member 1 つ) の、WACZ のオブジェクトの中の位置と長さ。
    .addColumn("wacz_offset", "bigint", (col) => col.check(sql`wacz_offset >= 0`))
    .addColumn("wacz_length", "integer", (col) => col.check(sql`wacz_length > 0`))
    // 絵 (WebP) のバイト数。
    .addColumn("bytes", "integer", (col) => col.check(sql`bytes > 0`))
    // 絵のレコードの WARC-Record-ID (山括弧なし)。読む時に、解いたレコードと照らす。
    .addColumn("record_id", "text", (col) => col.check(sql`record_id <> ''`))
    // 欄は在るのに位置を引けなかった理由。
    .addColumn("problem", "text", (col) => col.check(sql`problem <> ''`))
    // #endregion archive-screenshots-columns
    .addPrimaryKeyConstraint("archive_screenshots_pkey", ["archive_id", "stage"])
    .execute();

  await sql`
    ALTER TABLE archive_screenshots ADD CONSTRAINT archive_screenshots_shape_check CHECK (
         (skipped IS NOT NULL AND problem IS NULL AND wacz_offset IS NULL AND wacz_length IS NULL
           AND bytes IS NULL AND record_id IS NULL)
      OR (skipped IS NULL AND problem IS NULL AND wacz_offset IS NOT NULL AND wacz_length IS NOT NULL
           AND bytes IS NOT NULL AND record_id IS NOT NULL)
      OR (skipped IS NULL AND problem IS NOT NULL AND wacz_offset IS NULL AND wacz_length IS NULL
           AND bytes IS NULL AND record_id IS NULL)
    )
  `.execute(db);

  await db.schema
    .alterTable("archives")
    .addColumn("screenshots_recorded_at", "timestamptz")
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("archives").dropColumn("screenshots_recorded_at").execute();
  await db.schema.dropTable("archive_screenshots").execute();
};
