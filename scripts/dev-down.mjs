#!/usr/bin/env node
/**
 * 開発で立てたものを落とす。**ホストのプロセスから先に。**
 *
 * `container-compose down` はコンテナしか知らない。issuer (9099) と api (7070) は
 * ホストのプロセスなので、スタックを落としても残る —— 2026-09-20 に
 * `EADDRINUSE 127.0.0.1:9099` で止まったのは、前の日に手で起こした issuer が
 * 残っていたから。**後始末が 1 本になっていれば起きなかった。**
 *
 * ## 打つコマンドを、打つ前に印字する
 *
 * この形 (何本ものコマンドを 1 本に束ねるもの) は一度消している。capture-ledger の
 * setup.sh は 2026-09-19 に消した —— 「中身が束で、名前が中身より大きい。読んだ人は
 * 無い仕事を想像する」。だから束ねるが隠さない: 走らせるコマンドは 1 行ずつ出す。
 * 出力を上から読めば、手で同じことをする手順書になっている。
 *
 * ## 落とさないもの
 *
 * 共有 store (`seaweedfs.crawler-storage`) は crawler で 1 つしかなく、他の repo も
 * 使っている。**ここから落としてよいものではない。**
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_PROCESSES, inspect, stop } from "./daemons.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 隣の repo。**書き込みはしない** —— 向こうの停止は向こうのコマンドに任せる。 */
const SCHEDULER = resolve(ROOT, "../capture-scheduler");

let refused = 0;

// ── ① ホストのプロセス ──────────────────────────────────────────────
for (const spec of HOST_PROCESSES) {
  const found = inspect(spec);
  if (found.length === 0) {
    console.log(`・ ${spec.name.padEnd(7)} 居ない (:${String(spec.port)})`);
    continue;
  }
  for (const proc of found) {
    if (!proc.ours) {
      // **止めない。** port から引いた PID は、先客かもしれない。何が握っているかを
      // 見せて、決めるのは打った人に返す。
      refused += 1;
      console.log(`✗ ${spec.name.padEnd(7)} :${String(spec.port)} は別のものが握っている`);
      console.log(`    pid ${String(proc.pid)}  ${proc.startedAt}`);
      console.log(`    ${proc.command}`);
      console.log(`    止めるなら自分で: kill ${String(proc.pid)}`);
      continue;
    }
    const outcome = await stop(proc.pid);
    const said = {
      stopped: `止めた (pid ${String(proc.pid)})`,
      gone: `もう居なかった (pid ${String(proc.pid)})`,
      running: `SIGTERM に応えない (pid ${String(proc.pid)})。kill -9 ${String(proc.pid)}`,
    }[outcome];
    console.log(`${outcome === "running" ? "✗" : "✓"} ${spec.name.padEnd(7)} ${said}`);
    if (outcome === "running") refused += 1;
  }
}

// ── ② コンテナ ──────────────────────────────────────────────────────
// **それぞれの repo のコマンドで落とす。** 生の container-compose を叩かないのは、
// capture-ledger 側は profile の組み合わせを stack.sh が決めているため
// (署名を有効にしていると、profile 抜きの down は wacz-signer を残す)。
const stacks = [
  {
    label: "capture-ledger",
    cwd: ROOT,
    show: "pnpm run stack:down",
    cmd: ["pnpm", "run", "stack:down"],
  },
  {
    label: "capture-scheduler",
    cwd: SCHEDULER,
    show: "container-compose down",
    cmd: ["container-compose", "down"],
  },
];

for (const stack of stacks) {
  if (!existsSync(stack.cwd)) {
    console.log(`・ ${stack.label} は ${stack.cwd} に無い (飛ばす)`);
    continue;
  }
  // 出力を上から読めば手順書になるよう、**打つときと同じ形** で出す
  // (この repo なら cd は要らない)。
  console.log(`\n$ ${stack.cwd === ROOT ? "" : `cd ../capture-scheduler && `}${stack.show}`);
  const [cmd, ...args] = stack.cmd;
  const result = spawnSync(cmd, args, { cwd: stack.cwd, stdio: "inherit" });
  if (result.status !== 0) {
    refused += 1;
    console.log(`✗ ${stack.label} のコンテナを落とせなかった`);
  }
}

console.log(
  "\n共有 store (seaweedfs.crawler-storage) は落としていない —— crawler で 1 つしかなく、" +
    "他の repo も使っている。",
);

if (refused > 0) {
  console.log(`\n${String(refused)} 件は落ちていない (上を見ること)。`);
  process.exit(1);
}
