/**
 * 025-add-crawl-pages-log-counts
 *
 * そのページの取り込みのログ (BrowserHive が答えと `.result.json` に載せる `log`) の、level ごとの
 * 行の数と、残さなかった行の数。**数だけを持ち、行は持たない。** 行を読むのは
 * `GET /api/crawls/:id/pages/:page/log` で、そのたびに `.result.json` を保管庫から読む。
 *
 * level ごとの数は残さなかった行も数える。残さなかった行 (`dropped`) は、上限で捨てた行と、方針で伏せた
 * 文書のページの行の合計 —— どちらも BrowserHive の契約の決まりで、台帳は写すだけ。
 *
 * ここで言う「ログ」は取り込みのログ (ページで走ったスクリプト・ページ自身・BrowserHive が書いた行) で、
 * `006` や `009` の「log」(台帳のプロセスが書く pino の行) とは別の物。
 *
 * ## 形
 *
 * `{ "debug": 0, "info": 12, "warn": 1, "error": 0, "dropped": 0 }`。`log.counts` の 4 つに
 * `log.dropped` を足した物で、`GET /api/crawls/:id/pages` の `logCounts` にそのまま出る。level ごとの int の
 * 列にしないのは、level の顔ぶれが BrowserHive の契約の物だから —— 列にすると、level が増えるたびに
 * migration が要る。書くときは JSON の文字列 (`crawls.variables` と同じ扱い)。
 *
 * ## NULL の意味は 1 つだけ
 *
 * NULL は「この行の取り込みの `.result.json` から、数を読んでいない」。`009` の `indexed_at` と同じく、
 * 読めなかった理由は列に残さない —— 取り込みが無い (pending・skipped・flow が切った・断られた)、
 * `.result.json` の場所が記録されていない、読みに行って落ちた、`log` を持たない (BrowserHive v24.0.0 より
 * 前) のどれでも NULL。どれだったかは log の口が `reason` で答え、台帳のログにも出る。**表に理由を溜めると、
 * それを掃除する仕事が生まれる。**
 *
 * ## 導けるものを持つ理由
 *
 * 数は `.result.json` から導ける。`009` は「導けるものを保存」を退けたが、ここは事情が違う。1 つは、
 * ページの一覧が全部のページの数を 1 度に返すこと —— 一覧のたびに N 本の `.result.json` を読むことに
 * なる (capture-workbench は走行中のクロールを 2 秒ごとに引き直す)。もう 1 つは、**終わった取り込みの事実**で
 * 書き換えも掃除も要らないこと。`archives.wacz_complete`・`signed` (`005`) と同じ扱い。
 *
 * 書くのは段の登録 (`crawl/admit-level.ts` が manifest を読んだ所) と reconcile で、どちらも上書き
 * なので、同じ段の報告がやり直されても値は変わらない。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawl_pages")
    // 形を見るのは object かどうかだけ (`024` の jsonb の列と同じ)。NULL は CHECK を通る
    .addColumn("log_counts", "jsonb", (col) => col.check(sql`jsonb_typeof(log_counts) = 'object'`))
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawl_pages").dropColumn("log_counts").execute();
};
