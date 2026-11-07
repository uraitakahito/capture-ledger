/**
 * 予定の cron の式を読む。croner を直に触るのはここだけ。
 *
 * **式は 5 欄だけ受ける。** croner は秒つきの 6 欄も通すが、周回は 30 秒ごとなので秒には意味が無く、
 * 間隔の下限 (既定 60 分) とも噛み合わない。
 */
import { Cron } from "croner";

const FIELDS = 5;
/** 間隔を見る回数。`0,30 4 * * *` のように、続く 2 回だけでは短い間隔を見逃す式があるため。 */
const GAP_SAMPLES = 20;
/** 欠けを数える上限。周期の下限があるので、ここに届くのは何年も止まっていた予定だけ。 */
const MISSED_MAX = 10_000;

const cronOf = (cron: string, timezone: string): Cron => new Cron(cron, { timezone, paused: true });

export type CronCheck =
  | { kind: "ok"; next: Date }
  | { kind: "invalid"; reason: string }
  | { kind: "too-often"; gapMinutes: number };

/** 作るときの確かめ。読めない式・もう来ない式・間隔が下限より短い式を断る。 */
export const checkCron = (
  cron: string,
  timezone: string,
  now: Date,
  minIntervalMinutes: number,
): CronCheck => {
  if (cron.trim().split(/\s+/).length !== FIELDS) {
    return { kind: "invalid", reason: `cron must have ${String(FIELDS)} fields` };
  }
  let times: Date[];
  try {
    times = cronOf(cron, timezone).nextRuns(GAP_SAMPLES, now);
  } catch (err) {
    return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
  const next = times[0];
  if (next === undefined) return { kind: "invalid", reason: "cron never runs" };
  let gapMinutes = Number.POSITIVE_INFINITY;
  for (let i = 1; i < times.length; i += 1) {
    const before = times[i - 1];
    const after = times[i];
    if (before === undefined || after === undefined) continue;
    gapMinutes = Math.min(gapMinutes, (after.getTime() - before.getTime()) / 60_000);
  }
  return gapMinutes < minIntervalMinutes ? { kind: "too-often", gapMinutes } : { kind: "ok", next };
};

/** `after` より後の次の回。ちょうど `after` の回は含まない。 */
export const nextRunAfter = (cron: string, timezone: string, after: Date): Date => {
  const next = cronOf(cron, timezone).nextRun(after);
  // 作るときに `checkCron` が「もう来ない式」を断っているので、ここへは来ない
  if (next === null) throw new Error(`cron has no next run: ${cron}`);
  return next;
};

/**
 * 本来の回 (`due`) より後で、`now` までに過ぎた回の数。1 回にまとめるので、これが「欠け」になる。
 * 11-04 04:00 が期限のまま 11-07 09:36 に始めれば、欠けは 3 (11-05・11-06・11-07 の 04:00)。
 */
export const missedSince = (cron: string, timezone: string, due: Date, now: Date): number => {
  const job = cronOf(cron, timezone);
  let missed = 0;
  for (
    let at = job.nextRun(due);
    at !== null && at.getTime() <= now.getTime() && missed < MISSED_MAX;
    at = job.nextRun(at)
  ) {
    missed += 1;
  }
  return missed;
};
