/**
 * 036-crawl-changes
 *
 * 前回からの変化 (CAPTURE-167) の、予定の回ごとの状態。1 回に 1 行。周回 (`changes/worker.ts`) が作り、進める。
 *
 * ## 状態
 *
 * - `comparing`: 比べている (Claude なし)。`lease_until` を過ぎていれば、次の周回が拾い直す (API が落ちた後)
 * - `no_previous`: 同じ予定・同じ撮り方 (`recipe_sha256`) の前の回が無い。終わり
 * - `unchanged`: どのページも文字の digest が同じ。保管庫も Claude も呼ばない。終わり
 * - `diffed`: 違うページがあり、差分を `page_changes` に残した。鍵が無ければここで終わり、在れば要約へ
 * - `summarizing`: Claude を待っている。`lease_until` を過ぎていれば拾い直す
 * - `summarized`: 要約を派生の層 (`derivations`) に残した。終わり
 * - `budget_wait`: 組織の月の上限に届いた。`next_attempt_at` に見直す (月が替わるか、上限を上げると進む)
 * - `failed`: Claude が 3 回続けて答えなかった・断った。終わり。workbench の帯に出す
 *
 * `significance` と `headline` は要約の写し (一覧と予定の回が派生の層を開かずに読むため)。正は派生の層。
 */
import { sql, type Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // #region crawl-changes
  await db.schema
    .createTable("crawl_changes")
    .addColumn("crawl_id", "uuid", (col) =>
      col.primaryKey().references("crawls.id").onDelete("cascade"),
    )
    .addColumn("schedule_id", "uuid", (col) => col.notNull())
    .addColumn("org_id", "text", (col) => col.notNull())
    .addColumn("prev_crawl_id", "uuid", (col) => col.references("crawls.id").onDelete("set null"))
    .addColumn("state", "text", (col) =>
      col
        .notNull()
        .check(
          sql`state in ('comparing', 'no_previous', 'unchanged', 'diffed', 'summarizing', 'summarized', 'budget_wait', 'failed')`,
        ),
    )
    .addColumn("pages_compared", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("pages_changed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("significance", "text", (col) =>
      col.check(sql`significance in ('none', 'minor', 'content')`),
    )
    .addColumn("headline", "text")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("next_attempt_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("lease_until", "timestamptz")
    .addColumn("derivation_id", "uuid", (col) =>
      col.references("derivations.id").onDelete("set null"),
    )
    .addColumn("error", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  // #endregion crawl-changes
  await db.schema
    .createIndex("crawl_changes_pick_idx")
    .on("crawl_changes")
    .columns(["state", "next_attempt_at"])
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("crawl_changes").execute();
};
