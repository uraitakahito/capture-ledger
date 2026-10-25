/**
 * 022-crawls-rules
 *
 * クロールの範囲を、規則の並びにする。`scope` (same-origin か same-host の 1 つ) を消し、`rules`
 * (鍵が 1 つの object の並び。`{ "skip": "ads.example.com" }`) を足す。当て方は `crawl/rules.ts`。
 *
 * ## 今の行は規則 1 本に写す
 *
 * `scope = 'same-host'` の行は `[{"follow": "same-host"}]` になる。規則の当て方では、これが
 * 今までの範囲と同じ動き —— 範囲の中は撮って辿り、どれにも当たらない外は落とす。
 *
 * ## 形は API が見る
 *
 * 1〜32 本・鍵が 1 つ・当てる物が読めるか・前の規則に覆われていないか・起点が辿られるか、は
 * `POST /api/crawls` が見て 400 で名指す。ここは配列であることだけを CHECK で守る (`018` の
 * `scripts` と同じ)。
 *
 * ## 戻すとき
 *
 * `scope` に戻せるのは、範囲を辿る規則 1 本だけの行 (same-origin か same-host)。それ以外は
 * `same-origin` に倒す —— 戻した先の台帳には、規則を表す手が無い。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .addColumn("rules", "jsonb", (col) => col.check(sql`jsonb_typeof(rules) = 'array'`))
    .execute();
  await sql`UPDATE crawls SET rules = jsonb_build_array(jsonb_build_object('follow', scope))`.execute(
    db,
  );
  await db.schema
    .alterTable("crawls")
    .alterColumn("rules", (col) => col.setNotNull())
    .execute();
  await db.schema.alterTable("crawls").dropColumn("scope").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").addColumn("scope", "text").execute();
  await sql`UPDATE crawls SET scope = CASE
    WHEN rules IN ('[{"follow": "same-origin"}]'::jsonb, '[{"follow": "same-host"}]'::jsonb)
      THEN rules->0->>'follow'
    ELSE 'same-origin'
  END`.execute(db);
  await db.schema
    .alterTable("crawls")
    .alterColumn("scope", (col) => col.setNotNull())
    .execute();
  await db.schema.alterTable("crawls").dropColumn("rules").execute();
};
