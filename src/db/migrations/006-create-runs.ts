/**
 * 006-create-runs
 *
 * 取り込みの実行 1 回ぶんの記録。**状態の問い合わせと、多重起動の防止を兼ねる。**
 *
 * ## なぜ状態をテーブルに持つのか
 *
 * 取り込みは長い。`collectResults` は 1 件ずつ順に `waitForCapture` するので、1 件あたり
 * queue 待ちに最大 10 分、server 側の予算が 391 秒、それに猶予 30 秒が乗る。件数ぶん逐次なので、
 * HTTP のリクエストの中で待ち切ることはできない。だから API は 202 を返して走らせ、
 * 呼んだ側（スケジューラ）はこの行を見に来る。
 *
 * ## なぜ「走行中は 1 行だけ」を DB に強制させるのか
 *
 * gRPC の channel が **プロセスに 1 つしかない**(当時の src/rpc/client.ts)。`configureClient` は
 * 既存の channel を閉じてから張り直し、`runClient` は終わりに必ず `closeClient()` を呼ぶ。
 * つまり 1 つのプロセスで 2 本の実行を並べると、**後から始めた方が先の channel を畳み、
 * 先に終わった方が後の channel を畳む**。これは「同時に動くと遅い」ではなく壊れる話なので、
 * 単一実行は機能ではなく前提。
 *
 * その前提をアプリのフラグや mutex で守ると、プロセスが 2 つに増えた日に黙って破れる。
 * ここでは **部分 unique index** に守らせる —— `status = 'running'` の行を高々 1 つに縛るので、
 * 競合した 2 つ目の insert は DB が弾く。呼ぶ側はその違反を 409 に翻訳するだけでよい。
 *
 * ## 走ったまま死んだら
 *
 * プロセスが落ちると `running` の行が残り、次の実行が始められなくなる。自動では復旧しない
 * —— 生きている実行と死んだ実行を、行だけを見て区別する術が無いため。読み手が
 * `started_at` を見て古すぎる行に気づけるようにしてあり、片付けは運用の判断に残す。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable("runs")
    // #region runs-columns
    .addColumn("id", "uuid", (col) => col.primaryKey())
    // `running` / `succeeded` / `failed`。CHECK は置かない —— 値を増やすときに
    // migration が要るのは、この段階では窮屈すぎる。
    .addColumn("status", "text", (col) => col.notNull())
    // 何が起こしたか。API 経由か、CLI か。capture-ledger の `submitted_by` は実行の身元であって
    // 起動した者ではないので、それはここで別に覚える。
    .addColumn("trigger", "text", (col) => col.notNull())
    .addColumn("started_at", "timestamptz", (col) => col.notNull().defaultTo(sql`now()`))
    // 走行中は NULL。これが入っている＝終わっている。
    .addColumn("finished_at", "timestamptz")
    // 投げた件数と、その内訳。`submitAll` の結果から入る。走行中は NULL。
    .addColumn("submitted", "integer")
    .addColumn("accepted", "integer")
    .addColumn("rejected", "integer")
    // 失敗したときの要約。読み手が原因に辿り着くためのもので、完全な記録は log にある。
    .addColumn("error", "text")
    // #endregion runs-columns
    .execute();

  // **走行中は高々 1 行。** 上の docstring のとおり、これは性能の話ではなく
  // gRPC channel が 1 つしかないことへの構造的な担保。`(true)` で表を 1 グループに畳み、
  // 述語で走行中の行だけに効かせる。
  await sql`
    CREATE UNIQUE INDEX runs_single_active_idx ON runs ((true)) WHERE status = 'running'
  `.execute(db);

  // 一覧と「最後の実行はいつか」を引くため。
  await db.schema.createIndex("runs_started_at_idx").on("runs").column("started_at").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable("runs").execute();
};
