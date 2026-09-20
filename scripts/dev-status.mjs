#!/usr/bin/env node
/**
 * いま何が立っているかを 1 画面で言う。**何も変えない。**
 *
 * 見るのは 4 つ。コンテナ・ホストのプロセス・設定・目録。どれも「立ち上げの
 * どこまで済んでいるか」を答えるためのもので、`pnpm run dev:up` が止まったとき
 * (段 6) と、朝いちばんに「昨日のが残っているか」を見るときに使う。
 *
 * **読めないことと、無いことを混ぜない。** コンテナを数えられない (container が
 * 入っていない) のと 0 件は別だし、目録が読めない (DB が起きていない) のと
 * 空の目録も別。前者は理由を書く。
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_PROCESSES, containersByDomain, inspect } from "./daemons.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 左の見出しを揃える。**`padEnd` は使えない** —— 数えるのは UTF-16 の要素数なので、
 * 「コンテナ」(4 要素・8 桁) と「設定」(2 要素・4 桁) が別の幅になる。
 */
const width = (text) => [...text].reduce((n, ch) => n + (ch.codePointAt(0) > 0x7f ? 2 : 1), 0);
const row = (label, text) => `${label}${" ".repeat(Math.max(1, 12 - width(label)))}${text}`;

// ── コンテナ ────────────────────────────────────────────────────────
const counts = containersByDomain();
if (counts === undefined) {
  console.log(row("コンテナ", "数えられない (container コマンドが無いか、答えない)"));
} else if (counts.size === 0) {
  console.log(row("コンテナ", "1 つも動いていない"));
} else {
  const shown = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, n]) => `${domain} ${String(n)}`)
    .join(" / ");
  console.log(row("コンテナ", shown));
}

// ── ホストのプロセス ────────────────────────────────────────────────
// **compose では消えない 2 本。** どちらもコンテナではないので、スタックを
// 落としても残る。2026-09-20 に 9099 を塞いでいたのはこれ。
for (const [index, spec] of HOST_PROCESSES.entries()) {
  const found = inspect(spec);
  const label = index === 0 ? "ホスト" : "";
  if (found.length === 0) {
    console.log(row(label, `${spec.name.padEnd(7)} 居ない (:${String(spec.port)} は空いている)`));
    continue;
  }
  for (const proc of found) {
    const mine = proc.ours ? "" : "  ← この repo のものではない";
    console.log(
      row(
        label,
        `${spec.name.padEnd(7)} pid ${String(proc.pid)}  ${proc.startedAt}  :${String(spec.port)}${mine}`,
      ),
    );
    if (!proc.ours) console.log(row("", `        ${proc.command}`));
  }
}

// ── 設定 ────────────────────────────────────────────────────────────
// 名前を数えずに、**どの道具が走ったか** を訊く。`.env.local` に在る名前が
// そのまま「fga:deploy を打ったか」「connect を打ったか」の答えになる。
const declares = (file, name) => {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => line.startsWith(`${name}=`));
};
const mark = (ok) => (ok ? "✓" : "✗");
const files = [".env", ".env.local"]
  .map((file) => `${file} ${mark(existsSync(resolve(ROOT, file)))}`)
  .join("   ");
console.log(row("設定", files));
console.log(
  row(
    "",
    `fga:deploy ${mark(declares(".env.local", "CAPTURE_LEDGER_FGA_MODEL_ID"))}   ` +
      `connect ${mark(declares(".env.local", "CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN"))}   ` +
      "(どちらも .env.local に書く。打ち直せば作り直せる)",
  ),
);

// ── 目録 ────────────────────────────────────────────────────────────
// ページで走らせる JavaScript。**空だと、撮れているのに何も走らない。**
const cli = resolve(ROOT, "dist/scripts/cli.js");
if (!existsSync(cli)) {
  console.log(row("目録", "読めない (pnpm run build がまだ)"));
} else {
  const listed = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env", "--env-file-if-exists=.env.local", cli, "list"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (listed.status !== 0) {
    const why = `${listed.stderr ?? ""}`.trim().split("\n").at(-1) ?? "理由が出ない";
    console.log(row("目録", `読めない (${why})`));
  } else {
    const lines = `${listed.stdout ?? ""}`.trim().split("\n").filter(Boolean);
    console.log(row("目録", lines.length === 0 ? "空 (何も走らない)" : lines[0]));
    for (const line of lines.slice(1)) console.log(row("", line));
  }
}
