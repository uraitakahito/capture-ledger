/**
 * 005-add-archives-signed
 *
 * そのアーカイブが wacz-auth の署名を持って出たかを、capture-ledger に残す。
 *
 * ## なぜ `archives` に要るのか
 *
 * 署名は WACZ の中 (`datapackage-digest.json`) にある。だから「在るか」は
 * アーカイブを開けば分かる —— ただし**開かなければ分からない**。capture-ledger の行だけを
 * 見て「この取り込みは証拠として使える形か」を言えないと、10,000 件の中から
 * 署名の付いていないものを探すのに 10,000 回 zip を開くことになる。
 *
 * `wacz_complete` と同じ理由でここに置く。あちらもアーカイブの中の
 * `completeness` を写したもので、capture-ledger から読めることに意味がある。
 *
 * ## NULL を許す理由
 *
 * 3 つの状態を区別する:
 *
 *   true   —— 署名を求め、付いた
 *   false  —— 署名の報告が届き、付いていなかった
 *   NULL   —— そもそも求めていない (あるいは古い行)
 *
 * `false` と `NULL` を潰すと、「署名を求めたのに付かなかった」と「求めていない」が
 * 同じ見た目になる。前者は配備の異常で、後者は正常。
 *
 * なお **`false` の行は普通は capture-ledger に現れない** —— 署名を求めて得られなかった
 * 取り込みは BrowserHive が zip を書く前に失敗させるので、アーカイブ自体が
 * 生まれない。`false` が並び始めたら、それは `--signing` を渡していない実行から
 * 署名の報告だけが届いている、という別の状況を意味する。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("archives").addColumn("signed", "boolean").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("archives").dropColumn("signed").execute();
};
