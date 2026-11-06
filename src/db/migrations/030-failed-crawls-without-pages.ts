/**
 * 030-failed-crawls-without-pages
 *
 * **`succeeded` は 1 枚以上撮れたクロールだけ。** 段の報告は次の段が 0 本なら締めるので、これまでは枚数を見ずに
 * `succeeded` にしていた (`src/crawl/close.ts`)。報告の側を直しただけでは、過去の行が緑の「完走」のまま残るので、
 * 同じ決まりに揃える。これで dashboard は古い行のための分岐を持たずに済む。
 *
 * ## down は何もしない
 *
 * 戻す先を区別できない。`stop_reason` は `failed` で上書きするので、元が `completed` か `max_depth` かは残らない。
 */
import { sql, type Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`
    update crawls
       set state = 'failed',
           stop_reason = 'failed',
           error = coalesce(error, '1 枚も撮れませんでした（030 で直した過去の行）')
     where state = 'succeeded' and pages_captured = 0
  `.execute(db);
};

export const down = async (): Promise<void> => {
  await Promise.resolve();
};
