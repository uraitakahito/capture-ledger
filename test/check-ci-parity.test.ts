/**
 * check-ci-parity（`src/tools/check-ci-parity.ts`）の、`check` と roster の push の一覧の突き合わせ (⑤〜⑧)。
 *
 * どの判定も「止める入力」と「通す入力」の両方を固定する。片方しか無いと、常に止める実装も
 * 常に通す実装も緑で通ってしまう。
 */
import { describe, expect, it } from "vitest";

import { NOT_IN_PUSH, pushProblems } from "../src/tools/check-ci-parity.js";

interface PushCheck {
  name: string;
  run: string[];
}

const MEMBERS = [...Object.keys(NOT_IN_PUSH), "lint", "test"];

const LINT: PushCheck = { name: "lint", run: ["pnpm", "run", "lint"] };
const TEST: PushCheck = { name: "test", run: ["pnpm", "test"] };

/** JSONC の書き方 (注記と末尾のカンマ) のまま、push の一覧を書く。 */
const config = (checks: PushCheck[]): string =>
  `// 注記\n{ "push": { "checks": [${checks.map((c) => `${JSON.stringify(c)},`).join("\n")}] }, }\n`;

const check = (checks: PushCheck[], members: string[] = MEMBERS): string[] =>
  pushProblems({ members, configText: config(checks) }).problems;

describe("check-ci-parity の push の突き合わせ", () => {
  it("決めた形なら、何も言わない（並びは見ない）", () => {
    expect(check([TEST, LINT])).toEqual([]);
  });

  it("JSONC として読めなければ、それだけを言う", () => {
    expect(pushProblems({ members: MEMBERS, configText: "{ " }).problems).toEqual([
      expect.stringContaining("が読めない"),
    ]);
  });

  it("pnpm の script でない確かめは止める", () => {
    expect(check([LINT, TEST, { name: "x", run: ["sh", "-c", "true"] }])).toEqual([
      expect.stringContaining('"x" は pnpm の script ではない: sh -c true'),
    ]);
  });

  it("⑤ NOT_IN_PUSH の物が check に無ければ止める", () => {
    expect(
      check(
        [LINT, TEST],
        MEMBERS.filter((s) => s !== "audit"),
      ),
    ).toEqual([expect.stringContaining('NOT_IN_PUSH の "audit" が check に無い')]);
  });

  it("⑥ NOT_IN_PUSH の物が push に在れば止める", () => {
    expect(check([LINT, TEST, { name: "x", run: ["pnpm", "run", "audit"] }])).toEqual([
      expect.stringContaining('"audit" は .claude/roles/config.jsonc の push に在る'),
    ]);
  });

  it("⑦ check の物が push に無ければ止める", () => {
    expect(check([TEST])).toEqual([expect.stringContaining('check の "lint" が')]);
  });

  it("⑧ push の物が check に無ければ止める", () => {
    expect(check([LINT, TEST, { name: "x", run: ["pnpm", "run", "extra"] }])).toEqual([
      expect.stringContaining('push の "extra" が check に無い'),
    ]);
  });
});
