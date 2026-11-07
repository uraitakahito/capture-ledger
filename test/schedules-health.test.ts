import { describe, expect, it } from "vitest";

import { scheduleHealth, type HealthInput } from "../src/schedules/health.js";

const now = new Date("2026-11-07T06:00:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const input = (overrides: Partial<HealthInput>): HealthInput => ({
  enabled: true,
  nextRunAt: later(600),
  runRequestedAt: null,
  lastRun: { state: "succeeded", startedAt: ago(120) },
  now,
  ...overrides,
});

describe("予定の状態", () => {
  it("何も無ければ ok", () => {
    expect(scheduleHealth(input({}))).toBe("ok");
  });

  it("まだ 1 回も走っていなくても、期限の前なら ok", () => {
    expect(scheduleHealth(input({ lastRun: null }))).toBe("ok");
  });

  it("止めた予定は、何があっても paused", () => {
    expect(
      scheduleHealth(
        input({
          enabled: false,
          nextRunAt: ago(600),
          lastRun: { state: "failed", startedAt: ago(700) },
        }),
      ),
    ).toBe("paused");
  });

  it("直近の回が failed なら failing", () => {
    expect(scheduleHealth(input({ lastRun: { state: "failed", startedAt: ago(30) } }))).toBe(
      "failing",
    );
  });

  it("期限が来て 1 時間までは blocked（順番待ち）", () => {
    expect(scheduleHealth(input({ nextRunAt: ago(59) }))).toBe("blocked");
  });

  it("期限から 1 時間で overdue", () => {
    expect(scheduleHealth(input({ nextRunAt: ago(60) }))).toBe("overdue");
  });

  it("いま撮るの頼みが待っていれば blocked", () => {
    expect(scheduleHealth(input({ runRequestedAt: ago(5) }))).toBe("blocked");
  });

  it("いま撮るの頼みから 1 時間で overdue（期限が先でも）", () => {
    expect(scheduleHealth(input({ runRequestedAt: ago(60) }))).toBe("overdue");
  });

  it("失敗した回があって次の回も遅れていれば overdue を先に言う", () => {
    expect(
      scheduleHealth(
        input({ nextRunAt: ago(120), lastRun: { state: "failed", startedAt: ago(1500) } }),
      ),
    ).toBe("overdue");
  });

  it("走っている回が 1 時間までは ok", () => {
    expect(scheduleHealth(input({ lastRun: { state: "running", startedAt: ago(59) } }))).toBe("ok");
  });

  it("走っている回が 1 時間で stuck（次の期限が明日でも）", () => {
    expect(
      scheduleHealth(
        input({ nextRunAt: later(1200), lastRun: { state: "running", startedAt: ago(120) } }),
      ),
    ).toBe("stuck");
  });

  it("走ったままで次の期限も過ぎていれば stuck を先に言う（閉じるべき行が分かるので）", () => {
    expect(
      scheduleHealth(
        input({ nextRunAt: ago(120), lastRun: { state: "running", startedAt: ago(1500) } }),
      ),
    ).toBe("stuck");
  });
});
