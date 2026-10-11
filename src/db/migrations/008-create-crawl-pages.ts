/**
 * 008-create-crawl-pages
 *
 * クロールが触った URL 1 つぶんの行。**重複排除・進捗・礼儀の証拠を兼ねる。**
 *
 * ## 重複排除は index が持つ
 *
 * `(crawl_id, url_hash)` の unique index が唯一の重複排除。`url_hash` は `001` と同じ式
 * (`digest(url, 'sha256')` の生成列) なので、呼ぶ側はハッシュを計算しない。
 *
 * 見つけた URL を `ON CONFLICT DO NOTHING` で入れ、**実際に入った行だけを返す**。
 * そうすると「記録する」と「次に取るものを決める」が 1 往復で済み、2 つが食い違う余地が
 * 消える。BrowserHive の `rejectDuplicateUrls` はこの代わりにならない —— あちらは
 * pending と processing しか見ておらず、完了した URL を忘れる。
 *
 * ## なぜ時刻を 2 つ持つのか
 *
 * **礼儀が効いていることは、時刻を測る以外に確かめようが無いから。**
 *
 * 「ホストごとに逐次」「完了から次の投入まで間隔を空ける」は、速く動いたときと
 * 見分けが付かない。`submitted_at` と `finished_at` があれば、同一ホストの区間が
 * 重なっていないこと、そして前の `finished_at` と次の `submitted_at` の差が設定値以上で
 * あることを、後から SQL で確かめられる。守っているつもりで守れていない状態を
 * 検出できるようにしておく。
 *
 * ## 間隔を「完了から」にした理由
 *
 * 取り込みにかかる時間は前もって分からない (2 秒で終わるページも 2 分かかるページも
 * ある)。投入から測った間隔は相手が感じる間隔と無関係で、前が終わった直後に次が
 * 届きうる。**投入時の間引きは効かない。** 間隔は完了の後に置く。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("crawl_pages")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    // #region crawl-pages-columns
    .addColumn("crawl_id", "uuid", (col) =>
      col.notNull().references("crawls.id").onDelete("cascade"),
    )
    .addColumn("url", "text", (col) => col.notNull().check(sql`url <> '' AND url = btrim(url)`))
    // `001` と同じ式。重複排除はこの列の unique index が持つ。
    .addColumn("url_hash", sql`bytea`, (col) =>
      col.generatedAlwaysAs(sql`digest(url, 'sha256')`).stored(),
    )
    // 起点が 0。
    .addColumn("depth", "integer", (col) => col.notNull())
    // 礼儀の単位。URL から取り出して保存する —— 後から測るときに再計算したくない。
    .addColumn("host", "text", (col) => col.notNull())
    // `pending` / `captured` / `failed` / `skipped`。
    // `skipped` は範囲外・robots・上限で落としたもので、**取らなかった理由が残る**。
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("skip_reason", "text")
    // BrowserHive が返した id。台帳の行と繋がる。
    .addColumn("task_id", "text")
    .addColumn("correlation_id", "text")
    // どのページから見つけたか。木の形はこれで復元できる。起点は NULL。
    .addColumn("discovered_from", "bigint", (col) => col.references("crawl_pages.id"))
    // 礼儀の証拠。上の docstring を見ること。
    .addColumn("submitted_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    // #endregion crawl-pages-columns
    .execute();

  await db.schema
    .createIndex("crawl_pages_crawl_id_url_hash_key")
    .on("crawl_pages")
    .columns(["crawl_id", "url_hash"])
    .unique()
    .execute();

  // 「次の段に何が残っているか」を引くため。
  await db.schema
    .createIndex("crawl_pages_crawl_id_depth_idx")
    .on("crawl_pages")
    .columns(["crawl_id", "depth"])
    .execute();

  // 礼儀を測るときに、ホストごとに時刻順で並べるため。
  await db.schema
    .createIndex("crawl_pages_crawl_id_host_idx")
    .on("crawl_pages")
    .columns(["crawl_id", "host", "submitted_at"])
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("crawl_pages").execute();
};
