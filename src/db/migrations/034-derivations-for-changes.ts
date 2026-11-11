/**
 * 034-derivations-for-changes
 *
 * 派生の層 (`026`) に、前回からの変化の要約 (CAPTURE-167) を残せるようにする。表は作り直さず、列と制約を足す
 * (いまの `fix` の行はそのまま読める)。
 *
 * - `archive_id`: 何のアーカイブについての物か。変化の要約はクロールの回ごとだが、ページの組を残すときにも
 *   使えるように置く。アーカイブの行は消さないが、消えても費用の記録として読めるように `set null`
 * - `kind` の CHECK: `fix` と `change` だけ。`026` は「値はコードが決める」で CHECK を置かなかったが、種類が 2 つに
 *   なり、月の上限を種類をまたいで数えるので、知らない種類の行が黙って足されないようにする
 * - `change` の一意: 同じ差分 (`input_sha256`) を同じ決まりの文の版 (`prompt_version`) で 2 度払わない。
 *   **`fix` には掛けない** —— 直す係は同じ頼みでも 1 回ずつ Claude を呼んで記録する (いまの動きを変えない)
 *
 * ## down
 *
 * 足した物を外すだけ。`change` の行が在れば、CHECK を外しても行は残る (`026` の形は種類を縛らない)。
 */
import { sql, type Kysely, type SqlBool } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("derivations")
    .addColumn("archive_id", "uuid", (col) => col.references("archives.id").onDelete("set null"))
    .execute();
  await db.schema
    .alterTable("derivations")
    .addCheckConstraint("derivations_kind_check", sql`kind in ('fix', 'change')`)
    .execute();
  await db.schema
    .createIndex("derivations_change_input_idx")
    .on("derivations")
    .columns(["input_sha256", "prompt_version"])
    .unique()
    .where(sql<SqlBool>`kind = 'change'`)
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex("derivations_change_input_idx").execute();
  await db.schema.alterTable("derivations").dropConstraint("derivations_kind_check").execute();
  await db.schema.alterTable("derivations").dropColumn("archive_id").execute();
};
