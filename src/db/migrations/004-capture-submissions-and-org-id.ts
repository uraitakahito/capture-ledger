/**
 * 004-capture-submissions-and-org-id
 *
 * 投げた時点で、その取り込みがどの組織のためのものだったかを覚えておく。
 *
 * ## このテーブルが要る理由
 *
 * `archives` は 2 方向から埋まる。poller は自分でジョブを投げたばかりなので組織を知って
 * いる。manifest の reconciler は知らない: bucket から `.result.json` を読むだけで、
 * BrowserHive に組織という概念が無い以上、その文書には誰のための取り込みだったかを
 * 言うものが何も無い。
 *
 * もう一方の道 —— 組織を `correlationId` に埋め込んで、読むときに解析し直す ——
 * は採らなかった。合意でしか保たれていない約束事は、手で取り込みを投げた最初の
 * 呼び出しに破られる。テーブルは破られない。
 *
 * リクエストを送る前に書くので、直後に ledger が死んでも、BrowserHive が受理した
 * 取り込みの帰属は必ず言える。
 *
 * ## `source_url` は最初から作らない —— **履歴を書き換えた**
 *
 * かつてここに `source_url` があった。**誰も読んでいなかった** —— この表を引くのは
 * `archive/reconcile.ts` だけで、取るのは `org_id` と `submitted_by`（帰属）であって
 * URL ではない。落とす migration を別に足す形も採れたが、そうすると docs が埋め込む
 * この抜粋は「作った時点の形」を映し続け、**存在しない列を見せ続ける**。
 *
 * だから列ごと歴史から消した。`001` で `urls` を `capture_targets` に改めたときと同じ手。
 *
 * **ファイル名も変えてある。** 中身だけ変えると、既に migrate 済みの DB では
 * kysely が何も言わずに通り、列が残ったまま食い違う。名前を変えれば
 * `corrupted migrations` で**声を上げて止まる** —— 古い DB は作り直すこと。
 *
 * 投げた URL を後から知りたくなったら `crawl_pages`（`url` と `task_id` を持つ）から
 * 引く。`crawl_pages.task_id` は `text`、こちらは `uuid` なので `::text` の cast が要る。
 *
 * ## `capture_targets.org_id`
 *
 * ある URL がどの組織のために撮られるかは、成果物の性質ではなく取り込みへの入力
 * なので、URL の隣に属する。既存の行には `default` が入る —— 組織のディレクトリは
 * まだ無く、この識別子は `organization:<id>` の tuple と一致していればよい
 * 単なる文字列。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("capture_targets")
    .addColumn("org_id", "text", (col) => col.notNull().defaultTo("default"))
    .execute();

  await db.schema
    .createTable("capture_submissions")
    // #region capture-submissions-columns
    // BrowserHive のタスク id が、結果の報告へ戻る join の鍵になる。
    .addColumn("task_id", "uuid", (col) => col.primaryKey())
    .addColumn("correlation_id", "text")
    .addColumn("org_id", "text", (col) => col.notNull())
    // それを求めた利用者。居た場合に限る。人ではなく組織に属する定期実行では NULL。
    .addColumn("submitted_by", "text")
    .addColumn("submitted_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    // #endregion capture-submissions-columns
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("capture_submissions").execute();
  await db.schema.alterTable("capture_targets").dropColumn("org_id").execute();
};
