/**
 * 026-create-derivations
 *
 * **派生の層。** Claude が作った物を、証拠 (WACZ と capture-ledger の行) と分けて残す表。いまの種類は `fix` だけ ——
 * 型で落ちたクロールの、その場の TS の直し方 (`POST /api/crawls/:id/inline/:name/fix`)。WACZ には書かない。
 *
 * ## 何を残すか
 *
 * 作り直して比べられるように、送った入力の digest (`input_sha256`)・答えた model・prompt の版・effort・
 * 往復の回数 (`rounds`)・出力 (`output`)・usage と、そこから数えた費用 (`usd`) を残す。**通らなかった回も
 * 残す** —— Claude を呼んだ分は、答えがどれでもお金が掛かっている。
 *
 * ## 月の上限
 *
 * 組織ごとの月の上限は、この表の `usd` を `org_id` と `created_at` で足して数える。索引はそのため。
 *
 * ## 消さない
 *
 * クロールの行を消すエンドポイントは無い (`crawl_id` は外部キーにしない —— 派生の層は、元の行が無くなっても費用の記録として
 * 読めればよい)。
 */
import { sql, type Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("derivations")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    // 種類。CHECK は置かない (`006` と同じ判断。値はコードが決める)
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("org_id", "text", (col) => col.notNull())
    .addColumn("crawl_id", "uuid")
    // 何に対する物か (fix なら `{ crawlId, inline }`)
    .addColumn("target", "jsonb", (col) =>
      col.notNull().check(sql`jsonb_typeof(target) = 'object'`),
    )
    .addColumn("input_sha256", "text", (col) => col.notNull())
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("prompt_version", "text", (col) => col.notNull())
    .addColumn("effort", "text", (col) => col.notNull())
    .addColumn("rounds", "integer", (col) => col.notNull())
    .addColumn("output", "jsonb", (col) =>
      col.notNull().check(sql`jsonb_typeof(output) = 'object'`),
    )
    .addColumn("usage", "jsonb", (col) => col.notNull().check(sql`jsonb_typeof(usage) = 'object'`))
    .addColumn("usd", "numeric(12, 6)", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex("derivations_org_created_idx")
    .on("derivations")
    .columns(["org_id", "created_at"])
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("derivations").execute();
};
