/**
 * 003-create-fga-outbox
 *
 * capture-ledger と OpenFGA がずれないようにするための、トランザクショナル outbox。
 *
 * `archives` に行を入れることと、対応する関係の tuple を書くことは別々のシステム:
 * tuple の書き込みは OpenFGA の HTTP API を通り、Postgres のトランザクションは
 * そこまで届かない。両方を直接やると片方だけ成功しうるし、その 2 つの失敗はどちらも
 * 悪い —— 誰も辿り着けないアーカイブか、指していたものより長生きする権限か。
 *
 * そこで tuple の書き込みを、アーカイブの行と同じトランザクションでここに記録する。
 * 両方入るか、どちらも入らないか。あとは worker がこのテーブルを at-least-once で
 * 掃き出す。tuple の重複した書き込みは OpenFGA 側で冪等なので、再送は安全。
 *
 * `payload` は tuple 1 つずつではなく OpenFGA への書き込みリクエスト 1 つ分そのまま
 * (`{ writes: [...] }`)。まとまって意味を持つ tuple の集合が、まとまって届くように。
 */
import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("fga_outbox")
    // #region fga-outbox-columns
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("payload", "jsonb", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    // 配送されるまで NULL。worker は行を消さない: 処理済みの行は tuple が書かれた
    // という証拠で、capture-ledger と OpenFGA を突き合わせるときに残っている価値がある。
    .addColumn("processed_at", "timestamptz")
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_error", "text")
    // #endregion fga-outbox-columns
    .execute();

  // worker が最もよく通る道は「未処理のうち最も古いもの」。partial index にすると
  // 配送済みの行が入らないので、index の大きさは履歴ではなく滞留の大きさに保たれる
  // —— `capture_targets_enabled_id_idx` と同じ理屈。
  await db.schema
    .createIndex("fga_outbox_pending_idx")
    .on("fga_outbox")
    .column("id")
    .where(sql<SqlBool>`processed_at IS NULL`)
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("fga_outbox").execute();
};
