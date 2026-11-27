/**
 * 045-add-schedule-run-requester
 *
 * 定期実行で、誰が予定を作り・誰が「いま撮る」を押したかを読める形で残す (CAPTURE-450)。
 *
 * 定期の回の主体 (`crawls.requested_by`) は**予定を作った主体**で、「いま撮る」の回でも変えない ——
 * 予定の中身 (シークレットの参照など) は作った主体の名前で解くので、押す人で回の動きが変わってはいけない。
 * そのため、押した人は行に残っていなかった (ログにだけ出していた)。
 *
 *   - `crawl_schedules.created_by_name`: 予定を作った時の読める名前 (回の `requested_by_name` に写る)
 *   - `crawl_schedules.run_requested_by`・`run_requested_by_name`: 待っている「いま撮る」を押した主体と名前。
 *     `run_requested_at` と一緒に立て、一緒に消す
 *   - `crawls.run_requested_by`・`run_requested_by_name`: その回の「いま撮る」を押した主体と名前
 *
 * どれも表示のための物で、認可には使わない。既に在る行と、期限の回は NULL。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawl_schedules")
    .addColumn("created_by_name", "text")
    .addColumn("run_requested_by", "text")
    .addColumn("run_requested_by_name", "text")
    .execute();
  await db.schema
    .alterTable("crawls")
    .addColumn("run_requested_by", "text")
    .addColumn("run_requested_by_name", "text")
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .dropColumn("run_requested_by")
    .dropColumn("run_requested_by_name")
    .execute();
  await db.schema
    .alterTable("crawl_schedules")
    .dropColumn("created_by_name")
    .dropColumn("run_requested_by")
    .dropColumn("run_requested_by_name")
    .execute();
};
