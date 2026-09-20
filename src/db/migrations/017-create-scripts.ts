/**
 * 017-create-scripts
 *
 * ページの中で走らせる JavaScript の目録。
 *
 * ## なぜ台帳が持つのか
 *
 * BrowserHive v11.0.0 で、サーバは**走らせるものの顔ぶれを持たなくなった** ——
 * 組み込みの behavior も、サイト別の behavior も無い。送らなければページでは何も
 * 走らない (受け皿すら注入されない)。
 *
 * その結果、送り忘れは **静かな劣化** になる: 取り込みは成功し、archive も出るが、
 * スクロールも遅延読み込みも起きていない。既定を持てるのは「このクロールは何を
 * 走らせるか」を決める側だけなので、ここに置く。
 *
 * ## 版は上書きしない
 *
 * 主キーは `(id, version)`。同じ `id` の中身を書き換えるのではなく、版を足す。
 * 走った source そのものは archive にも残るが、**台帳の側からも「あのとき何を
 * 送ったか」を辿れる**ようにしておく。上書きできる形にすると、過去のクロールが
 * 何を走らせたのかを言えるものが、archive しか無くなる。
 *
 * ## `sha256` は DB が数える
 *
 * 生成列にした (`capture_targets.url_hash` と同じ手)。**書く側が数えた値を信じない**
 * —— BrowserHive は受け取った `source` と `sha256` を照合して、食い違えば
 * `INVALID_ARGUMENT` で拒む。ここに人の手が入る余地を残すと、拒まれた理由が
 * 「台帳の数え間違い」でありうることになり、あの照合が何も言わなくなる。
 *
 * ## `phase` は 2 つだけ
 *
 * BrowserHive の口が 2 つに分かれているため。`behavior` は読み込みの後・主フレーム・
 * 1 回で、受け皿を通して報告できる。`preload` は遷移の前・**iframe を含む全フレーム**・
 * 遷移のたびに走り、**報告する手段を持たない**。同じ一覧に混ぜると、どちらの約束で
 * 走るのかが行から読めなくなる。
 *
 * ## `enabled` が既定の顔ぶれを決める
 *
 * `scriptIds` を書かずに始めたクロールは、**有効な各 `id` の最新版**を走らせる。
 * 既定を「空」にしない理由は上のとおりで、既定を「全部」にするのは、目録に入れる
 * という行為そのものが「これを走らせたい」の表明だから。走らせたくないものは
 * `enabled = false` にして目録に残す (消すと版の履歴ごと消える)。
 */
import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // `digest()` は pgcrypto。`001` が有効にしているが、この migration 単体でも
  // 成り立つようにしておく (実行順に依存させない)。
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await db.schema
    .createTable("scripts")
    // #region scripts-columns
    // 報告と archive の `settings.behaviors` に出る名前。BrowserHive は中身を検査しない
    // ので、綴りを決めるのはこちら。前後の空白は許さない —— 目に見えない差で
    // 同じ名前の行が 2 つできる。
    .addColumn("id", "text", (col) => col.notNull().check(sql`id <> '' AND id = btrim(id)`))
    .addColumn("version", "integer", (col) => col.notNull().check(sql`version > 0`))
    .addColumn("phase", "text", (col) => col.notNull().check(sql`phase IN ('preload', 'behavior')`))
    // そのまま評価される JS。BrowserHive はテキストとして受け取る。
    .addColumn("source", "text", (col) => col.notNull().check(sql`source <> ''`))
    // GENERATED —— 書く側は触れない。BrowserHive の照合の相手がこれ。
    .addColumn("sha256", "text", (col) =>
      col.generatedAlwaysAs(sql`encode(digest(source, 'sha256'), 'hex')`).stored(),
    )
    // そのスクリプトに渡す値。BrowserHive では `options_json` として運ばれ、ページの
    // 中では `__bh.opts[<id>]` になる。**型では守れない** —— 中身が任意のコードである
    // 以上、その設定も任意だから。
    .addColumn("options", "jsonb", (col) =>
      col
        .notNull()
        .defaultTo(sql`'{}'::jsonb`)
        .check(sql`jsonb_typeof(options) = 'object'`),
    )
    .addColumn("enabled", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    // #endregion scripts-columns
    .addPrimaryKeyConstraint("scripts_pkey", ["id", "version"])
    .execute();

  // 既定の顔ぶれを引く道 (`WHERE enabled`、`id` ごとに最大の `version`) を覆う partial index。
  await db.schema
    .createIndex("scripts_enabled_id_version_idx")
    .on("scripts")
    .columns(["id", "version"])
    .where(sql<SqlBool>`enabled`)
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("scripts").execute();
  // pgcrypto はそのまま残す —— `001` と同じ理由で、他が依存している。
};
