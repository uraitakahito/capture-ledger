/**
 * 段の報告の鍵と数 (CAPTURE-180・`038`)。
 *
 * 段の報告は保管庫を読むので 1 つのトランザクションにしない。段の行の状態 (`reporting`)・期限 (`lease_until`)・
 * 試みの印 (`report_token`) で区切り、終わりの commit だけをトランザクションにする (`api/crawls.ts`)。
 */
import { sql, type Kysely } from "kysely";

import type { Database } from "../db/database.js";
import { distinctDiscovered } from "./links-read.js";

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
 * クロールの合計を書き直し、**段の行の和**を返す。**足し算をしない** —— 報告のやり直しで数が重ならない。
 * `db` はトランザクションでもよい。
 *
 * 撮れた数は段の行の和。**見つけたリンクの数 (`crawls.pages_discovered`・一覧の「リンク」) は、リンクの記録
 * (`crawl_links`・`039`) が在れば、規則が通した別々の URL の数** (`links-read.ts` の `distinctDiscovered`)。
 * 段の和は延べで、別の段で同じ URL が出ると 2 度数える —— 記録の無いクロールだけ、今までどおり延べを書く。
 * リンクを残した**後**に呼ぶこと。
 *
 * 返す `pagesDiscovered` は段の和のまま。`no_links` (規則が通したリンクが 1 本も無い) の判定は、これで見る。
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
  const distinct = await distinctDiscovered(db, crawlId);
  await db
    .updateTable("crawls")
    .set({
      pagesCaptured: totals.pagesCaptured,
      pagesDiscovered: distinct ?? totals.pagesDiscovered,
    })
    .where("id", "=", crawlId)
    .execute();
  return totals;
};
