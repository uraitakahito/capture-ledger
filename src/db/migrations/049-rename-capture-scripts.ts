/**
 * 049-rename-capture-scripts
 *
 * 取り込みを頼む側が付けて BrowserHive が頁の中で走らせる物の名を、capture scripts に揃える (CAPTURE-506)。
 * 「scripts」だけでは、頁自身の JavaScript と紛れる。
 *
 * ## 表と列の名
 *
 * 表 `scripts` を `capture_scripts` に、列 `crawls.scripts` を `crawls.capture_scripts` に。制約と索引の名の頭
 * `scripts_` も `capture_scripts_` に揃える。名は 048 まで流した Postgres の `pg_constraint`・`pg_indexes` で
 * 引いて、ここに字で書いた (走る時に引いて組み立てない —— 名が思った物と違えば、落ちる方がよい)。行は動かない。
 * view・trigger・外部キーで `scripts` を指す物は無い (同じ時に引いた)。生成列 `sha256` は名を持たない。
 *
 * ## 時点の値
 *
 * capture scripts の後の時点の名を `after-behaviors` から `after-capture-scripts` に替えた (BrowserHive WARC Profile
 * 1.8.0・BrowserHive WACZ Profile 1.30.0)。capture-ledger の中は新しい名だけを扱う (`archive/stage-name.ts`) ので、
 * 3 表の `stage` の古い値を書き換える。`archive_pages.url` (写しの urn。撮った字) は書き換えない。
 * `archive_screenshots` の主キーは `(archive_id, stage)` だが、049 の前に同じ archive に 2 つの名が並ぶことは無い
 * (BrowserHive は 1 つの取り込みに 1 つの名しか書かない)。
 *
 * ## down を使えるのは、新しい BrowserHive が撮る前だけ
 *
 * 撮った後は、WACZ と `.result.json` の中に新しい名が在り、戻した capture-ledger はそれを読めない。前に進めて直す。
 */
import { sql, type Kysely } from "kysely";

/** 名を替える制約。表ごとに、今の名 → 後の名。 */
const CONSTRAINTS: readonly (readonly [table: string, from: string, to: string])[] = [
  ["capture_scripts", "scripts_pkey", "capture_scripts_pkey"],
  ["capture_scripts", "scripts_id_check", "capture_scripts_id_check"],
  ["capture_scripts", "scripts_version_check", "capture_scripts_version_check"],
  ["capture_scripts", "scripts_phase_check", "capture_scripts_phase_check"],
  ["capture_scripts", "scripts_source_check", "capture_scripts_source_check"],
  ["capture_scripts", "scripts_options_check", "capture_scripts_options_check"],
  ["capture_scripts", "scripts_id_not_inline", "capture_scripts_id_not_inline"],
  ["capture_scripts", "scripts_sites_check", "capture_scripts_sites_check"],
  ["capture_scripts", "scripts_params_check", "capture_scripts_params_check"],
  ["crawls", "crawls_scripts_check", "crawls_capture_scripts_check"],
];

/** 名を替える索引 (制約の持つ索引 `scripts_pkey` は、制約の名と一緒に替わる)。 */
const INDEXES: readonly (readonly [from: string, to: string])[] = [
  ["scripts_enabled_id_version_idx", "capture_scripts_enabled_id_version_idx"],
];

/** 時点の値を持つ表。 */
const STAGE_TABLES = ["archive_pages", "archive_screenshots", "page_changes"] as const;

const OLD_STAGE = "after-behaviors";
const NEW_STAGE = "after-capture-scripts";

const renameStages = async (db: Kysely<unknown>, from: string, to: string): Promise<void> => {
  for (const table of STAGE_TABLES) {
    await sql`update ${sql.table(table)} set stage = ${to} where stage = ${from}`.execute(db);
  }
};

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`alter table scripts rename to capture_scripts`.execute(db);
  await sql`alter table crawls rename column scripts to capture_scripts`.execute(db);
  for (const [table, from, to] of CONSTRAINTS) {
    await sql`alter table ${sql.table(table)} rename constraint ${sql.ref(from)} to ${sql.ref(to)}`.execute(
      db,
    );
  }
  for (const [from, to] of INDEXES) {
    await sql`alter index ${sql.ref(from)} rename to ${sql.ref(to)}`.execute(db);
  }
  await renameStages(db, OLD_STAGE, NEW_STAGE);
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await renameStages(db, NEW_STAGE, OLD_STAGE);
  for (const [from, to] of INDEXES) {
    await sql`alter index ${sql.ref(to)} rename to ${sql.ref(from)}`.execute(db);
  }
  for (const [table, from, to] of CONSTRAINTS) {
    // 表の名は、戻す前の名 (表は最後に戻す)
    await sql`alter table ${sql.table(table)} rename constraint ${sql.ref(to)} to ${sql.ref(from)}`.execute(
      db,
    );
  }
  await sql`alter table crawls rename column capture_scripts to scripts`.execute(db);
  await sql`alter table capture_scripts rename to scripts`.execute(db);
};
