/**
 * 016-add-crawls-last-job
 *
 * 最後に投げた段の Windmill の job を残す。
 *
 * ## なぜ要るのか
 *
 * クロールは段ごとに別の run として Windmill に投げられる (`api/crawls.ts` の
 * `dispatchLevel`)。失敗すると `error` に「[段] 文」が残るが、**どの run だったか**は
 * 分からず、Windmill の Runs を時刻と引数で目で探すしかなかった。webhook は起こした job の
 * id を本文で返しているのに、読み捨てていた。
 *
 * ## 最後の 1 つだけ
 *
 * 失敗はいつも最後に投げた段で起きる (それより前の段は、報告が届いて次の段が投げられた後)。
 * 全段の履歴は Windmill 自身が持っているので、ここは入口の 1 つで足りる。
 *
 * ## NULL の意味
 *
 * 「記録が無い」。この migration より前のクロールと、Windmill が id を返さなかった段。
 * backfill はしない —— 過去の run との対応は DB から言えない。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .addColumn("last_job_id", "text")
    .addColumn("last_job_depth", "integer")
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .dropColumn("last_job_id")
    .dropColumn("last_job_depth")
    .execute();
};
