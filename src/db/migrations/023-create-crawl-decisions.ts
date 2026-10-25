/**
 * 023-create-crawl-decisions
 *
 * 規則でリンクをどう決めたか (撮って辿る・撮るだけ・落とす) を、段 × 規則 × ホスト名で 1 行に残す。
 *
 * ## なぜ残すのか
 *
 * 規則で落とした物は、これまでどこにも残らなかった —— 台帳が段の報告の中で決め、次の段に入れなかった
 * だけ。Windmill の run には出ない (判断は台帳に在る) し、出したとしても run の中身は 30 日で消える。
 * 「このドメインを落としたことはあるか」「この規則は 1 度でも当たったか」に答えるには、決めた側が残すしかない。
 *
 * ## 本数は別々の URL
 *
 * 延べ (同じ URL を 10 ページで見つけたら 10) ではなく、その段で見つけた別々の URL の数。同じ段の報告を
 * やり直したら、行を**置き換える** (足さない) —— 報告のやり直しで数が狂わない。
 *
 * ## ホスト名で、ポートは外す
 *
 * ドメインの規則も、ドメインで引く口 (`GET /api/decisions`) も、ホスト名で照らす。ポートを含む
 * `crawl_pages.host` とは形が違う。
 *
 * ## 例は数本まで
 *
 * 1 行が大きくなりすぎないように (`crawl/decisions.ts` の `SAMPLES`)。全部の URL は持たない ——
 * 撮った物は `crawl_pages` に在り、落とした物は「どこを落としたか」が言えればよい。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("crawl_decisions")
    // #region crawl-decisions-columns
    .addColumn("crawl_id", "uuid", (col) =>
      col.notNull().references("crawls.id").onDelete("cascade"),
    )
    // リンク先の深さ。見つけたページの深さ + 1 なので、起点 (0) は来ない。
    .addColumn("depth", "integer", (col) => col.notNull().check(sql`depth > 0`))
    // 当たった規則の番号。1 から数え、0 はどれにも当たらなかった (落とした)。
    .addColumn("rule", "integer", (col) => col.notNull().check(sql`rule >= 0`))
    .addColumn("action", "text", (col) =>
      col.notNull().check(sql`action IN ('follow', 'capture', 'skip')`),
    )
    .addColumn("hostname", "text", (col) => col.notNull().check(sql`hostname <> ''`))
    .addColumn("links", "integer", (col) => col.notNull().check(sql`links > 0`))
    .addColumn("samples", sql`text[]`, (col) => col.notNull())
    // #endregion crawl-decisions-columns
    .addPrimaryKeyConstraint("crawl_decisions_pkey", ["crawl_id", "depth", "rule", "hostname"])
    // どれにも当たらなければ落とす。番号 0 で他の動きは書けない。
    .addCheckConstraint("crawl_decisions_no_rule_skips", sql`rule > 0 OR action = 'skip'`)
    .execute();

  // ドメインから引く口 (`GET /api/decisions`) のため。サブドメインの側は前方の % で index を使えないが、
  // 行の数が少ないうちはそれで足りる。
  await db.schema
    .createIndex("crawl_decisions_hostname_idx")
    .on("crawl_decisions")
    .column("hostname")
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("crawl_decisions").execute();
};
