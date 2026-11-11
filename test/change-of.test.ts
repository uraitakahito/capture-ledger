import { describe, expect, it } from "vitest";

import { changeOf, linesOf } from "../src/changes/change-of.js";

describe("ページの文字の差分 (changeOf)", () => {
  it("同じ文字なら変化なし・塊も無い", () => {
    expect(changeOf("a\nb\nc", "a\nb\nc")).toEqual({
      changed: false,
      added: 0,
      removed: 0,
      hunks: [],
    });
  });

  it("空行と行の両端の空白は比べない", () => {
    expect(linesOf("  a \n\n\tb\r\n\n")).toEqual(["a", "b"]);
    expect(changeOf("a\n\nb", "  a\nb  \n\n").changed).toBe(false);
  });

  it("1 行の入れ替わりは、消した行と足した行が 1 つずつで、前後 2 行の文脈が付く", () => {
    const before = ["h1", "h2", "h3", "更新: 2026-11-01", "f1", "f2", "f3"].join("\n");
    const after = ["h1", "h2", "h3", "更新: 2026-11-02", "f1", "f2", "f3"].join("\n");
    expect(changeOf(before, after)).toEqual({
      changed: true,
      added: 1,
      removed: 1,
      hunks: [[" h2", " h3", "-更新: 2026-11-01", "+更新: 2026-11-02", " f1", " f2"]],
    });
  });

  it("離れた 2 か所は別の塊、近い 2 か所は 1 つの塊", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${String(i)}`);
    const far = [...lines];
    far[2] = "x";
    far[15] = "y";
    expect(changeOf(lines.join("\n"), far.join("\n")).hunks).toHaveLength(2);
    const near = [...lines];
    near[5] = "x";
    near[8] = "y";
    expect(changeOf(lines.join("\n"), near.join("\n")).hunks).toHaveLength(1);
  });

  it("足しただけ・消しただけも数える", () => {
    expect(changeOf("a\nb", "a\nb\nc")).toMatchObject({ added: 1, removed: 0 });
    expect(changeOf("a\nb\nc", "a\nc")).toMatchObject({ added: 0, removed: 1 });
    expect(changeOf("", "a")).toMatchObject({ changed: true, added: 1, removed: 0 });
  });

  it("文脈を 0 にすると、変わった行だけになる", () => {
    expect(changeOf("a\nb\nc", "a\nB\nc", 0).hunks).toEqual([["-b", "+B"]]);
  });
});
