/**
 * クロールの行に添える数の相関副問い合わせ。クロールの一覧と予定の回の一覧で同じ物を使う。
 */
import { sql } from "kysely";

/**
 * 取れなかったページの数 (列は増やさない)。クロールの詳しい所の `failures` は新しい 5 件だけなので、
 * 全体の数はこれで言う。`count` は int8 で node-pg が文字列で返すので `::int` に倒す。
 */
export const pagesFailed = sql<number>`(
  select count(*)::int from crawl_pages p
  where p.crawl_id = crawls.id and p.state = 'failed'
)`;
