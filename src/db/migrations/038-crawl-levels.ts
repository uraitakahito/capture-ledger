/**
 * 038-crawl-levels
 *
 * クロールの段 (CAPTURE-180)。1 行が 1 つの段 (クロールの id と深さ)。行を作るときに Windmill の `job_id` を乱数で
 * 決めて持ち、この id が **Windmill への投入 (`?job_id=`)・段の報告 (`Idempotency-Key`)・fail_crawl の鍵** を兼ねる。
 * flow には `level_key` の引数で渡し、flow はそのまま返す。
 *
 * ## 状態
 *
 * - `pending`: 投げる前。最初の段は `crawls` の行と、次の段は前の段の報告済みと同じトランザクションで作る
 * - `sent`: 投げたが、受け取ったかは分からない (時間切れ・繋がらない)。同じ `job_id` で送り直す —— Windmill は
 *   在る id を 400 (`already exists`) で断るので、2 本にはならない
 * - `accepted`: Windmill が受け取った (2xx、または `already exists` の 400)
 * - `reporting`: 段の報告を処理している。`report_token` が試みの印、`lease_until` が期限 (過ぎたら取り直せる)
 * - `reported`: 報告を記録した。`answer` に最初の答えを持ち、同じ鍵の 2 回目にはそれを返す
 * - `abandoned`: 諦めた・締めた (10 分経っても受け取られない、一番新しい段の fail_crawl、人の「締める」)
 *
 * `args` は webhook に送る段そのもの (`DispatchedCrawl` の形)。送り直しと、API を起こし直した後に投げる前の段を送るのに
 * 要る。数 (`pages_captured`・`pages_discovered`) は段ごとに **書き**、クロールの合計は段の和で書き直す —— 報告の
 * やり直しで数が重ならない。
 */
import { sql, type Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // #region crawl-levels
  await db.schema
    .createTable("crawl_levels")
    .addColumn("crawl_id", "uuid", (col) =>
      col.notNull().references("crawls.id").onDelete("cascade"),
    )
    .addColumn("depth", "integer", (col) => col.notNull())
    .addColumn("job_id", "uuid", (col) => col.notNull().unique())
    .addColumn("state", "text", (col) =>
      col
        .notNull()
        .check(sql`state in ('pending', 'sent', 'accepted', 'reporting', 'reported', 'abandoned')`),
    )
    .addColumn("args", "jsonb", (col) => col.notNull())
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    .addColumn("next_attempt_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("sent_at", "timestamptz")
    .addColumn("accepted_at", "timestamptz")
    .addColumn("report_token", "uuid")
    .addColumn("lease_until", "timestamptz")
    .addColumn("reported_at", "timestamptz")
    .addColumn("pages_captured", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("pages_discovered", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("answer", "jsonb")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("crawl_levels_pkey", ["crawl_id", "depth"])
    .execute();
  // #endregion crawl-levels
  // 投げる係の時計が読む行 (投げる前・投げた) だけの index
  await db.schema
    .createIndex("crawl_levels_unsent_idx")
    .on("crawl_levels")
    .column("next_attempt_at")
    .where(sql.ref("state"), "in", sql`('pending', 'sent')`)
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("crawl_levels").execute();
};
