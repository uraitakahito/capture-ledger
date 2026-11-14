/**
 * 一覧の行の `screenshot` の欄 (CAPTURE-432)。アーカイブの一覧 (`GET /api/archives`) とクロールのページの行
 * (`api/crawls.ts` の `pageOf`) が、同じ形で返す。出すのは読み込みの後 (`after-load`) の 1 枚だけ。
 *
 *   `{ stage, bytes }`    絵が在る (`GET /api/archives/:id/screenshots/:stage` で読める)
 *   `{ stage, skipped }`  BrowserHive が残さなかった (理由は WACZ の `datapackage.json` のまま)
 *   `{ stage, problem }`  欄は在るのに、位置を引けなかった (`archive/stage-screenshots.ts` の理由)
 *   `null`                記録が無い (絵の欄の無い WACZ・まだ検めていない WACZ・WACZ の無いページ)
 *
 * 行は `archive_screenshots` (`041`) を left join して読む。時点は字で埋める (`sql.lit`) —— 引数にすると `$n` の番号が
 * ずれ、ほかの引数の並びを読む試験がそろって変わる。
 */
import { sql, type JoinBuilder } from "kysely";

/** 一覧に出す時点。 */
export const LISTED_STAGE = "after-load";

/** left join した `archive_screenshots` から選ぶ列 (表の名前は `sh`)。 */
export const SCREENSHOT_COLUMNS = [
  "sh.stage as shotStage",
  "sh.skipped as shotSkipped",
  "sh.bytes as shotBytes",
  "sh.problem as shotProblem",
] as const;

/** `archive_screenshots as sh` を、`<アーカイブの id の列>` と一覧の時点で繋ぐ。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely の join の型は呼ぶ側の表で決まる
export const onListedScreenshot = (archiveIdColumn: string) => (join: JoinBuilder<any, any>) =>
  join.onRef("sh.archiveId", "=", archiveIdColumn).on("sh.stage", "=", sql.lit(LISTED_STAGE));

/** join した列。 */
export interface ScreenshotColumns {
  shotStage: string | null;
  shotSkipped: string | null;
  shotBytes: number | null;
  shotProblem: string | null;
}

/** 一覧の行の `screenshot`。 */
export type ListedScreenshot =
  | { stage: string; bytes: number }
  | { stage: string; skipped: string }
  | { stage: string; problem: string }
  | null;

/** join した列から。列の無い行 (undefined) は NULL と同じに扱う。 */
export const screenshotOf = (row: Partial<ScreenshotColumns>): ListedScreenshot => {
  const stage = row.shotStage ?? null;
  if (stage === null) return null;
  if (row.shotSkipped != null) return { stage, skipped: row.shotSkipped };
  if (row.shotProblem != null) return { stage, problem: row.shotProblem };
  if (row.shotBytes != null) return { stage, bytes: row.shotBytes };
  return null;
};
