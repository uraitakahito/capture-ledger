/**
 * 044-add-crawl-requester-names
 *
 * クロールを誰が・どこから始めたかを、読める形で行に残す (CAPTURE-450)。`requested_by` は主体の ID (`sub`) で、
 * 人と AI の担当が同じ利用者のトークンを使うと同じ字になり、どの app client から来たかも残らなかった。
 *
 *   - `requested_by_name`: 始めた時の読める名前。人はトークンの `username`、機械は app client の名前
 *   - `requested_client`: どの app client から来たか (`CAPTURE_LEDGER_OIDC_CLIENT_IDS` に書いた名前)
 *   - `requested_actor`: 呼び手が見出し `X-Capture-ledger-Actor` で**申告**した名前 (AI の担当の席の名前など)
 *
 * **3 つとも表示のための物で、認可には使わない。** 許可と `owner` tuple は `requested_by` で書く。
 * 始めた時に写す (後から ID で引かない) —— 手元の IdP は作り直すと client の ID が替わる。
 * 既に在る行と、定期の回・ヘッダの経路は NULL (分からない)。後から書き換えない列。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .addColumn("requested_by_name", "text")
    .addColumn("requested_client", "text")
    .addColumn("requested_actor", "text")
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .dropColumn("requested_by_name")
    .dropColumn("requested_client")
    .dropColumn("requested_actor")
    .execute();
};
