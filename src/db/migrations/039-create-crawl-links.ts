/**
 * 039-create-crawl-links
 *
 * 撮ったページにあったリンク 1 本ずつと、それがどうなったか (CAPTURE-246)。
 *
 * ## なぜ残すのか
 *
 * 段の報告は、ページごとの `.links.json` を読んで 1 本ずつ規則と上限を当てる。残していたのは数
 * (`crawl_levels.pages_discovered`)・規則 × ホスト名の集計 (`crawl_decisions`)・次の段の行 (`crawl_pages`) だけで、
 * 「どのページのどのリンクを、なぜ撮らなかったか」は捨てていた。`.links.json` は WACZ の外に在り、保管庫を
 * 作り直すと消える。判断は、下した所が残すしかない。
 *
 * ## 1 行は 1 本のリンク
 *
 * `from_page` のページにあった順 (`seq`)。`#` より後ろだけが違う 2 本目は書かない (正規化すると同じ URL)。
 * `outcome` は `crawl/link-outcomes.ts` が決める:
 *
 *   followed   次の段に入れた (この行が、行き先の `crawl_pages.discovered_from` を作った。木の辺)
 *   known      もう行がある (撮り済み・起点・同じ段で先に別のページが見つけた)
 *   max_pages  規則は通したが、枚数の上限で入れなかった
 *   max_depth  規則は通したが、深さの上限で入れなかった
 *   closed     規則は通したが、クロールが締まっていて入れなかった
 *   skip       規則で落とした (`rule` が 0 なら、どれにも当たらなかった)
 *   nofollow   `rel="nofollow"` なので、規則を当てる前に外した (`rule` は NULL)
 *
 * ## 記録の無いクロールと、リンクが 0 本のクロール
 *
 * どちらも行が 0 なので、`crawls.links_recorded_at` で分ける。NULL は「この表を足す前のクロールで、埋め直しても
 * いない」。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("crawl_links")
    // #region crawl-links-columns
    .addColumn("crawl_id", "uuid", (col) =>
      col.notNull().references("crawls.id").onDelete("cascade"),
    )
    // リンクのあったページ。
    .addColumn("from_page", "bigint", (col) =>
      col.notNull().references("crawl_pages.id").onDelete("cascade"),
    )
    // ページの中の順。0 から。
    .addColumn("seq", "integer", (col) => col.notNull().check(sql`seq >= 0`))
    // 正規化したリンク先 (`#` より後ろは無い)。
    .addColumn("url", "text", (col) => col.notNull().check(sql`url <> ''`))
    // `008` と同じ式。行き先のページ (`crawl_pages.url_hash`) と結ぶ。
    .addColumn("url_hash", sql`bytea`, (col) =>
      col.generatedAlwaysAs(sql`digest(url, 'sha256')`).stored(),
    )
    // ポートを外したホスト名 (`crawl_decisions.hostname` と同じ)。
    .addColumn("hostname", "text", (col) => col.notNull().check(sql`hostname <> ''`))
    // リンクの文字。BrowserHive が 200 字で切った物。
    .addColumn("text", "text", (col) => col.notNull().defaultTo(""))
    // 当たった規則の番号。0 はどれにも当たらなかった。規則を当てていない (nofollow) なら NULL。
    .addColumn("rule", "integer", (col) => col.check(sql`rule >= 0`))
    .addColumn("outcome", "text", (col) =>
      col
        .notNull()
        .check(
          sql`outcome in ('followed', 'known', 'max_pages', 'max_depth', 'closed', 'skip', 'nofollow')`,
        ),
    )
    // #endregion crawl-links-columns
    .addPrimaryKeyConstraint("crawl_links_pkey", ["from_page", "seq"])
    .execute();

  // 行き先から引く (入ってくるリンク・URL ごとの最初の 1 本)。
  await db.schema
    .createIndex("crawl_links_crawl_id_url_hash_idx")
    .on("crawl_links")
    .columns(["crawl_id", "url_hash"])
    .execute();

  await db.schema.alterTable("crawls").addColumn("links_recorded_at", "timestamptz").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").dropColumn("links_recorded_at").execute();
  await db.schema.dropTable("crawl_links").execute();
};
