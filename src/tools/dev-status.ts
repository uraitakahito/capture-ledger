#!/usr/bin/env node
/**
 * いま何が立っているかを 1 画面で言う。**何も変えない。**
 *
 * 見るのは 5 つ。コンテナ・ホストのプロセス・設定・保管庫・スクリプト。どれも「立ち上げの
 * どこまで済んでいるか」を答えるためのもので、`pnpm run dev:up` が止まったとき
 * (段 6) と、朝いちばんに「昨日のが残っているか」を見るときに使う。
 *
 * **読めないことと、無いことを混ぜない。** コンテナを数えられない (container が
 * 入っていない) のと 0 件は別だし、スクリプトが読めない (DB が起きていない) のと
 * スクリプトが 0 本なのも別。前者は理由を書く。
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { ROOT } from "./root.js";
import type { HostProcess } from "./daemons.js";
import {
  HOST_PROCESSES,
  behindHead,
  checkoutOf,
  compareBuild,
  containersByDomain,
  inspect,
  runningBuild,
} from "./daemons.js";

/**
 * 左の見出しを揃える。**`padEnd` は使えない** —— 数えるのは UTF-16 の要素数なので、
 * 「コンテナ」(4 要素・8 桁) と「設定」(2 要素・4 桁) が別の幅になる。
 */
const width = (text: string) =>
  // 1 文字ずつなので code point は必ず在る。`?? 0` は型を絞るためで、そこへは来ない
  // (来ても `undefined > 0x7f` と同じく 1 桁に数える)。
  [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0x7f ? 2 : 1), 0);
const row = (label: string, text: string) =>
  `${label}${" ".repeat(Math.max(1, 12 - width(label)))}${text}`;

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

/**
 * 動いている build が checkout と同じかを 1 行で言う。**違うなら、直す 1 行を添える。**
 * 居ることは分かっても、何が動いているかは pid と時刻からは読めない —— 2026-09-26 に
 * 見た validator は v0.28.1 のまま 2 日動いていて、その間に v0.29.0 と v0.30.0 が
 * 出ていた。この画面には「居る」とだけ出ていた。
 */
const buildLine = async (spec: HostProcess) => {
  const running = await runningBuild(spec);
  if (running === undefined)
    return `版を訊けない (:${String(spec.port)}${spec.identity} が答えない)`;
  const named = `${running.version} (${running.gitSha})`;
  const checkout = checkoutOf(spec.root);
  if (checkout === undefined) return `${named}  checkout を読めない (git が答えない)`;
  switch (compareBuild(running, checkout)) {
    case "same":
      return `${named}  checkout と同じ`;
    case "unsure":
      return `${named}  未コミットの変更があり、checkout と同じかは分からない`;
    default: {
      const older = behindHead(spec.root, running.gitSha.replace(/-dirty$/, ""));
      return (
        `${named}  checkout は ${checkout.head.slice(0, 7)} —— ${older ? "古い" : "違う"} build が動いている\n` +
        row("", `           起こし直す: pnpm run dev:up --from ${spec.name}`)
      );
    }
  }
};

// **compose では消えない 4 本。** どれもコンテナではないので、スタックを
// 落としても残る。2026-09-20 に 9099 を塞いでいたのは issuer だった。
for (const [index, spec] of HOST_PROCESSES.entries()) {
  const found = inspect(spec);
  const label = index === 0 ? "ホスト" : "";
  if (found.length === 0) {
    console.log(row(label, `${spec.name.padEnd(10)} 居ない (:${String(spec.port)} は空いている)`));
    continue;
  }
  for (const proc of found) {
    const mine = proc.ours ? "" : "  ← この repo のものではない";
    console.log(
      row(
        label,
        `${spec.name.padEnd(10)} pid ${String(proc.pid)}  ${proc.startedAt}  :${String(spec.port)}${mine}`,
      ),
    );
    if (!proc.ours) console.log(row("", `        ${proc.command}`));
    else if (spec.identity !== undefined)
      console.log(row("", `           ${await buildLine(spec)}`));
  }
}

// ── 設定 ────────────────────────────────────────────────────────────
// 名前を数えずに、**どの道具が走ったか** を訊く。`.env.local` に在る名前が
// そのまま「fga:deploy を打ったか」「connect を打ったか」の答えになる。
const declares = (file: string, name: string) => {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => line.startsWith(`${name}=`));
};
const mark = (ok: boolean) => (ok ? "✓" : "✗");
const files = [".env", ".env.local"]
  .map((file) => `${file} ${mark(existsSync(resolve(ROOT, file)))}`)
  .join("   ");
console.log(row("設定", files));
console.log(
  row(
    "",
    `fga:deploy ${mark(declares(".env.local", "CAPTURE_LEDGER_FGA_MODEL_ID"))}   ` +
      `connect ${mark(declares(".env.local", "CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN"))}   ` +
      `search:connect ${mark(declares(".env.local", "CAPTURE_LEDGER_OPENSEARCH_URL"))}   ` +
      "(どれも .env.local に書く。打ち直せば作り直せる)",
  ),
);

// ── 検索 ────────────────────────────────────────────────────────────
// 全文検索は必須 (CAPTURE-53)。宛先が答えるかと、索引に何件在るかを言う。宛先は node と同じ順に読む
// (.env の後に .env.local。名前が重なれば .env.local が勝つ)。
const valueIn = (file: string, name: string): string | undefined => {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .findLast((one) => one.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
};
const settingOf = (name: string): string | undefined =>
  valueIn(".env.local", name) ?? valueIn(".env", name);
const searchUrl = settingOf("CAPTURE_LEDGER_OPENSEARCH_URL");
const searchIndex = settingOf("CAPTURE_LEDGER_OPENSEARCH_INDEX") ?? "capture-pages";
const answerOf = async (url: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
if (searchUrl === undefined) {
  console.log(
    row("検索", "宛先が無い (pnpm run dev:up --from search で起こして .env.local に書く)"),
  );
} else {
  const health = await answerOf(`${searchUrl}/_cluster/health`);
  if (health === undefined) {
    console.log(
      row(
        "検索",
        `${searchUrl} が答えない (起こすのは pnpm run stack:up --profile search opensearch。` +
          "起こし直した索引は空なので、続けて pnpm run search:reindex)",
      ),
    );
  } else {
    const counted = await answerOf(`${searchUrl}/${searchIndex}/_count`);
    const docs =
      counted === undefined
        ? "無い (API が起動の時に作る。API が動いたまま OpenSearch を起こし直したなら pnpm run search:reindex)"
        : `${String(counted["count"])} 件`;
    console.log(
      row("検索", `${searchUrl}  health ${String(health["status"])}  索引 ${searchIndex}: ${docs}`),
    );
  }
}

// ── 保管庫 ──────────────────────────────────────────────────────────
// 枠 (volume の本数の上限) が尽きると、書き込みが 500 で止まる。master の答えをそのまま言う
// (seaweedfs の docs「枠」)。bucket の本数は、その bucket が書ける volume の数。
const store = await answerOf("http://127.0.0.1:9333/dir/status");
if (store === undefined) {
  console.log(row("保管庫", "答えない (起こすのは sh .upstream/seaweedfs/scripts/stack.sh up)"));
} else {
  const topology = store["Topology"] as
    | {
        Max?: number;
        Free?: number;
        Layouts?: { collection?: string; writables?: number[] | null }[];
      }
    | undefined;
  const buckets = (topology?.Layouts ?? [])
    .filter((layout) => (layout.collection ?? "") !== "")
    .map((layout) => `${String(layout.collection)} ${String(layout.writables?.length ?? 0)} 本`)
    .join(" / ");
  console.log(
    row(
      "保管庫",
      `枠 ${String(topology?.Max)}  空き ${String(topology?.Free)}  書ける ${buckets === "" ? "(まだ無い)" : buckets}`,
    ),
  );
  if (topology?.Free === 0) {
    console.log(row("", "枠が尽きている。枠が 8 なら古い entrypoint で立っている (stack.sh up)"));
  }
}

// ── スクリプト ──────────────────────────────────────────────────────
// ページで走らせる JavaScript。**空だと、撮れているのに何も走らない。**
const cli = resolve(ROOT, "dist/scripts/cli.js");
if (!existsSync(cli)) {
  console.log(row("スクリプト", "読めない (pnpm run build がまだ)"));
} else {
  const listed = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env", "--env-file-if-exists=.env.local", cli, "list"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (listed.status !== 0) {
    const why = `${listed.stderr ?? ""}`.trim().split("\n").at(-1) ?? "理由が出ない";
    console.log(row("スクリプト", `読めない (${why})`));
  } else {
    const lines = `${listed.stdout ?? ""}`.trim().split("\n").filter(Boolean);
    console.log(row("スクリプト", lines[0] ?? "空 (何も走らない)"));
    for (const line of lines.slice(1)) console.log(row("", line));
  }
}
