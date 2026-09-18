/**
 * 014-add-capture-submissions-manifest
 *
 * その取り込みの結果 manifest (`.result.json`) が **どこに書かれたか**、または
 * **なぜ台帳が読めないか**。
 *
 * ## 台帳は鍵を組まない
 *
 * 鍵を知っているのは書いた本人 (BrowserHive か受け口) だけで、その答えは `Capture` の
 * 応答に載り、flow が段の報告で運んでくる。ここに書き留め、読む側 (段の登録と
 * reconcile) はこの列だけを使う。
 *
 * 以前は台帳が鍵を 2 通りのやり方で作り直していた —— BrowserHive の命名規則を写して
 * 綴りを組むか、bucket を一覧して URL 符号化を戻すか。前者は間違えても静かに壊れ、
 * 後者は空白を `+` のまま戻して別の名前を作った。どちらも「他人が書いた鍵を推測する」
 * 形で、答えを持っている相手に訊けば要らなかった。
 *
 * ## どちらか一方は schema が守る
 *
 * `taskId` を持つ報告は `manifestLocation` か `manifestError` のちょうど 1 つを持つ
 * (`api/crawls.ts` の段の報告の schema)。**DB の制約にはしない** —— この repo には DB を
 * 立てる試験の土台が無く、制約の誤りは全検査を緑で素通りする。
 *
 * ## 既存の行
 *
 * 両方 NULL のまま。backfill もしない —— 過去の取り込みの manifest がどこに在るかを
 * DB からは言えず、それを推測で埋めるのはこの列が塞ぐ穴そのもの。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("capture_submissions")
    // #region capture-submissions-manifest-columns
    // bucket を除いた鍵。報告が運んだ場所をそのまま —— 台帳は組まない。
    .addColumn("manifest_key", "text")
    // 書けなかった理由、または台帳には読めない場所だった理由。
    .addColumn("manifest_error", "text")
    // #endregion capture-submissions-manifest-columns
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("capture_submissions")
    .dropColumn("manifest_error")
    .dropColumn("manifest_key")
    .execute();
};
