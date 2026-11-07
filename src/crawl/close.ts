/**
 * 1 枚も撮れずに終わったクロールの `error` の文。
 *
 * ## `succeeded` は 1 枚以上撮れたクロールだけ
 *
 * 次の段が 0 本なら締めるので、枚数を見ないと、全部のページが取れなかったクロールも `succeeded` で終わる。
 * 実際に踏んだ: 保管庫が満杯で WACZ を書けなかったクロールと、撮る相手が 404 を返したクロールが、capture-workbench に
 * 緑の「完走」で並び、定期のクロールの入口 (`trigger_crawl`) も成功と報告していた。
 *
 * **全部を見送った (robots) クロールも失敗にする。** 決まりが 1 行で済み、文に見送りの数が出るので理由も読める。
 *
 * ## 報告の `results` だけで組む
 *
 * flow は撮れたページのリンクしか報告しない (capture-scheduler の crawl_host) ので、1 枚も撮れていなければ
 * 次の段は生まれない。だから締める報告の `results` が起点の全部で、数えるために台帳を引き直さなくていい。
 */
import type { CrawlPageState } from "../db/database.js";

/** 文に入れる理由の長さの上限。ページの理由は BrowserHive の文で、長さの約束が無い。 */
const REASON_MAX = 200;

/** `results` の 1 件のうち、文に要る欄。 */
export interface ClosedPage {
  status: Exclude<CrawlPageState, "pending">;
  skipReason?: string;
}

export const nothingCapturedError = (results: readonly ClosedPage[]): string => {
  const failed = results.filter((page) => page.status === "failed");
  const skipped = results.filter((page) => page.status === "skipped");
  const counts = `1 枚も撮れませんでした（取れず ${String(failed.length)}・見送り ${String(skipped.length)}）。`;
  const reason = (failed[0] ?? skipped[0])?.skipReason;
  return reason === undefined ? counts : `${counts}最初の理由: ${reason.slice(0, REASON_MAX)}`;
};
