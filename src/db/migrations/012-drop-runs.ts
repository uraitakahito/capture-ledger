/**
 * 012-drop-runs
 *
 * `runs` を落とす。**畳んだので、この表が指すものはもう無い。**
 *
 * `runs` は「`capture_targets` の有効な行を全部投げる」1 回で、深さも範囲も
 * 持たなかった。それは `max_depth = 0` のクロールと同じものなので、`crawls` と
 * `crawl_pages` に寄せた (`011`)。投げるのも ledger のプロセスではなく Windmill の
 * flow になったので、`runs_single_active_idx` が守っていた前提 —— gRPC の channel が
 * プロセスに 1 つしかない —— そのものが消えている。
 *
 * ## 集計は移さない
 *
 * `submitted` / `accepted` / `rejected` は捨てる。`crawls` は
 * `pages_discovered` / `pages_captured` を持ち、内訳は `crawl_pages.state` を
 * 数えれば出る —— **ページごとに残るぶん、今より細かい**。2 つの数え方を並べると、
 * 食い違ったときにどちらが正しいのか言えなくなる。
 *
 * 過去の行は移行しない。`down` で表を作り直しても中身は戻らない。
 *
 * ## `006` と `010` は残す
 *
 * 既に走った migration の file を消すと (名前を変えて順をずらしても)、古い DB では kysely が
 * corrupted migrations で止まる。落とすのは新しい migration の仕事。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("runs").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  // 形だけ戻す。**中身は戻らない** —— up が落とした行はもう無い。
  await db.schema
    .createTable("runs")
    .addColumn("id", "uuid", (col) => col.primaryKey())
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("trigger", "text", (col) => col.notNull())
    .addColumn("started_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .addColumn("submitted", "integer")
    .addColumn("accepted", "integer")
    .addColumn("rejected", "integer")
    .addColumn("error", "text")
    .execute();

  // 名前を変えないこと。`isUniqueViolation` は制約名で見ている (`010` の注記)。
  await sql`
    CREATE UNIQUE INDEX runs_single_active_idx ON runs ((true)) WHERE state = 'running'
  `.execute(db);
  await db.schema.createIndex("runs_started_at_idx").on("runs").column("started_at").execute();
};
