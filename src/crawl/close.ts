/**
 * 1 枚も撮れずに終わったクロールの `error` の文。
 *
 * ## `succeeded` は 1 枚以上撮れたクロールだけ
 *
 * 次の段が 0 本なら締めるので、枚数を見ないと、全部のページが取れなかったクロールも `succeeded` で終わる。
 * 実際に踏んだ: 保管庫が満杯で WACZ を書けなかったクロールと、撮る相手が 404 を返したクロールが、capture-workbench に
 * 緑の「完走」で並んでいた。
 *
 * **全部を見送った (robots) クロールも失敗にする。** 決まりが 1 行で済み、文に見送りの数が出るので理由も読める。
 *
 * ## 報告の `results` だけで組む
 *
 * flow は撮れたページのリンクしか報告しない (capture-scheduler の crawl_host) ので、1 枚も撮れていなければ
 * 次の段は生まれない。だから締める報告の `results` が起点の全部で、数えるために DB を引き直さなくていい。
 */
import type { CrawlPageState } from "../db/database.js";
import { message, say, type Message } from "../i18n/messages.js";

/** 文に入れる理由の長さの上限。ページの理由は BrowserHive の文で、長さの約束が無い。 */
const REASON_MAX = 200;

/** `results` の 1 件のうち、文に要る欄。 */
export interface ClosedPage {
  status: Exclude<CrawlPageState, "pending">;
  skipReason?: string;
}

/**
 * 片割れのサロゲートを U+FFFD に替える。**200 字で切ると、絵文字などのサロゲートの対を半分に割りうる**し、
 * BrowserHive の文が、もともと片割れを持つこともありうる。片割れは `JSON.stringify` が `\ud83d` と書き、
 * Postgres の jsonb はそれを断る —— 値 (`error_params`) を書く UPDATE ごと落ち、行が走ったまま残って、
 * 次のクロールを塞ぐ。text の列 (`error`) は、node-postgres が同じ字を U+FFFD に替えて通していたので、
 * 先に替えておけば、保存される字は今までと同じになる。
 *
 * `u` の旗があるので、揃った対は 1 字として読まれ、当たるのは片割れだけ。
 * (`String.prototype.toWellFormed` は ES2024 で、この repo の lib は ES2023。)
 */
const wellFormed = (text: string): string => text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");

/**
 * 1 枚も撮れずに終わったクロールの文。鍵と値で返す —— 行には字 (`error`) と一緒に鍵と値を残し、
 * 返す時に、頼まれた言語で組めるようにする (`i18n/messages.ts`)。
 */
export const nothingCaptured = (results: readonly ClosedPage[]): Message => {
  const failed = results.filter((page) => page.status === "failed");
  const skipped = results.filter((page) => page.status === "skipped");
  const reason = (failed[0] ?? skipped[0])?.skipReason;
  return reason === undefined
    ? message("crawl.nothingCaptured", { failed: failed.length, skipped: skipped.length })
    : message("crawl.nothingCapturedBecause", {
        failed: failed.length,
        skipped: skipped.length,
        reason: wellFormed(reason.slice(0, REASON_MAX)),
      });
};

/** 行の `error` に書く字。日本語の辞書で組む (保存する字は日本語のまま。鍵の在る行は、返す時に組み直す)。 */
export const nothingCapturedError = (results: readonly ClosedPage[]): string =>
  say(nothingCaptured(results), "ja");
