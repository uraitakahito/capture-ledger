/**
 * 032-create-crawl-schedules
 *
 * 定期実行の予定。時計を Windmill の schedule から台帳へ移す (CAPTURE-170)。
 *
 * ## 回の表は作らない
 *
 * 回は `crawls` の行そのもの。予定の id・本来の時刻・1 回にまとめた欠けの数を足すだけで、「いつ撮れて、
 * いつ撮れなかったか」は既に在る行が語る。回だけの表を作ると、同じことを 2 か所に書く。
 *
 * ## 行は消さない
 *
 * 予定を消しても `deleted_at` を立てるだけにする。クロールの行が予定の名前を出すので、消すと参照先が無くなる。
 * 名前の一意は消していない行の間だけ (消した名前は使い直せる)。
 *
 * ## request と recipe の 2 つを持つ
 *
 * `request` は form の中身で、「固定し直す」が読み直す。`recipe` は解決して固定した撮り方で、周回が配る。
 * スクリプトの本文の写しまで入るので、新しい版が出ても回の中身は変わらない。
 *
 * ## down
 *
 * 表と列を落とす。予定は戻らない。回の行は手で始めたクロールと同じ形になる。
 */
import { sql, type Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // #region crawl-schedules-columns
  await sql`
    CREATE TABLE crawl_schedules (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      name text NOT NULL CHECK (name <> '' AND name = btrim(name)),
      cron text NOT NULL,
      timezone text NOT NULL DEFAULT 'Asia/Tokyo',
      enabled boolean NOT NULL DEFAULT true,
      next_run_at timestamptz NOT NULL,
      run_requested_at timestamptz,
      request jsonb NOT NULL,
      recipe jsonb NOT NULL,
      pinned_at timestamptz NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )
  `.execute(db);
  // #endregion crawl-schedules-columns
  await sql`
    CREATE UNIQUE INDEX crawl_schedules_org_name_key
      ON crawl_schedules (org_id, name)
      WHERE deleted_at IS NULL
  `.execute(db);
  // 周回が 30 秒ごとに引く 2 つの形 (期限の来た予定と、いま撮るの頼み)
  await sql`
    CREATE INDEX crawl_schedules_due_idx
      ON crawl_schedules (next_run_at)
      WHERE enabled AND deleted_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX crawl_schedules_requested_idx
      ON crawl_schedules (run_requested_at)
      WHERE run_requested_at IS NOT NULL AND deleted_at IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE crawls
      ADD COLUMN schedule_id uuid REFERENCES crawl_schedules (id),
      ADD COLUMN scheduled_for timestamptz,
      ADD COLUMN schedule_missed integer NOT NULL DEFAULT 0 CHECK (schedule_missed >= 0)
  `.execute(db);
  // 予定ごとの直近の回を引く
  await sql`
    CREATE INDEX crawls_schedule_started_idx
      ON crawls (schedule_id, started_at DESC)
      WHERE schedule_id IS NOT NULL
  `.execute(db);
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`
    ALTER TABLE crawls
      DROP COLUMN schedule_id,
      DROP COLUMN scheduled_for,
      DROP COLUMN schedule_missed
  `.execute(db);
  await sql`DROP TABLE crawl_schedules`.execute(db);
};
