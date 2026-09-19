/**
 * 015-harden-capture-targets
 *
 * `capture_targets` に手で INSERT する道の罠を、DB の側で塞ぐ。
 *
 * docs は「投入は呼び出し側の責務で、手動の INSERT でもよい」と案内してきた。ところが
 * 案内どおりに書くと、2 種類の行が黙って入った (2026-09-19 に開発の DB で確かめた):
 *
 *   - 組織を書かない INSERT は、列の既定値 `default` の行になる。案内どおりの名乗り
 *     (`acme`) の `fromTargets` からは見えない。エラーは出ない。
 *   - `example.org` (scheme 無し) も入る。クロールは種を `parseHttpUrl` で読み、読めない
 *     種が 1 本でもあれば 400 を返すので、その組織の `fromTargets` が全部止まる。
 *
 * ## ① `org_id` の既定値を外す
 *
 * NOT NULL はそのままなので、組織を書き忘れた INSERT は「誰のクロールからも見えない行」
 * ではなく、その場のエラーになる。`database.ts` の insert の型も必須にしてあり、
 * 書き忘れは typecheck でも止まる。
 *
 * ## ② http(s) でない URL を断る
 *
 * 粗い網。host が在るかどうかのような細かい検査は `parseHttpUrl` の仕事で、ここでは
 * scheme だけを見る。scheme の大文字は許す —— `parseHttpUrl` (WHATWG の URL) は読める。
 *
 * ## ③ ユニークを組織ごとにする
 *
 * `url_hash` だけのユニークでは、同じ URL を 2 つの組織がそれぞれ対象にできなかった。
 * `(org_id, url_hash)` に変える。1 つの組織の中では、これまでどおり 1 本だけ。
 *
 * ## down
 *
 * 逆順に戻す。**同じ URL が 2 つの組織に在ると、`url_hash` だけのユニークを作り直せずに
 * 落ちる** (Postgres が重複した値を名指しする)。片方を消してから戻すこと。
 * migration は 1 つのトランザクションで走るので、落ちても途中の状態は残らない。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`ALTER TABLE capture_targets ALTER COLUMN org_id DROP DEFAULT`.execute(db);

  await sql`ALTER TABLE capture_targets
    ADD CONSTRAINT capture_targets_url_http_check CHECK (url ~* '^https?://')`.execute(db);

  await db.schema.dropIndex("capture_targets_url_hash_key").execute();
  await db.schema
    .createIndex("capture_targets_org_url_hash_key")
    .on("capture_targets")
    .columns(["org_id", "url_hash"])
    .unique()
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex("capture_targets_org_url_hash_key").execute();
  await db.schema
    .createIndex("capture_targets_url_hash_key")
    .on("capture_targets")
    .column("url_hash")
    .unique()
    .execute();

  await sql`ALTER TABLE capture_targets DROP CONSTRAINT capture_targets_url_http_check`.execute(db);

  await sql`ALTER TABLE capture_targets ALTER COLUMN org_id SET DEFAULT 'default'`.execute(db);
};
