/**
 * 047-add-robots-exemption-to-crawls
 *
 * robots.txt の例外 (`046`) を、クロールに効かせる (t-6bc6)。段を起こすたびに、効く行を引いて flow へ渡し
 * (`exemptions/dispatch.ts`)、flow が外して撮った頁を報告で受ける。
 *
 * ## `crawls.exemption_eligibility` —— 資格は、始める時に 1 度だけ決めて残す
 *
 * `none` (どの行も当てない)・`machine` (`applies_to = 'all'` の行だけ)・`human` (全ての行)。決めるのは
 * `exemptions/eligibility.ts` で、主体が**クロールの組織**で `can_submit` を持つかを見る —— クロールの組織は
 * 名乗りの 1 つ目で、始めてよいと許した組織とは限らない (`maySubmit`) ので、行に残さず段ごとに引くだけだと、
 * 許しの無い組織の例外が当たる。既に在る行は `none`。後から書き換えない列。
 *
 * ## `crawl_pages.robots_exemption_id` —— 外した頁にだけ入る
 *
 * robots.txt が実際に断っていて、例外の行で外した頁にだけ、その行の番号が入る (段の報告の `robotsExemptionId`)。
 * 行の名乗りで撮っただけの頁 (断られていない頁) には入らない。例外の行は消さない表なので、参照の ON DELETE は
 * 既定のまま (消そうとすれば断る)。
 *
 * 枚数の上限 (`daily_limit`・`link_limit`) は、この列で数える。24 時間の数は行の番号と `finished_at` で引くので、
 * その 2 つの部分 index を足す (外した頁はごく僅かなので、入っている行だけ)。
 */
import { sql, type Kysely, type SqlBool } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    // #region crawls-exemption-eligibility
    // robots.txt の例外の資格。始める時に 1 度決める。none・machine・human。
    .addColumn("exemption_eligibility", "text", (col) =>
      col
        .notNull()
        .defaultTo("none")
        .check(sql`exemption_eligibility IN ('none', 'machine', 'human')`),
    )
    // #endregion crawls-exemption-eligibility
    .execute();

  await db.schema
    .alterTable("crawl_pages")
    // #region crawl-pages-robots-exemption
    // robots.txt が断っていて、例外の行で外した頁にだけ入る。その行の番号。
    .addColumn("robots_exemption_id", "bigint", (col) => col.references("robots_exemptions.id"))
    // #endregion crawl-pages-robots-exemption
    .execute();

  // 行ごとの「24 時間で外した枚数」を数えるため。外した頁だけ。
  await db.schema
    .createIndex("crawl_pages_robots_exemption_idx")
    .on("crawl_pages")
    .columns(["robots_exemption_id", "finished_at"])
    .where(sql<SqlBool>`robots_exemption_id IS NOT NULL`)
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex("crawl_pages_robots_exemption_idx").execute();
  await db.schema.alterTable("crawl_pages").dropColumn("robots_exemption_id").execute();
  await db.schema.alterTable("crawls").dropColumn("exemption_eligibility").execute();
};
