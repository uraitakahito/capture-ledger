import { describe, it, expect } from "vitest";
import { archiveRow } from "../src/archive/admit.js";
import type { CaptureResultReport } from "../src/archive/manifest.js";

/**
 * 取り込みの報告から台帳の 1 行を組む写像。
 *
 * ここが答えるのは 1 つ —— **署名の有無が台帳から読めるか**。読めないと、
 * 10,000 件の中から「証拠として使える形のもの」を探すのに 10,000 回 zip を
 * 開くことになる。
 *
 * `signed` は 3 状態で、`false` と `null` を潰してはならない:
 *
 *   true   —— 署名を求め、付いた
 *   false  —— 署名の報告が届き、付いていなかった (配備の異常)
 *   null   —— そもそも求めていない (正常)
 */
const LOCATION = { bucket: "browserhive", key: "task_.wacz" };

const report = (over: Partial<CaptureResultReport> = {}): CaptureResultReport => ({
  taskId: "550e8400-e29b-41d4-a716-446655440000",
  url: "https://example.com/",
  labels: [],
  status: "success",
  timestamp: "2026-09-08T00:00:00.000Z",
  captureProcessingTimeMs: 0,
  ...over,
});

describe("archiveRow", () => {
  it("署名された取り込みは signed: true で台帳に載る", () => {
    expect(archiveRow(report({ signature: { signed: true } }), LOCATION).signed).toBe(true);
  });

  /**
   * 求めていない取り込みでは報告ごと来ない。`?? null` を落として `?.` だけにすると
   * `undefined` が入り、Kysely は列を省いて既定値に落とす —— 「報告が届かなかった」が
   * 「NULL」ではなく「既定」に化ける。
   */
  it("署名を求めていない取り込みは null になる（undefined ではない）", () => {
    const row = archiveRow(report(), LOCATION);
    expect(row.signed).toBeNull();
    expect(Object.hasOwn(row, "signed")).toBe(true);
  });

  /** `false` と `null` は別の主張。潰すと配備の異常が正常と同じ見た目になる。 */
  it("署名の報告が届いて付いていなければ false で、null と区別される", () => {
    expect(archiveRow(report({ signature: { signed: false } }), LOCATION).signed).toBe(false);
  });

  it("completeness も同じ 3 状態を保つ", () => {
    expect(archiveRow(report(), LOCATION).waczComplete).toBeNull();
    const complete = { complete: true, bodylessUrls: [], truncatedUrls: [] };
    expect(archiveRow(report({ completeness: complete }), LOCATION).waczComplete).toBe(true);
  });
});
