/**
 * 検査が読むファイル —— **git が repo の中身と見なす物全部**: 追跡しているファイルと、まだ add して
 * いない新しいファイル（ignore されている物は除く）。
 *
 * 以前の検査は `git ls-files`（追跡している物だけ）で読んでいた。CI は毎回まっさらに checkout するので
 * 未追跡のファイルは在らず、この穴は CI には出ない —— **手元では緑、commit した後の CI で赤**の形で出る。
 * 2026-09-13 の教訓で「走査は `--cached --others --exclude-standard`」と決め、その後も、この repo の
 * `check:terms` が新しい試験の注記の語を素通りした（教訓は「check の前に git add」で済ませ、別の repo で
 * また起きた）。人の手順ではなく、ここで直す。手本は browserhive の scripts/lib/tracked-files.mjs
 * （repo は別々に clone するので、写して持つ）。
 *
 * 消したファイル（追跡していて手元に無い物）と、submodule の入口（ディレクトリ）は返さない。
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** `root` からの相対の path。`pathspecs` を渡せば、その中だけ。並びは git の順（重なりは 1 つに）。 */
export const repoFiles = (root: string, pathspecs: readonly string[] = []): string[] => {
  const listed = execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path !== "");
  // 衝突の途中の path は、段ごとに何度も出る
  return [...new Set(listed)].filter(
    (path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true,
  );
};
