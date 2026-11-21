/**
 * 042-add-archives-source-url-hash
 *
 * 同じ URL の取り込みを、撮った時刻の新しい順に引くための列と索引 (CAPTURE-462。`changes/history.ts`)。
 *
 * - `archives.source_url_hash`: `008` (`crawl_pages.url_hash`)・`039` (`crawl_links.url_hash`) と同じ式の生成列。
 *   URL そのものに索引を張らないのは、長い URL が索引の 1 行の上限 (btree で約 2,700 バイト) に当たるため
 * - `archives_source_url_hash_captured_at_idx`: `(source_url_hash, captured_at desc)`。引く SQL は
 *   `source_url_hash = digest($1, 'sha256') and source_url = $1` の形 (digest がぶつかった別の URL を返さない)
 *
 * ## 表を書き直す
 *
 * stored の生成列を足すと、Postgres は `archives` の全部の行を書き直す。その間は表に書けない (ACCESS EXCLUSIVE)。
 * 行が多い DB では、取り込みを受けていない時に流すこと。
 *
 * ## down
 *
 * 索引、列の順に外す。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("archives")
    .addColumn("source_url_hash", sql`bytea`, (col) =>
      col.generatedAlwaysAs(sql`digest(source_url, 'sha256')`).stored(),
    )
    .execute();
  await db.schema
    .createIndex("archives_source_url_hash_captured_at_idx")
    .on("archives")
    .expression(sql`source_url_hash, captured_at DESC`)
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex("archives_source_url_hash_captured_at_idx").execute();
  await db.schema.alterTable("archives").dropColumn("source_url_hash").execute();
};
