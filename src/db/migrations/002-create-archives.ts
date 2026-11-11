/**
 * 002-create-archives
 *
 * WACZ の記録。BrowserHive が実際に生んだ WACZ 1 本につき 1 行。
 *
 * ここの列はどれも **在り処と来歴** —— そのオブジェクトがどこに在り、何が生んだか。
 * `org_id` も `owner_id` も意図して置いていない: 誰がアーカイブを読めるかは関係で
 * あり、関係は tuple として OpenFGA に在る。所有者の列をここに置くと、同じ問いに
 * 対する 2 つ目の、競合する答えを作ることになる。
 *
 * `(bucket, object_key)` を一意にしているのは、同じ取り込みが 2 度以上報告され
 * うるから —— poller と manifest の reconciler の両方が辿り着けるし、どちらも
 * 再実行されうる。この制約が、その経路を重複の源ではなく安全に冪等にしている。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await db.schema
    .createTable("archives")
    // #region archives-columns
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("task_id", "uuid", (col) => col.notNull())
    .addColumn("correlation_id", "text")
    .addColumn("bucket", "text", (col) => col.notNull())
    .addColumn("object_key", "text", (col) => col.notNull())
    .addColumn("source_url", "text", (col) => col.notNull())
    .addColumn("labels", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    // CaptureResultReport.completeness.complete。`false` は、そのアーカイブに
    // 本文が 1 つ以上欠けているという意味 —— 304 としてしか見なかった URL か、
    // 容量の上限を超えて BrowserHive が落としたもの (後者は v1.11.0 で加わった。
    // それ以前、上限に当たった取り込みは `true` と報告していた)。アーカイブを
    // wacz-validator に渡す前に知っておく価値がある。この field より前の取り込みや、
    // 記録しなかった取り込みでは NULL。
    .addColumn("wacz_complete", "boolean")
    // ledger が受け取った時刻ではなく、BrowserHive 自身が付けた取り込みの時刻。
    // reconciler は何時間も後に行を登録しうるので、履歴を並べ替えてはならない。
    .addColumn("captured_at", "timestamptz", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    // #endregion archives-columns
    .execute();

  // 2 つの書き込み経路が揃って頼っている、冪等性の保証。
  await db.schema
    .createIndex("archives_bucket_object_key_key")
    .on("archives")
    .columns(["bucket", "object_key"])
    .unique()
    .execute();

  // reconciler は見つけた manifest ごとに「このタスクは既に知っているか」と訊き、
  // API は新しい順に並べる。
  await db.schema.createIndex("archives_task_id_idx").on("archives").column("task_id").execute();
  await db.schema
    .createIndex("archives_captured_at_idx")
    .on("archives")
    .expression(sql`captured_at DESC`)
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("archives").execute();
  // pgcrypto はそのまま残す —— 001 も依存している。
};
