/**
 * 031-add-crawl-user-agent
 *
 * クロールごとの User-Agent。`POST /api/crawls` が受け、**打った字のまま**行に固定する —— `{chrome}` は解かない
 * (解くのは、繋いだ browser の字を知っている BrowserHive で、解いた字は BrowserHive WACZ の `settings.userAgent` に残る)。
 * `null` は「指定なし」で、既に在る行も `null` のまま。後から書き換えない列。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").addColumn("user_agent", "text").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").dropColumn("user_agent").execute();
};
