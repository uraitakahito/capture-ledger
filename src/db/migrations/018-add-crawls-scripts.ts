/**
 * 018-add-crawls-scripts
 *
 * そのクロールが走らせるスクリプトを、**解決済みの形で**クロールの行に固定する。
 *
 * ## なぜ id の配列ではないのか
 *
 * `text[]` に id だけを持たせて、投げるたびに目録を引く形も採れる。採らなかったのは
 * 2 つの理由から。
 *
 * **① クロールの途中で目録が変わりうる。** クロールは段ごとに Windmill へ投げられ、
 * 長いものは何分も続く。id で引き直すと、途中で版が足された瞬間に、同じクロールの
 * 前半と後半で違うコードが走る。証拠として読むとき、それは最も避けたい形になる ——
 * 「このクロールは何を走らせたか」に 1 つの答えが無くなる。
 *
 * **② Postgres は配列の要素に外部キーを張れない。** 「目録に無い id は書けない」を
 * 制約で表せないので、どのみち解決はアプリ側の仕事になる。それなら解決した結果を
 * 書き残すほうが、後から読む側にも親切になる。
 *
 * 中身は `[{ id, version, phase, source, sha256, options }]` で、**並びが実行順**。
 * `sha256` は目録の生成列をそのまま写したもので、BrowserHive がこれと `source` を
 * 照合する。
 *
 * ## 既定は空ではない
 *
 * 既定を空にすると、何も指定しないクロールはページの中で何も走らせない ——
 * スクロールも遅延読み込みも起きないまま、成功した archive が出る。既定は
 * 「目録の有効な各 id の最新版」で、解決は `POST /api/crawls` が行う (`017` を見ること)。
 *
 * この列の `DEFAULT '[]'` は、**既に在る行**のためだけのもの。新しい行は API が
 * 必ず埋める。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .addColumn("scripts", "jsonb", (col) =>
      col
        .notNull()
        .defaultTo(sql`'[]'::jsonb`)
        .check(sql`jsonb_typeof(scripts) = 'array'`),
    )
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").dropColumn("scripts").execute();
};
