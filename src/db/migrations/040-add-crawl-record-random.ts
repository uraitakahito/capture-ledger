/**
 * 040-add-crawl-record-random
 *
 * 頁の JS が受け取った乱数を BrowserHive に控えさせるか (CAPTURE-378)。`POST /api/crawls` の `recordRandom` を行に固定し、
 * 段ごとに flow へ運ぶ。控えそのものは BrowserHive WACZ の `random/values.jsonl` に、数は `.result.json` の `random` に在る。
 * 既に在る行は false (頼んでいない)。後から書き換えない列。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .addColumn("record_random", "boolean", (col) => col.notNull().defaultTo(false))
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").dropColumn("record_random").execute();
};
