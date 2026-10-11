/**
 * 011-crawls-multi-seed
 *
 * `crawls.seed` (単数) を `crawls.seeds` (配列) にする。
 *
 * ## なぜ要るのか
 *
 * `runs` を畳むため。`runs` は「`capture_targets` の有効な行を全部投げる」1 回で、
 * 深さも範囲も持たない —— これは **`max_depth = 0` のクロール**と同じもので、
 * 唯一違うのが「起点が 1 つではない」ことだけだった。
 *
 * 深さ 0 の意味論は既に正しく動いている (`budget.ts` が `nextDepth 1 > maxDepth 0`
 * で 0 件を返し、`succeeded` で締まる)。詰まっていたのは起点の単数性のほうなので、
 * そこだけを外す。
 *
 * ## 範囲の意味は変わらない
 *
 * `scope.ts` の設計判断は「リンク元ではなく**起点**と同じかで見る。
 * そうすれば範囲はクロールを頼んだ時点で決まり、後から動かない」。
 * 起点が複数になると「どれか 1 つの起点の範囲に入れば入る」になり、
 * **範囲は起点の数だけ広がる**が、依頼時に決まって後から動かないという性質は保たれる。
 * 端のページが新しい中心になることは無い。
 *
 * ## `CHECK` を置く理由
 *
 * 起点の URL が 0 本のクロールは、始まりを持たないので進みようがない。`NOT NULL` だけだと
 * `'{}'` が通り、**投げた側から見ると受理されたのに何も起きない**クロールになる。
 * 空を作れないようにしておけば、その状態を後から疑わなくて済む。
 *
 * 上限は置かない。`max_pages` が件数を抑えるので、起点の URL の本数を別に縛る理由が無い。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .addColumn("seeds", sql`text[]`)
    .execute();

  // 既にある行を移す。**この時点では `seeds` が NULL の行が在りうる**ので、
  // 制約を付けるのは埋めた後。
  await sql`UPDATE crawls SET seeds = ARRAY[seed] WHERE seeds IS NULL`.execute(db);

  await sql`ALTER TABLE crawls ALTER COLUMN seeds SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE crawls ADD CONSTRAINT crawls_seeds_not_empty
      CHECK (array_length(seeds, 1) >= 1)
  `.execute(db);

  await db.schema.alterTable("crawls").dropColumn("seed").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").addColumn("seed", "text").execute();
  // 戻すときは 1 本目だけを残す。複数の起点を持つクロールは単数の列では表せないので、
  // **落ちるものが在る**。down は開発中に前後するためのもので、記録の保全ではない。
  await sql`UPDATE crawls SET seed = seeds[1] WHERE seed IS NULL`.execute(db);
  await sql`ALTER TABLE crawls ALTER COLUMN seed SET NOT NULL`.execute(db);

  await sql`ALTER TABLE crawls DROP CONSTRAINT crawls_seeds_not_empty`.execute(db);
  await db.schema.alterTable("crawls").dropColumn("seeds").execute();
};
