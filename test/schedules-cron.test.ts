import { describe, expect, it } from "vitest";

import { checkCron, missedSince, nextRunAfter } from "../src/schedules/cron.js";

const TOKYO = "Asia/Tokyo";
const jst = (text: string) => new Date(`${text}+09:00`);

describe("予定の cron の式", () => {
  it("次の回は渡した時刻の後で、時差に従う", () => {
    expect(nextRunAfter("0 4 * * *", TOKYO, jst("2026-11-07T14:10:00"))).toEqual(
      jst("2026-11-08T04:00:00"),
    );
  });

  it("ちょうど 04:00 の次は翌日", () => {
    expect(nextRunAfter("0 4 * * *", TOKYO, jst("2026-11-08T04:00:00"))).toEqual(
      jst("2026-11-09T04:00:00"),
    );
  });

  it("欠けは本来の回の後から今までに過ぎた回の数", () => {
    expect(
      missedSince("0 4 * * *", TOKYO, jst("2026-11-04T04:00:00"), jst("2026-11-07T09:36:00")),
    ).toBe(3);
  });

  it("本来の回のすぐ後なら欠けは 0", () => {
    expect(
      missedSince("0 4 * * *", TOKYO, jst("2026-11-04T04:00:00"), jst("2026-11-04T04:00:30")),
    ).toBe(0);
  });

  it("ちょうど次の回の時刻なら、その回も欠けに数える", () => {
    expect(
      missedSince("0 4 * * *", TOKYO, jst("2026-11-04T04:00:00"), jst("2026-11-05T04:00:00")),
    ).toBe(1);
  });
});

describe("作るときの確かめ", () => {
  const now = jst("2026-11-07T14:10:00");

  it("毎日の式は通り、次の回を返す", () => {
    expect(checkCron("0 4 * * *", TOKYO, now, 60)).toEqual({
      kind: "ok",
      next: jst("2026-11-08T04:00:00"),
    });
  });

  it("週に 1 度の式も通る", () => {
    expect(checkCron("0 4 * * 1", TOKYO, now, 60).kind).toBe("ok");
  });

  it("欄の数が違えば断る（6 欄は croner なら通る形）", () => {
    expect(checkCron("0 0 4 * * *", TOKYO, now, 60)).toEqual({
      kind: "invalid",
      reason: "cron must have 5 fields",
    });
  });

  it.each(["61 4 * * *", "毎日 x y z w"])("読めない式 %s を断る", (cron) => {
    expect(checkCron(cron, TOKYO, now, 60).kind).toBe("invalid");
  });

  it("もう来ない式を断る", () => {
    expect(checkCron("0 0 31 2 *", TOKYO, now, 60).kind).toBe("invalid");
  });

  it("間隔が下限より短い式を断る", () => {
    expect(checkCron("*/5 * * * *", TOKYO, now, 60)).toEqual({ kind: "too-often", gapMinutes: 5 });
  });

  it("続く 2 回だけでは見逃す短い間隔も断る（いまが 04:15 なら次の 2 回は 23 時間半あく）", () => {
    expect(checkCron("0,30 4 * * *", TOKYO, jst("2026-11-07T04:15:00"), 60)).toEqual({
      kind: "too-often",
      gapMinutes: 30,
    });
  });

  it("下限ちょうどの間隔は通る", () => {
    expect(checkCron("0 * * * *", TOKYO, now, 60).kind).toBe("ok");
  });
});
