import { describe, it, expect } from "vitest";
import { planNextLevel } from "../src/crawl/budget.js";

/**
 * 上限の判定。
 *
 * ここが 1 つずれても、クロールは普通に終わって成果物も残る。**静かに間違う**ので、
 * 境目を 1 つずつ固定する。
 */
const links = (n: number): string[] => Array.from({ length: n }, (_, i) => `u${String(i)}`);

describe("深さの上限", () => {
  it("stops when the next level would go past max depth", () => {
    const plan = planNextLevel(links(5), { nextDepth: 3, maxDepth: 2, maxPages: 100, known: 1 });
    expect(plan).toEqual({ toInsert: [], stopReason: "max_depth" });
  });

  it("allows the last level that is still within max depth", () => {
    // 境目。`nextDepth === maxDepth` は入る。
    const plan = planNextLevel(links(2), { nextDepth: 2, maxDepth: 2, maxPages: 100, known: 1 });
    expect(plan.toInsert).toHaveLength(2);
    expect(plan.stopReason).toBeNull();
  });

  it("prefers depth over pages when both are exhausted", () => {
    // 両方に当たっているとき深さを優先するのは、そちらが先に効いた制約だから。
    // 件数と書くと「上限を上げれば続きが取れる」と読み手に思わせる。
    const plan = planNextLevel(links(5), { nextDepth: 9, maxDepth: 2, maxPages: 1, known: 99 });
    expect(plan.stopReason).toBe("max_depth");
  });
});

describe("件数の上限", () => {
  it("stops when the budget is already spent", () => {
    const plan = planNextLevel(links(5), { nextDepth: 1, maxDepth: 5, maxPages: 30, known: 30 });
    expect(plan).toEqual({ toInsert: [], stopReason: "max_pages" });
  });

  it("takes only what fits and says it cut", () => {
    // 枠のぶんだけ入れる。全部落とすと、当たるまでに取れたはずのページを捨てることになる。
    const plan = planNextLevel(links(10), { nextDepth: 1, maxDepth: 5, maxPages: 30, known: 28 });
    expect(plan.toInsert).toEqual(["u0", "u1"]);
    expect(plan.stopReason).toBe("max_pages");
  });

  it("says it cut even when only some got in", () => {
    // ここが `null` だと「全部辿った」と読めてしまう。**一部入っても打ち切りは打ち切り。**
    const plan = planNextLevel(links(3), { nextDepth: 1, maxDepth: 5, maxPages: 30, known: 29 });
    expect(plan.toInsert).toHaveLength(1);
    expect(plan.stopReason).toBe("max_pages");
  });

  it("does not cut when the level fits exactly", () => {
    // 境目。ちょうど収まるときは打ち切っていない。
    const plan = planNextLevel(links(2), { nextDepth: 1, maxDepth: 5, maxPages: 30, known: 28 });
    expect(plan.toInsert).toHaveLength(2);
    expect(plan.stopReason).toBeNull();
  });

  it("counts the seed against the budget", () => {
    // 起点も 1 件。既定の 30 なら、辿れるのは 29 件。
    const plan = planNextLevel(links(30), { nextDepth: 1, maxDepth: 5, maxPages: 30, known: 1 });
    expect(plan.toInsert).toHaveLength(29);
    expect(plan.stopReason).toBe("max_pages");
  });
});

describe("上限に当たらないとき", () => {
  it("passes everything through and reports no reason", () => {
    const plan = planNextLevel(links(3), { nextDepth: 1, maxDepth: 5, maxPages: 30, known: 1 });
    expect(plan.toInsert).toEqual(["u0", "u1", "u2"]);
    expect(plan.stopReason).toBeNull();
  });

  it("copies rather than handing back the caller's array", () => {
    // 呼ぶ側の配列をそのまま返すと、後で切り詰めたときに元まで変わる。
    const candidates = links(2);
    const plan = planNextLevel(candidates, { nextDepth: 1, maxDepth: 5, maxPages: 30, known: 1 });
    expect(plan.toInsert).not.toBe(candidates);
  });
});
