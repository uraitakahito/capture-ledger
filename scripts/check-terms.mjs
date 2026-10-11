/**
 * クロールの seed を、旧い訳語で書いていないかを見張る。
 *
 * ## なぜ要るのか
 *
 * seed の訳語は 2026-10 に「種」から「起点」へそろえた（docs・コメント・試験の名前・
 * CLI の説明で 78 か所）。「種」は読み手に通じにくく、単独では「しゅ」（種類）とも読める。
 * 書き手（人と Claude）は長く「種」と書いてきたので、見張らなければ戻ってくる。
 *
 * ## 何を見るか
 *
 * git が追跡する text のファイルの全行で、熟語（種類・種別）と、数のあとの「N 種」の
 * 外に立つ「種」。docs に限らない —— 語は、書かれる場所を選ばずに広がる。
 *
 * ## 見ないもの
 *
 *   - submodule（.upstream/）と lockfile。この repo の言葉ではない
 *   - この file 自身。説明と、探す字そのものを書くため
 *   - 「起点」を seed の意味で使っているか。語の意味は機械には見えない
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SELF = "scripts/check-terms.mjs";
/** 許す形。足すときは、その形が seed の意味を持ちえないことを確かめる。 */
const ALLOWED = /種類|種別|\d\s?種/gu;

const files = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "" && f !== SELF && f !== "pnpm-lock.yaml" && !f.startsWith(".upstream/"));

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue; // submodule の入口はディレクトリで、読めない
  }
  if (text.includes("\0")) continue; // 画像などの binary
  text.split("\n").forEach((line, i) => {
    if (line.replace(ALLOWED, "").includes("種"))
      hits.push(`${file}:${String(i + 1)}: ${line.trim()}`);
  });
}

if (hits.length > 0) {
  console.error(
    "「種」が残っています。クロールの seed は「起点」と書きます（本で数えるなら「起点の URL が N 本」）。",
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`check:terms: ${String(files.length)} ファイルを見て、0 件`);
