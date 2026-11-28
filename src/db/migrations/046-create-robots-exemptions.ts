/**
 * 046-create-robots-exemptions
 *
 * robots.txt の例外 (t-6bc6)。組織の admin が「このホストのこの path の型は、robots.txt が断っていても撮る」を
 * 理由・期限・名乗る User-Agent と一緒に登録する (`api/robots-exemptions.ts`)。**この表を足すだけで、クロールの
 * 動きは変わらない** —— 行を読んで判じるのは次の版 (段ごとに引いて flow へ渡す)。
 *
 * ## 行は消さない
 *
 * 取り消しは `revoked_at`・`revoked_by` を立てる。頁の記録と WACZ の申告が行の番号 (`id`) を指すので、行は残す。
 * 延ばす時は新しい行を足す。
 *
 * ## 「効いている行は 1 つ」を index で書かない
 *
 * 同じ組織・ホスト・path の型で効いている行 (取り消していない・期限の前) は 1 つまで。「効いている」は時刻で
 * 変わるので、部分 unique index では書けない (index の述語に now() は置けない)。登録のトランザクションが、
 * 組織とホストの組で錠を取ってから見る (`exemptions/store.ts`)。
 *
 * 字の形 (ホスト・path の型・User-Agent) は登録の時に検査する (`exemptions/validate.ts`)。CHECK で閉じるのは、
 * 語彙の決まった欄と数の下限だけ。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("robots_exemptions")
    // #region robots-exemptions-columns
    // 連番。頁の記録と WACZ の申告が指す。
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("org_id", "text", (col) => col.notNull())
    // `url.host` の形 (小文字・punycode・既定でないポートは残る)。`crawl_pages.host` と同じ語彙。
    .addColumn("host", "text", (col) => col.notNull())
    // robots.txt と同じ書き方 (`*` と末尾の `$`)。既定はホストの全て。
    .addColumn("path_pattern", "text", (col) => col.notNull().defaultTo("/"))
    // seeds は起点 (深さ 0) だけ、links は辿ったリンクも。
    .addColumn("scope", "text", (col) => col.notNull().check(sql`scope IN ('seeds', 'links')`))
    // all は手・定期・AI の担当のどのクロールにも、human は人が始めたクロールにだけ。
    .addColumn("applies_to", "text", (col) =>
      col
        .notNull()
        .defaultTo("all")
        .check(sql`applies_to IN ('all', 'human')`),
    )
    // このホストで名乗る名。
    .addColumn("user_agent", "text", (col) => col.notNull())
    .addColumn("reason", "text", (col) => col.notNull())
    // この行で外して撮る枚数の上限。24 時間で、と、1 クロールの辿ったリンクで。
    .addColumn("daily_limit", "integer", (col) =>
      col
        .notNull()
        .defaultTo(100)
        .check(sql`daily_limit > 0`),
    )
    .addColumn("link_limit", "integer", (col) =>
      col
        .notNull()
        .defaultTo(20)
        .check(sql`link_limit > 0`),
    )
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_by_name", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    // 取り消し。行は消さない。
    .addColumn("revoked_at", "timestamptz")
    .addColumn("revoked_by", "text")
    .addColumn("revoked_by_name", "text")
    // #endregion robots-exemptions-columns
    .execute();

  // 取り消した時刻と主体は、一緒に在るか一緒に無い。
  await sql`
    ALTER TABLE robots_exemptions ADD CONSTRAINT robots_exemptions_revoked_check CHECK (
      (revoked_at IS NULL) = (revoked_by IS NULL)
    )
  `.execute(db);

  // 組織の一覧と、登録の時に同じ組織・ホストの行を見るため。
  await db.schema
    .createIndex("robots_exemptions_org_host_idx")
    .on("robots_exemptions")
    .columns(["org_id", "host"])
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex("robots_exemptions_org_host_idx").execute();
  await db.schema.dropTable("robots_exemptions").execute();
};
