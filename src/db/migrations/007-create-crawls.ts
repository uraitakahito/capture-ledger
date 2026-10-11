/**
 * 007-create-crawls
 *
 * リンクを辿る取り込み 1 本ぶんの記録。**方針の置き場と、多重起動の防止を兼ねる。**
 *
 * ## なぜ `runs` と別の表なのか
 *
 * `runs` は「`capture_targets` の有効な行を全部投げる」1 回で、深さも範囲も持たない。
 * クロールは起点が 1 つで、そこから広がる。集計の意味も違う —— `runs` の `submitted` は
 * 投げた件数だが、クロールでは「見つけた件数」と「取った件数」が別々に要る。
 *
 * ## なぜ「走行中は 1 本だけ」なのか
 *
 * `runs` と同じ形の部分 unique index を張るが、**理由は違う**。あちらは gRPC の channel が
 * プロセスに 1 つしかないから。こちらは **礼儀が 1 つの flow run の中でしか効かないから**。
 *
 * ホストあたりの間隔は Windmill の flow がループの形で守っている (ホストごとに逐次、
 * 完了と次の投入の間に `per_host_delay_ms` を置く)。2 本のクロールが同時に走ると、
 * 互いの間隔は見えないので、同じホストへの頻度が黙って倍になる。**その担保が無い以上、
 * 同時には走らせない。**
 *
 * アプリ側のフラグで守らないのは `runs` と同じ理由 —— プロセスが増えた日に黙って破れる。
 *
 * ## 打ち切りを記録する
 *
 * `stop_reason` は `completed` / `max_depth` / `max_pages` / `failed`。これが無いと、
 * 終わったクロールを見ても「全部辿った」のか「上限で切った」のかが言えない。
 * 既定の上限は小さい (30) ので、**普通に使うと `max_pages` で止まる**。区別が付くことに
 * 意味がある。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("crawls")
    // #region crawls-columns
    .addColumn("id", "uuid", (col) => col.primaryKey())
    // 出発点。ここから辿る。
    .addColumn("seed", "text", (col) => col.notNull())
    // どこまでを同じ範囲と見なすか。`same-origin` / `same-host`。
    .addColumn("scope", "text", (col) => col.notNull())
    .addColumn("max_depth", "integer", (col) => col.notNull())
    .addColumn("max_pages", "integer", (col) => col.notNull())
    // 同じホストへ、完了から次の投入まで空ける時間。**投入間隔ではない** ——
    // browserhive のキューに上限が無いので、投入を間引いても意味がない
    // (`008` と capture-scheduler の crawl_host.ts に詳しい)。
    .addColumn("per_host_delay_ms", "integer", (col) => col.notNull())
    // 同時に触ってよいホストの数。flow の for-loop の parallelism になる。
    .addColumn("host_parallelism", "integer", (col) => col.notNull())
    // 誰のために走ったか、誰が頼んだか。`runs` と違い、クロールは起点を渡した者に紐づく。
    .addColumn("org_id", "text", (col) => col.notNull())
    .addColumn("requested_by", "text", (col) => col.notNull())
    // `running` / `succeeded` / `failed`。CHECK は置かない —— `006` と同じ判断。
    .addColumn("state", "text", (col) => col.notNull())
    // なぜ終わったか。走行中は NULL。
    .addColumn("stop_reason", "text")
    .addColumn("started_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    // 見つけた件数と、実際に取った件数。**別々に持つ** —— 範囲や上限で落としたぶんが
    // 差として見えないと、打ち切りの影響が読めない。
    .addColumn("pages_discovered", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("pages_captured", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error", "text")
    // #endregion crawls-columns
    .execute();

  // **走行中は高々 1 本。** 上の docstring のとおり、礼儀を守れる範囲が 1 つの flow run
  // までなので、2 本目を DB が弾く。`(true)` で表を 1 グループに畳み、述語で絞る。
  await sql`
    CREATE UNIQUE INDEX crawls_single_active_idx ON crawls ((true)) WHERE state = 'running'
  `.execute(db);

  await db.schema.createIndex("crawls_started_at_idx").on("crawls").column("started_at").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("crawls").execute();
};
