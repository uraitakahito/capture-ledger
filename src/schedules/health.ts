/**
 * 予定の状態の判定。**純粋な関数で、上から順に見る。** 帯を出すか、文をどうするかは workbench が決める。
 *
 * `stuck` を分けたのは、毎日の予定は次の期限が約 24 時間先だから。「期限を過ぎた」だけで見ると、04:00 に
 * 止まった回が翌朝の 05:00 まで何も言わない。1 時間は目安で、本当に走っている長いクロールでも `stuck` になる。
 * 害は帯が出ることだけで、行を勝手に閉じることはしない。
 */
import type { CrawlState } from "../db/database.js";

export type ScheduleHealth = "paused" | "stuck" | "overdue" | "failing" | "blocked" | "ok";

/** 遅れと見なす長さ。 */
export const LATE_MS = 60 * 60 * 1000;

export interface HealthInput {
  enabled: boolean;
  nextRunAt: Date;
  runRequestedAt: Date | null;
  /** 直近の回。まだ 1 回も無ければ null。 */
  lastRun: { state: CrawlState; startedAt: Date } | null;
  now: Date;
}

export const scheduleHealth = ({
  enabled,
  nextRunAt,
  runRequestedAt,
  lastRun,
  now,
}: HealthInput): ScheduleHealth => {
  const at = now.getTime();
  if (!enabled) return "paused";
  if (lastRun?.state === "running" && at - lastRun.startedAt.getTime() >= LATE_MS) return "stuck";
  const due = runRequestedAt === null ? nextRunAt : new Date(Math.min(+nextRunAt, +runRequestedAt));
  if (at - due.getTime() >= LATE_MS) return "overdue";
  if (lastRun?.state === "failed") return "failing";
  if (runRequestedAt !== null || nextRunAt.getTime() <= at) return "blocked";
  return "ok";
};
