/**
 * 検査が読むファイル（`src/tools/repo-files.ts`）。check:terms と check:test-hosts が使う。
 *
 * CI はまっさらに checkout するので未追跡のファイルが無く、この関数が追跡だけを読んでも CI は緑のまま
 * —— 手元で、commit の前に新しいファイルを読むかどうかは、ここでしか確かめられない。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { repoFiles } from "../src/tools/repo-files.js";

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.email=t@t.test", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repo-files-"));
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  writeFileSync(join(root, "tracked.txt"), "a\n");
  writeFileSync(join(root, "gone.txt"), "b\n");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test", "old.test.ts"), "c\n");
  git("add", ".gitignore", "tracked.txt", "gone.txt", "test/old.test.ts");
  git("commit", "-q", "-m", "first");
  // まだ add していない新しいファイル・ignore される物・消した物
  writeFileSync(join(root, "new.txt"), "d\n");
  writeFileSync(join(root, "test", "new.test.ts"), "e\n");
  writeFileSync(join(root, "noise.log"), "f\n");
  rmSync(join(root, "gone.txt"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("repoFiles", () => {
  it("追跡している物と、まだ add していない新しい物を読む（ignore される物と、消した物は読まない）", () => {
    expect(repoFiles(root).sort()).toEqual(
      [".gitignore", "new.txt", "test/new.test.ts", "test/old.test.ts", "tracked.txt"].sort(),
    );
  });

  it("場所を絞っても、新しいファイルを読む", () => {
    expect(repoFiles(root, ["test"]).sort()).toEqual(["test/new.test.ts", "test/old.test.ts"]);
  });

  it("当たる物が無い場所は空（呼ぶ側が「範囲が空」と言う）", () => {
    expect(repoFiles(root, ["nowhere"])).toEqual([]);
  });
});
