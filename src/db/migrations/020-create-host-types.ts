/**
 * 020-create-host-types
 *
 * 受け皿 `__bh` の型（capture-scripts の types/host.d.ts）の写し。目録の source を読む人が、
 * `globalThis.__bh` が何かを同じ所で読めるようにする。走る JS の型を決めるのは ts-compile-service の
 * pin で、ここは**読む人に見せる写し**。
 *
 * ## 版は足す（`017` と同じ）
 *
 * `scripts import` が目録と同じ置き場所から読み、中身が変わったときだけ版を足す。見せるのは
 * いちばん新しい版。上書きしないのは、いつどの型を見せていたかを後から言えるようにするため。
 *
 * ## `sha256` は DB が数える（`017` と同じ）
 *
 * 生成列にする。読む人が手元の写しと突き合わせる値なので、書く側が数えた値を信じない。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // `digest()` は pgcrypto。`017` と同じく、この migration 単体でも成り立つようにしておく。
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  await db.schema
    .createTable("host_types")
    .addColumn("version", "integer", (col) => col.notNull().check(sql`version > 0`))
    .addColumn("source", "text", (col) => col.notNull().check(sql`source <> ''`))
    // GENERATED —— 書く側は触れない。
    .addColumn("sha256", "text", (col) =>
      col.generatedAlwaysAs(sql`encode(digest(source, 'sha256'), 'hex')`).stored(),
    )
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("host_types_pkey", ["version"])
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("host_types").execute();
  // pgcrypto はそのまま残す —— `017` と同じ理由で、他が依存している。
};
