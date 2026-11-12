/**
 * 段の報告の鍵と数 (CAPTURE-180・`038`)。
 *
 * 段の報告は保管庫を読むので 1 つのトランザクションにしない。段の行の状態 (`reporting`)・期限 (`lease_until`)・
 * 試みの印 (`report_token`) で区切り、終わりの commit だけをトランザクションにする (`api/crawls.ts`)。
 */
import { sql, type Kysely } from "kysely";

import type { Database } from "../db/database.js";

/**
 * 報告中の期限。過ぎれば、同じ段の次の報告が取り直せる (処理の途中で API が落ちたとき)。flow の report_level の再試行
 * (capture-scheduler・30 秒の間隔で 5 回 = 2 分半) より短くして、再試行が尽きる前に取り直せるようにする。
 */
export const LEVEL_REPORT_LEASE_MS = 2 * 60_000;

/** 段の報告に鍵が無い・形が違うときの 400 の本文。 */
export const MISSING_LEVEL_KEY = {
  error: "Idempotency-Key header is required (the level_key of this level)",
};

/** 終わりの commit の前に、別の試みが段の報告を取り直していた (期限切れ)。この試みは何も残さない。 */
export class Superseded extends Error {
  constructor() {
    super("another attempt took over this level report");
  }
}

/**
 * クロールの合計を段の行の和で書き直し、書いた値を返す。**足し算をしない** —— 報告のやり直しで数が重ならない。
 * `db` はトランザクションでもよい。
 */
export const writeTotals = async (
  db: Kysely<Database>,
  crawlId: string,
): Promise<{ pagesCaptured: number; pagesDiscovered: number }> => {
  const totals = await db
    .selectFrom("crawlLevels")
    .select([
      sql<number>`coalesce(sum(pages_captured), 0)::int`.as("pagesCaptured"),
      sql<number>`coalesce(sum(pages_discovered), 0)::int`.as("pagesDiscovered"),
    ])
    .where("crawlId", "=", crawlId)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("crawls")
    .set({ pagesCaptured: totals.pagesCaptured, pagesDiscovered: totals.pagesDiscovered })
    .where("id", "=", crawlId)
    .execute();
  return totals;
};
