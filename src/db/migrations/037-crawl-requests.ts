/**
 * 037-crawl-requests
 *
 * クロールを始める要求の鍵 (`Idempotency-Key`。CAPTURE-180)。`POST /api/crawls` は鍵を必ず求め、
 * 組織と鍵の組ごとに、最初に始めたクロールの答えを 1 行に覚える。同じ鍵の送り直しには同じ答えを返し、
 * 2 本目を始めない (応答が切れた後の押し直し・送り直し)。
 *
 * - `request_sha256`: 本文の digest (鍵を並べ替えた JSON の sha256)。同じ鍵で違う本文が来たら 422
 * - `answer`: 返した 202 の本文 (`{ crawlId }`)。**覚えるのは始めた答えだけ** —— 走行中の 409 も、
 *   中身の 400 も覚えない (直して同じ鍵で送り直せば始まる)
 * - 24 時間より古い行は、次に始める要求が消す (鍵の期限)
 *
 * 鍵の行は、`crawls` の行と起点のページと同じトランザクションで入れる。同じ鍵が同時に来たら、後ろは
 * 主キーの待ちで前の commit を待ち、前の答えを読む。
 */
import { sql, type Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // #region crawl-requests
  await db.schema
    .createTable("crawl_requests")
    .addColumn("org_id", "text", (col) => col.notNull())
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("request_sha256", "text", (col) => col.notNull())
    .addColumn("crawl_id", "uuid", (col) =>
      col.notNull().references("crawls.id").onDelete("cascade"),
    )
    .addColumn("answer", "jsonb", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("crawl_requests_pkey", ["org_id", "key"])
    .execute();
  // #endregion crawl-requests
  await db.schema
    .createIndex("crawl_requests_created_at_idx")
    .on("crawl_requests")
    .column("created_at")
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("crawl_requests").execute();
};
