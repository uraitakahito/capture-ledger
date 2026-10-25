/**
 * 021-add-scripts-sites
 *
 * 札（どのサイト用か）。空ならどこでも走るスクリプト。札のあるスクリプトは、クロールの起点のどれかが
 * そのサイトにあるときだけ走る —— `scripts` を省いた頼みでは起点に合う物を台帳が選び、合わない物を
 * 名指せば断る（`resolveScripts`・`offsiteScripts`）。
 *
 * ## 版の一部（options と同じ）
 *
 * 札を変えたら版を足す。走らせた物の記録（`crawls.scripts` の写し）と札が食い違わないように。
 *
 * ## 形は小文字のホスト名
 *
 * IDN は punycode で書く。ポート・scheme・`*` は書けない —— 起点の `new URL(…).hostname` と
 * そのまま比べるため。式は capture-scripts の tools/check.mjs と同じ（取り込みと CLI も同じ式で
 * 先に断り、ここは最後の守り）。配列には正規表現を掛けられないので、空白でつないだ文字列に掛ける
 * （ホスト名は空白を含まない）。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

const SITES = String.raw`^([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*( |$))*$`;

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("scripts")
    .addColumn("sites", sql`text[]`, (col) =>
      col
        .notNull()
        .defaultTo(sql`'{}'`)
        .check(sql`array_to_string(sites, ' ') ~ ${sql.lit(SITES)}`),
    )
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("scripts").dropColumn("sites").execute();
};
