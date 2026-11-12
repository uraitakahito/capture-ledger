/**
 * 予定の表を読み書きする store。エンドポイントと周回は直に SQL を書かず、これを deps で受ける —— route の試験の偽の DB は
 * 行のロックも一意の索引も真似できないので、SQL はここに閉じ込める。形は `test/schedules-store.test.ts` が
 * recording の DB で照らし、Postgres で本当に通るかは `src/tools/schedules-smoke.ts` が CI で見る。
 */
import { randomUUID } from "node:crypto";

import { sql, type Kysely, type Selectable } from "kysely";

import { isUniqueViolation } from "../api/authorization.js";
import type { SinkConfig } from "../api/sink.js";
import type { CaptureSettings } from "../config/capture-formats.js";
import { crawlValues, insertCrawl, type DispatchedCrawl } from "../crawl/launch.js";
import { pagesFailed } from "../crawl/page-counts.js";
import type { CrawlBody, CrawlRequester, PreparedCrawl } from "../crawl/prepare.js";
import type {
  ChangeSignificance,
  CrawlChangeState,
  CrawlSchedulesTable,
  CrawlState,
  Database,
  ScheduleRecipe,
} from "../db/database.js";

export type ScheduleRow = Selectable<CrawlSchedulesTable>;

/** 答えに出す回の数。 */
export const RECENT_RUNS = 14;

/** 予定の回 1 本。 */
export interface ScheduleRun {
  crawlId: string;
  state: CrawlState;
  scheduledFor: Date | null;
  startedAt: Date;
  finishedAt: Date | null;
  scheduleMissed: number;
  pagesCaptured: number;
  pagesFailed: number;
  error: string | null;
  /** 前回からの変化 (`036`・CAPTURE-167)。まだ比べていなければ null。 */
  change: RunChange | null;
}

/** 回の変化の写し。中身は `GET /api/crawls/:id/changes`。 */
export interface RunChange {
  state: CrawlChangeState;
  pagesCompared: number;
  pagesChanged: number;
  significance: ChangeSignificance | null;
  headline: string | null;
}

export interface NewSchedule {
  orgId: string;
  name: string;
  cron: string;
  nextRunAt: Date;
  request: CrawlBody;
  recipe: ScheduleRecipe;
  createdBy: string;
  now: Date;
}

/** 周回が 1 回を始めるときに渡す物。計算は周回がして、ここは 1 つのトランザクションで書くだけ。 */
export interface FirePlan {
  scheduleId: string;
  crawlId: string;
  prepared: PreparedCrawl;
  who: CrawlRequester;
  /** 最初の段に載せる形式と署名 (段の行は送る段そのものを持つ) */
  capture: CaptureSettings;
  sink: SinkConfig | undefined;
  /** 本来の時刻。「いま撮る」は null。 */
  scheduledFor: Date | null;
  missed: number;
  /** 次の期限。期限の回だけが持つ。「いま撮る」は書かない。 */
  nextRunAt?: Date;
  /** 在れば、始めずに failed の行を足す (シークレットが足りないなど)。期限は進める。 */
  failure?: string;
  now: Date;
}

export type FireResult =
  /** 始めた。`level` は最初の段 (段の行は同じトランザクションで足した)。投げるのは呼ぶ側 */
  | { kind: "started"; level: DispatchedCrawl }
  | { kind: "failed" }
  /** 走行中の行とぶつかった。rollback したので、期限も頼みも動いていない。 */
  | { kind: "busy" }
  /** 周回の間に、消された・止められた・別の者が取った。 */
  | { kind: "gone" };

export type CreateResult = { kind: "created"; row: ScheduleRow } | { kind: "duplicate-name" };

/**
 * 「固定し直す」で上がる先の版。**頼みの形で違う** (`resolveScripts`): 名指しは有効かを見ずに最新を選び、省いた頼みは
 * 有効な版の最新を選ぶ。片方だけで比べると、版を無効にしたときに「新しい版があります」が消えなくなる。
 */
export interface LatestVersions {
  named: ReadonlyMap<string, number>;
  byDefault: ReadonlyMap<string, number>;
}

export interface ScheduleStore {
  create(schedule: NewSchedule): Promise<CreateResult>;
  /** 消していない予定を、作った順に。 */
  list(): Promise<ScheduleRow[]>;
  /** 消していない予定を 1 つ。 */
  get(id: string): Promise<ScheduleRow | undefined>;
  /** 新しい順に `RECENT_RUNS` 本。 */
  recentRuns(scheduleId: string): Promise<ScheduleRun[]>;
  /** 走行中の 1 本 (全体で 1 本。`007` の部分 unique index)。 */
  runningCrawl(): Promise<{ crawlId: string; startedAt: Date } | undefined>;
  /** 直近に始まったクロールの時刻。手で始めた物も数える。 */
  lastCrawlStartedAt(): Promise<Date | undefined>;
  /** スクリプトの id ごとの最新の版。 */
  latestVersions(): Promise<LatestVersions>;
  /** 次に始める候補を 1 つ。「いま撮る」の頼みが先で、次に期限の古い順。 */
  candidate(now: Date): Promise<ScheduleRow | undefined>;
  fire(plan: FirePlan): Promise<FireResult>;
  pause(id: string): Promise<ScheduleRow | undefined>;
  /** 再開。次の期限は呼ぶ側が今から計算し直す (止めていた間は欠けに数えない)。止めていない予定には何もしない。 */
  resume(id: string, nextRunAt: Date): Promise<ScheduleRow | undefined>;
  requestRun(id: string, now: Date): Promise<ScheduleRow | undefined>;
  repin(id: string, recipe: ScheduleRecipe, now: Date): Promise<ScheduleRow | undefined>;
  softDelete(id: string, now: Date): Promise<boolean>;
}

export const scheduleStoreOf = (db: Kysely<Database>): ScheduleStore => ({
  async create(schedule) {
    try {
      const row = await db
        .insertInto("crawlSchedules")
        .values({
          id: randomUUID(),
          orgId: schedule.orgId,
          name: schedule.name,
          cron: schedule.cron,
          nextRunAt: schedule.nextRunAt.toISOString(),
          request: JSON.stringify(schedule.request),
          recipe: JSON.stringify(schedule.recipe),
          pinnedAt: schedule.now.toISOString(),
          createdBy: schedule.createdBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "created", row };
    } catch (err) {
      if (isUniqueViolation(err, "crawl_schedules_org_name_key")) {
        return { kind: "duplicate-name" };
      }
      throw err;
    }
  },

  async list() {
    return db
      .selectFrom("crawlSchedules")
      .selectAll()
      .where("deletedAt", "is", null)
      .orderBy("createdAt")
      .execute();
  },

  async get(id) {
    return db
      .selectFrom("crawlSchedules")
      .selectAll()
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .executeTakeFirst();
  },

  async recentRuns(scheduleId) {
    const rows = await db
      .selectFrom("crawls")
      .leftJoin("crawlChanges", "crawlChanges.crawlId", "crawls.id")
      .select([
        "crawls.id as crawlId",
        "crawls.state",
        "crawls.scheduledFor",
        "crawls.startedAt",
        "crawls.finishedAt",
        "crawls.scheduleMissed",
        "crawls.pagesCaptured",
        pagesFailed.as("pagesFailed"),
        "crawls.error",
        "crawlChanges.state as changeState",
        "crawlChanges.pagesCompared",
        "crawlChanges.pagesChanged",
        "crawlChanges.significance",
        "crawlChanges.headline",
      ])
      .where("crawls.scheduleId", "=", scheduleId)
      .orderBy("crawls.startedAt", "desc")
      .limit(RECENT_RUNS)
      .execute();
    return rows.map(
      ({
        changeState,
        pagesCompared,
        pagesChanged,
        significance,
        headline,
        ...run
      }): ScheduleRun => ({
        ...run,
        change:
          changeState === null
            ? null
            : {
                state: changeState,
                pagesCompared: pagesCompared ?? 0,
                pagesChanged: pagesChanged ?? 0,
                significance,
                headline,
              },
      }),
    );
  },

  async runningCrawl() {
    return db
      .selectFrom("crawls")
      .select(["id as crawlId", "startedAt"])
      .where("state", "=", "running")
      .executeTakeFirst();
  },

  async lastCrawlStartedAt() {
    const row = await db
      .selectFrom("crawls")
      .select("startedAt")
      .orderBy("startedAt", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.startedAt;
  },

  async latestVersions() {
    const rows = await db
      .selectFrom("scripts")
      .select([
        "id",
        sql<number>`max(version)::int`.as("latest"),
        sql<number | null>`(max(version) filter (where enabled))::int`.as("latestEnabled"),
      ])
      .groupBy("id")
      .execute();
    return {
      named: new Map(rows.map((row) => [row.id, row.latest])),
      byDefault: new Map(
        rows.flatMap((row) =>
          row.latestEnabled === null ? [] : [[row.id, row.latestEnabled] as const],
        ),
      ),
    };
  },

  async candidate(now) {
    return db
      .selectFrom("crawlSchedules")
      .selectAll()
      .where("deletedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("runRequestedAt", "is not", null),
          eb.and([eb("enabled", "=", true), eb("nextRunAt", "<=", now)]),
        ]),
      )
      .orderBy(sql`run_requested_at is null`)
      .orderBy(sql`coalesce(run_requested_at, next_run_at)`)
      .limit(1)
      .executeTakeFirst();
  },

  async fire(plan) {
    const mark = {
      scheduleId: plan.scheduleId,
      scheduledFor: plan.scheduledFor === null ? null : plan.scheduledFor.toISOString(),
      scheduleMissed: plan.missed,
    };
    try {
      return await db.transaction().execute(async (trx): Promise<FireResult> => {
        // 候補を選んでからここまでの間に消された・止められた・別の周回が取った物は、始めない
        const held = await trx
          .selectFrom("crawlSchedules")
          .select("id")
          .where("id", "=", plan.scheduleId)
          .where("deletedAt", "is", null)
          .where((eb) =>
            eb.or([
              eb("runRequestedAt", "is not", null),
              eb.and([eb("enabled", "=", true), eb("nextRunAt", "<=", plan.now)]),
            ]),
          )
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (held === undefined) return { kind: "gone" };

        let result: FireResult;
        if (plan.failure === undefined) {
          const level = await insertCrawl(
            trx,
            plan.prepared,
            plan.crawlId,
            plan.who,
            plan.capture,
            plan.sink,
            mark,
          );
          result = { kind: "started", level };
        } else {
          // 始めなかった回も回として残す。残さないと、画面に出せない
          await trx
            .insertInto("crawls")
            .values({
              ...crawlValues(plan.prepared, plan.crawlId, plan.who, plan.sink, mark),
              state: "failed",
              stopReason: "failed",
              // `started_at` と同じ DB の時計 (トランザクションの時刻)。周回の時計だと始まりより前になりうる
              finishedAt: sql<string>`now()`,
              error: plan.failure,
            })
            .execute();
          result = { kind: "failed" };
        }

        await trx
          .updateTable("crawlSchedules")
          .set({
            ...(plan.nextRunAt !== undefined && { nextRunAt: plan.nextRunAt.toISOString() }),
            runRequestedAt: null,
          })
          .where("id", "=", plan.scheduleId)
          .execute();
        return result;
      });
    } catch (err) {
      // 走行中の行とぶつかった。トランザクションごと戻るので、予定は順番待ちのまま残る
      if (isUniqueViolation(err, "crawls_single_active")) return { kind: "busy" };
      throw err;
    }
  },

  async pause(id) {
    return (
      db
        .updateTable("crawlSchedules")
        // 待っている「いま撮る」の頼みも消す。止めたのに後で始まると、止めた意味が無い
        .set({ enabled: false, runRequestedAt: null })
        .where("id", "=", id)
        .where("deletedAt", "is", null)
        .returningAll()
        .executeTakeFirst()
    );
  },

  async resume(id, nextRunAt) {
    return (
      db
        .updateTable("crawlSchedules")
        .set({ enabled: true, nextRunAt: nextRunAt.toISOString() })
        .where("id", "=", id)
        .where("deletedAt", "is", null)
        // 止めた予定だけ。動いている予定の期限を動かすと、順番待ちの回が消える
        .where("enabled", "=", false)
        .returningAll()
        .executeTakeFirst()
    );
  },

  async requestRun(id, now) {
    return db
      .updateTable("crawlSchedules")
      .set({ runRequestedAt: now.toISOString() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst();
  },

  async repin(id, recipe, now) {
    return db
      .updateTable("crawlSchedules")
      .set({ recipe: JSON.stringify(recipe), pinnedAt: now.toISOString() })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returningAll()
      .executeTakeFirst();
  },

  async softDelete(id, now) {
    const rows = await db
      .updateTable("crawlSchedules")
      .set({ deletedAt: now.toISOString(), runRequestedAt: null })
      .where("id", "=", id)
      .where("deletedAt", "is", null)
      .returning("id")
      .execute();
    return rows.length > 0;
  },
});
