/**
 * 033-drop-capture-targets
 *
 * `capture_targets` と、seed の記録の表 (`kysely_seed`・`kysely_seed_lock`) を落とす。
 *
 * 何を撮るかは、予定 (`crawl_schedules`・`032`) か、画面から始めるクロールが持つようになった。この表を
 * 読んでいたのは Windmill の `trigger_crawl` (`fromTargets`) だけで、時計が台帳へ移ったので
 * 読む者が居なくなる。
 *
 * seed も一緒に畳んだ。入れていたのはこの表のサンプルの行だけだった。
 *
 * ## `IF EXISTS`
 *
 * seed の表は `pnpm run db:seed` を流した DB にしか無い (migration が作った物ではない)。
 * 落とす側がどちらの DB でも通るように、3 つとも `IF EXISTS` にしてある。
 *
 * ## `001`・`004`・`015` は残す
 *
 * 既に走った migration のファイルを消すと、古い DB では kysely が corrupted migrations で
 * 止まる。落とすのは新しい migration の仕事 (`012` と同じ)。
 *
 * ## down
 *
 * `capture_targets` の形だけを戻す (`001`・`004`・`015` を通した後の形)。**行は戻らない** ——
 * up が落とした行はもう無い。seed の表は戻さない: 流す道具がもう無く、次の up がまた落とすだけ。
 * pgcrypto はどちらの向きでも触らない。`crawl_pages.url_hash` (`008`) がまだ使っている。
 */
import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("capture_targets").ifExists().execute();
  await db.schema.dropTable("kysely_seed").ifExists().execute();
  await db.schema.dropTable("kysely_seed_lock").ifExists().execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("capture_targets")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("url", "text", (col) => col.notNull().check(sql`url <> '' AND url = btrim(url)`))
    .addColumn("url_hash", sql`bytea`, (col) =>
      col.generatedAlwaysAs(sql`digest(url, 'sha256')`).stored(),
    )
    .addColumn("labels", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn("enabled", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("org_id", "text", (col) => col.notNull())
    .addCheckConstraint("capture_targets_url_http_check", sql`url ~* '^https?://'`)
    .execute();

  await db.schema
    .createIndex("capture_targets_org_url_hash_key")
    .on("capture_targets")
    .columns(["org_id", "url_hash"])
    .unique()
    .execute();

  await db.schema
    .createIndex("capture_targets_enabled_id_idx")
    .on("capture_targets")
    .column("id")
    .where(sql<SqlBool>`enabled`)
    .execute();
};
