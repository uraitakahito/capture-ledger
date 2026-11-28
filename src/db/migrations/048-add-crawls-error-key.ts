/**
 * 048-add-crawls-error-key
 *
 * クロールの `error` の字に、文の鍵と埋めた値を添える (t-evv8)。
 *
 * `error` は 1 つの言語 (日本語) の字で、画面を英語にしても日本語のまま出ていた。capture-ledger が
 * 自分で書く文 (1 枚も撮れずに終わった時の文・`crawl/close.ts`) には、どの文かと、埋めた値を残し、
 * 返す時に辞書で組めるようにする (`i18n/messages.ts`)。
 *
 * ## `crawls.error_key`・`crawls.error_params`
 *
 * 鍵は `i18n/messages.ts` の `MESSAGE_KEYS` の名前、値はその文に埋めた物 (名前 → 字か数)。**どちらも、
 * capture-ledger が自分で書いた文にだけ入る。** flow が報告した文・人が打った字・ほかの道具の文は
 * null のまま (`error` の字をそのまま返す)。`error` の列は消さない —— 鍵の無い行の答えで、鍵の在る行でも
 * 文を組めなかった時の倒れ先になる。
 *
 * ## 既に在る行を埋める
 *
 * capture-ledger が書いた決まった形の字 (`close.ts` の文と、`030` が過去の行に書いた文) を読み解いて、
 * 鍵と値を入れる。**読み解いた鍵と値から字を組み直し、元の字と 1 字も違わない行だけ**を埋める (`readStored`)。
 * 違う行は触らない —— その行は、今までどおり `error` の字で返る。`error` の列は 1 字も書き換えない。
 *
 * 雛形は、この file の中に固める (辞書を import しない)。辞書の字は後から直されるが、ここで読むのは
 * この migration より前に保存された字で、その形は変わらない。
 */
import { sql, type Kysely } from "kysely";

/** 鍵と値。`i18n/messages.ts` の `Message` と同じ形 (この file は、その時の形を固めて持つ)。 */
export interface StoredMessage {
  key: string;
  params: Record<string, string | number>;
}

const BACKFILLED = "1 枚も撮れませんでした（030 で直した過去の行）";
const countsOf = (failed: number, skipped: number): string =>
  `1 枚も撮れませんでした（取れず ${String(failed)}・見送り ${String(skipped)}）。`;
const REASON = "最初の理由: ";
// 理由は改行を含みうる (BrowserHive の文) ので、`.` でなく [\s\S] で受ける
const SHAPE = /^1 枚も撮れませんでした（取れず (\d+)・見送り (\d+)）。(?:最初の理由: ([\s\S]*))?$/u;

/**
 * 保存された `error` の字を、鍵と値に読み解く。**組み直して元の字と同じにならなければ undefined**
 * (数の頭の 0・安全に持てない大きさの数など)。capture-ledger が書いた形でない字も undefined。
 */
export const readStored = (error: string): StoredMessage | undefined => {
  if (error === BACKFILLED) return { key: "crawl.nothingCapturedBackfilled", params: {} };
  const match = SHAPE.exec(error);
  if (match === null) return undefined;
  const failed = Number(match[1]);
  const skipped = Number(match[2]);
  const reason = match[3];
  const rebuilt = countsOf(failed, skipped) + (reason === undefined ? "" : REASON + reason);
  if (rebuilt !== error) return undefined;
  return reason === undefined
    ? { key: "crawl.nothingCaptured", params: { failed, skipped } }
    : { key: "crawl.nothingCapturedBecause", params: { failed, skipped, reason } };
};

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    // #region crawls-error-key
    // `error` の文の鍵 (`i18n/messages.ts` の MESSAGE_KEYS)。capture-ledger が自分で書いた文にだけ入る。
    .addColumn("error_key", "text")
    // その文に埋めた値 (名前 → 字か数)。鍵と一緒に入る。返す時に、頼まれた言語の辞書で組む。
    .addColumn("error_params", "jsonb", (col) =>
      col.check(sql`error_params IS NULL OR jsonb_typeof(error_params) = 'object'`),
    )
    // #endregion crawls-error-key
    .execute();

  const rows = await sql<{ id: string; error: string }>`
    select id, error from crawls where error like '1 枚も撮れませんでした%'
  `.execute(db);
  for (const row of rows.rows) {
    const stored = readStored(row.error);
    if (stored === undefined) continue;
    await sql`
      update crawls
         set error_key = ${stored.key}, error_params = ${JSON.stringify(stored.params)}::jsonb
       where id = ${row.id}
    `.execute(db);
  }
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").dropColumn("error_params").execute();
  await db.schema.alterTable("crawls").dropColumn("error_key").execute();
};
