/**
 * 024-add-script-params-and-crawl-values
 *
 * クロールごとにスクリプトへ渡す値。**変数**はクロールの頼みで渡し、記録に値が残る。**シークレット**は
 * スクリプトが宣言した名前を Windmill の secret 変数 (`f/waggle_secrets/<名前>`) に結び、台帳は値を持たない。
 *
 * ## `scripts.params` —— 宣言
 *
 * スクリプトが読む名前の宣言 (`[{ name, kind, required, summary }]`)。capture-scripts の catalog.json の
 * `params` を `import` が写す。`kind` は `variable` か `secret`。**既定値は持たない** —— 既定値はソースの中に
 * だけ在り、省かれた値をスクリプトは `undefined` と読む。宣言は版の一部 (`options`・`sites` と同じ) で、
 * 変えたら版を足す。
 *
 * ## `crawls.variables` —— 頼みで渡された値
 *
 * 名前 → 文字列。`POST /api/crawls` が宣言に照らして受け、行に固定する。段ごとに flow へ運ばれ、BrowserHive が
 * WACZ の `settings.variables` に値を書く。
 *
 * ## `crawls.secrets` —— 結んだ先
 *
 * 名前 → `{ path, editedAt, rotated }`。値は無い。在るのは Windmill の変数の path と、始めたときの `edited_at`
 * (Windmill が答える更新時刻)。段を送るたびに読み直し、変わっていれば `rotated` に気づいた段の深さと新しい時刻を
 * 書く —— クロールの途中で鍵が替わったことを、後から行で読めるように。値を解くのは flow の `crawl_host`
 * (capture-scheduler) で、台帳・webhook・WACZ・画面が持つのは名前と path だけ。
 *
 * ## 既定は空
 *
 * 3 列とも `DEFAULT` は**既に在る行**のためだけのもの。新しい行は API と `import` が必ず埋める。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("scripts")
    .addColumn("params", "jsonb", (col) =>
      col
        .notNull()
        .defaultTo(sql`'[]'::jsonb`)
        .check(sql`jsonb_typeof(params) = 'array'`),
    )
    .execute();

  await db.schema
    .alterTable("crawls")
    .addColumn("variables", "jsonb", (col) =>
      col
        .notNull()
        .defaultTo(sql`'{}'::jsonb`)
        .check(sql`jsonb_typeof(variables) = 'object'`),
    )
    .execute();

  await db.schema
    .alterTable("crawls")
    .addColumn("secrets", "jsonb", (col) =>
      col
        .notNull()
        .defaultTo(sql`'{}'::jsonb`)
        .check(sql`jsonb_typeof(secrets) = 'object'`),
    )
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").dropColumn("secrets").execute();
  await db.schema.alterTable("crawls").dropColumn("variables").execute();
  await db.schema.alterTable("scripts").dropColumn("params").execute();
};
