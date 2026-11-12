/**
 * `crawl_links` (`039`) に書く。段の報告 (`api/crawls.ts`) と埋め直し (`crawl/links-backfill.ts`) が使う。
 */
import type { Kysely } from "kysely";

import type { Database } from "../db/database.js";
import type { LinkRow } from "./link-outcomes.js";

/** 1 回の INSERT に載せる行。行あたりの引数は 8 個で、Postgres の上限 (65,535 個) の内に収める。 */
const CHUNK = 2000;

/**
 * 段のページの行を置き換え、クロールに「記録した」の時刻を立てる。**足さずに置き換える** —— 同じ段の報告を
 * やり直しても、埋め直しを 2 度打っても、行が増えない。`fromPages` はこの段でリンクを読んだページ (リンクが
 * 0 本のページも入る。前に書いた行が在れば消える)。
 *
 * `db` はトランザクションでもよい。段の報告は、次の段のページを入れるのと同じトランザクションで呼ぶ。
 */
export const replaceLinks = async (
  db: Kysely<Database>,
  crawlId: string,
  fromPages: readonly string[],
  rows: readonly LinkRow[],
): Promise<void> => {
  // 空の `in ()` は Postgres が構文エラーにする
  if (fromPages.length > 0) {
    await db
      .deleteFrom("crawlLinks")
      .where("crawlId", "=", crawlId)
      .where("fromPage", "in", [...fromPages])
      .execute();
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insertInto("crawlLinks")
      .values(rows.slice(i, i + CHUNK))
      .execute();
  }
  await db
    .updateTable("crawls")
    .set({ linksRecordedAt: new Date().toISOString() })
    .where("id", "=", crawlId)
    // 最初の時刻を残す (段ごとに書き直さない)
    .where("linksRecordedAt", "is", null)
    .execute();
};

/** クロールの `crawl_pages` の URL → `discovered_from` (起点は null)。`link-outcomes.ts` の `linkRows` に渡す。 */
export const pageParents = async (
  db: Kysely<Database>,
  crawlId: string,
): Promise<Map<string, string | null>> => {
  const rows = await db
    .selectFrom("crawlPages")
    .select(["url", "discoveredFrom"])
    .where("crawlId", "=", crawlId)
    .execute();
  return new Map(rows.map((row) => [row.url, row.discoveredFrom]));
};
