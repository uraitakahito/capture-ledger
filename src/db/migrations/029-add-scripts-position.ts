/**
 * 029-add-scripts-position
 *
 * 既定の実行順。capture-scripts の catalog.json の並びを写す。`scripts` を省いたクロールと
 * `GET /api/scripts` がこの順で並ぶ（`inRunOrder`）。id の順だと autofetch が autoscroll より先に走り、
 * 遅延読み込みで現れる候補を取り逃がす（CAPTURE-52）。
 *
 * ## 版ではなく id の性質（`enabled` と同じ）
 *
 * 行は版ごとだが、順は id に 1 つ。`scripts import` が各 id の全部の版に同じ値を書き
 * （`setScriptPositions`）、手で足した新しい版は最新版の値を受け継ぐ（`addScript`）。
 *
 * ## 既定の 1000
 *
 * カタログに無い物（`scripts add` で足した物）はカタログの後ろへ。同じ値の中は id の順。
 * この migration の直後は全部 1000 なので、次の import までは今までどおり id の順で走る。
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("scripts")
    .addColumn("position", "integer", (col) => col.notNull().defaultTo(1000))
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("scripts").dropColumn("position").execute();
};
