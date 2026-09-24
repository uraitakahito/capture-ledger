#!/usr/bin/env node
/**
 * 開発で 1 本撮れるところまでを、順に起こす。
 *
 *   pnpm run dev:up                # 14 段ぜんぶ
 *   pnpm run dev:up --dry-run      # 何を打つかだけ出す。**何も起こさない**
 *   pnpm run dev:up --from api     # 途中から (失敗したときの続き)
 *   pnpm run dev:up --scheduler ../elsewhere   # capture-scheduler が横に無いとき
 *   pnpm run dev:up --dashboard ../elsewhere   # dashboard が横に無いとき
 *   pnpm run dev:up --validator ../elsewhere   # wacz-validator が横に無いとき
 *
 * ## 束ねるが、隠さない
 *
 * この形は一度消している。capture-ledger の setup.sh は 2026-09-19 に消した ——
 * 「中身が束で、**名前が中身より大きい**。読んだ人は無い仕事を想像する」。
 * 同じ失敗をしないための条件を、この script の要件にしてある:
 *
 *   1. **打つコマンドを 1 行ずつ印字してから走らせる。** 出力を上から読めば、
 *      手で同じことをする手順書になっている
 *   2. **各段は単独でも打てるまま。** ここに在るのは既存の script の呼び出しだけで、
 *      新しい実装はひとつも無い
 *   3. `--dry-run` が、走らせずに一覧を出す
 *   4. 転んだら「どこで」「ログはどこ」「どう再開するか」の 3 つを出す
 *
 * 司令塔のいちばんの危険は、途中で転んだときに手作業より厄介になること。だから
 * **失敗の報告に、次に打つ 1 行を必ず添える**。
 *
 * ## 相手の repo には書かない
 *
 * capture-scheduler の段は、**向こうのコマンドを向こうで走らせる** だけ。ファイルを
 * 書きに行く段はひとつも無い (4 行の引き渡しは、向こうが自分の中に置き、こちらの
 * `pnpm run connect` が読む)。
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { HOST_PROCESSES, inspect, stop } from "./daemons.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const argv = process.argv.slice(2);
/** 旗の値を 1 つ取る。commander を使わないのは、この script が build を要らないため。 */
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

/** 隣の repo。**読むだけ・向こうのコマンドを打つだけ** で、書きには行かない。 */
const SCHEDULER = resolve(ROOT, flag("--scheduler") ?? "../capture-scheduler");
/** capture-scheduler の `.env.example` の既定と同じ。あちらで変えているなら、そちらが正。 */
const WINDMILL = "http://127.0.0.1:8000";
const LOGS = resolve(ROOT, ".dev/logs");

const whoami = (spawnSync("whoami", { encoding: "utf8" }).stdout ?? "").trim() || "you";

/**
 * 隣の repo で走るもの。**読むだけ・向こうのコマンドを打つだけ** で、書きには行かない。
 * 場所を渡せるようにしてあるのは、横に並べていない clone のためと、
 * 「無いときに名指しで止まる」を確かめられるようにするため。
 *
 * **並びではなく名前で引く。** 分割代入だと `HOST_PROCESSES` に 1 本足した日に
 * 黙ってずれる —— 実際、validator を足した瞬間に dashboard の段が validator の
 * コマンドを打ち始めた (--dry-run で気づいた)。
 */
const spec = (name) => {
  const found = HOST_PROCESSES.find((one) => one.name === name);
  if (found === undefined) throw new Error(`unknown host process: ${name}`);
  return found;
};
const issuer = spec("issuer");
const api = spec("api");
const validator = {
  ...spec("validator"),
  root: resolve(ROOT, flag("--validator") ?? "../wacz-validator"),
};
const dashboard = {
  ...spec("dashboard"),
  root: resolve(ROOT, flag("--dashboard") ?? "../dashboard"),
};

/**
 * 14 段。**この表がそのまま手順書。**
 *
 * `cwd` が SCHEDULER の段は、向こうの repo で向こうのコマンドを打つ。`waitFor` は
 * 「前の段のコンテナが港を開けるまで」を待つ —— `stack:up` はコンテナを作るところまでで、
 * postgres が接続を受けるところまでは待たない。
 */
const STEPS = [
  {
    id: "store",
    run: "sh .upstream/seaweedfs/scripts/stack.sh up",
    // **共有 store は、動いているなら触らない。** crawler で 1 つしかなく、他の repo も
    // 使っている —— `up` は動いているコンテナも作り直すので、隣の作業を落としうる。
    skipIf: { label: "seaweedfs", port: 8333 },
  },
  { id: "stack", run: "pnpm run stack:up" },
  {
    id: "db",
    run: "pnpm run db:migrate && pnpm run db:seed",
    waitFor: { label: "postgres", port: 5432 },
  },
  { id: "catalog", run: "pnpm run scripts import .upstream/capture-scripts" },
  {
    id: "fga",
    run: "pnpm run fga:migrate && pnpm run fga:deploy",
    waitFor: { label: "openfga", port: 8090 },
  },
  {
    id: "windmill",
    run: "container-compose up -d",
    cwd: SCHEDULER,
    // **答えているなら作り直さない。** `up -d` は動いているコンテナも止めて作り直し、
    // windmill が windmill-db を追い抜いて死ぬ (実測: 2 度目の dev:up で windmill と
    // windmill-worker だけが消え、8000 が 5 分待っても答えなかった)。
    skipIf: { label: "windmill", url: `${WINDMILL}/api/version` },
  },
  {
    id: "bootstrap",
    run: "pnpm run windmill:bootstrap",
    cwd: SCHEDULER,
    // **冷えた Windmill は 60 秒では足りない。** `container-compose up -d` は既に
    // 動いているコンテナも作り直すので、2 度目の dev:up でも毎回冷える (実測)。
    // bootstrap 自身の待ちは 60 秒で切れるため、ここで先に待つ。
    waitFor: { label: "windmill", url: `${WINDMILL}/api/version`, timeoutMs: 300_000 },
  },
  { id: "connect", run: `pnpm run connect ${relative(ROOT, SCHEDULER)}` },
  { id: "flow", run: "pnpm run windmill:push", cwd: SCHEDULER },
  { id: "issuer", daemon: issuer, ready: "http://127.0.0.1:9099/.well-known/openid-configuration" },
  { id: "api", daemon: api, ready: "http://127.0.0.1:7070/healthz" },
  // flow が名乗る名前 (capture-scheduler の CAPTURE_LEDGER_SUBJECT。既定は windmill) と、
  // picker を開く人。**両方に要る** —— 前者が無いとクロールが 401、後者が無いと画面が空。
  {
    id: "grant",
    run: `pnpm run fga:grant submitter windmill acme && pnpm run fga:grant submitter ${whoami} acme`,
  },
  { id: "token", run: "pnpm run windmill:capture-ledger-token", cwd: SCHEDULER },
  { id: "doctor", run: "pnpm run doctor", cwd: SCHEDULER },
  // **検証の daemon は画面より前。** 先に画面が立つと、「検証」を押した人が
  // daemon の不在を踏む。
  {
    id: "validator",
    daemon: validator,
    ready: `http://127.0.0.1:${String(validator.port)}/healthz`,
  },
  // **画面は最後。** API が答えるより先に開いても、何も見えない。
  {
    id: "dashboard",
    daemon: dashboard,
    ready: `http://127.0.0.1:${String(dashboard.port)}/healthz`,
  },
];

// ── 旗 ──────────────────────────────────────────────────────────────
const dryRun = argv.includes("--dry-run");
const from = flag("--from");
if (argv.includes("--from") && STEPS.every((step) => step.id !== from)) {
  process.stderr.write(
    `--from に渡せるのは段の名前です: ${STEPS.map((s) => s.id).join(" ")}\n` +
      `  受け取ったのは: ${from ?? "(無し)"}\n`,
  );
  process.exit(1);
}
const startAt = from === undefined ? 0 : STEPS.findIndex((step) => step.id === from);

/** 打つときと同じ形で出す。**別の repo で走るものは `cd` から書く。** */
const shown = (step) => {
  const where = step.cwd ?? step.daemon?.root;
  const cd = where === undefined || where === ROOT ? "" : `cd ${relative(ROOT, where)} && `;
  return step.daemon === undefined
    ? `${cd}${step.run}`
    : `${cd}${step.daemon.run}   （背景・.dev/logs/${step.id}.log）`;
};

if (dryRun) {
  process.stdout.write(`${String(STEPS.length)} 段。何も起こしません。\n\n`);
  for (const [index, step] of STEPS.entries()) {
    process.stdout.write(
      `[${String(index + 1).padStart(2)}/${String(STEPS.length)}] ${step.id}\n        $ ${shown(step)}\n`,
    );
  }
  process.exit(0);
}

// ── 道具 ────────────────────────────────────────────────────────────
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * 1 回だけ訊く。**loopback にしか訊かない** —— コンテナの名前は node から届かない
 * (macOS 26 は Apple 署名でないバイナリをコンテナの subnet へ通さない)。
 */
const probe = async ({ port, url }) => {
  if (url !== undefined) {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  }
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      done(true);
    });
    const fail = () => {
      socket.destroy();
      done(false);
    };
    socket.on("error", fail);
    socket.on("timeout", fail);
  });
};

/** 答えるまで待つ。**時間切れも答え** なので、投げずに false を返す。 */
const waitFor = async (target, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probe(target)) return true;
    await sleep(500);
  } while (Date.now() < deadline);
  return false;
};

const runShell = (step) =>
  new Promise((done) => {
    const child = spawn("/bin/sh", ["-c", step.run], {
      cwd: step.cwd ?? ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => done(code ?? 1));
  });

/**
 * 背景のプロセスを起こす。
 *
 * **既に動いているなら、自分のものでも起こし直す。** 設定を読むのは起動のとき 1 度
 * だけなので、`connect` や `fga:deploy` の後に古いプロセスが残っていると、
 * 「値は入っているのに効かない」になる。
 */
const startDaemon = async (step) => {
  mkdirSync(LOGS, { recursive: true });
  const logPath = resolve(LOGS, `${step.id}.log`);

  for (const proc of inspect(step.daemon)) {
    if (!proc.ours) {
      process.stdout.write(
        `        :${String(step.daemon.port)} は別のものが握っています (pid ${String(proc.pid)})\n` +
          `        ${proc.command}\n`,
      );
      return 1;
    }
    process.stdout.write(`        既に動いていたので起こし直します (pid ${String(proc.pid)})\n`);
    await stop(proc.pid);
  }

  const log = createWriteStream(logPath, { flags: "a" });
  await new Promise((done) => log.on("open", done));
  // **その daemon の根で起こす。** dashboard は隣の repo に在るので、この repo の
  // 根で起こすと `Missing script` になる。
  const child = spawn("/bin/sh", ["-c", step.daemon.run], {
    cwd: step.daemon.root,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();

  if (await waitFor({ url: step.ready }, 60_000)) {
    const found = inspect(step.daemon).find((proc) => proc.ours);
    process.stdout.write(
      `        pid ${String(found?.pid ?? child.pid)}  :${String(step.daemon.port)}\n`,
    );
    return 0;
  }
  process.stdout.write(`        ${step.ready} が答えないまま時間切れ\n`);
  const tail = existsSync(logPath)
    ? readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-5)
    : [];
  for (const line of tail) process.stdout.write(`        | ${line}\n`);
  return 1;
};

// ── 走らせる ────────────────────────────────────────────────────────
for (const [index, step] of STEPS.entries()) {
  const counter = `[${String(index + 1).padStart(2)}/${String(STEPS.length)}]`;
  if (index < startAt) {
    process.stdout.write(`${counter} ${step.id}   （--from ${from} なので飛ばす）\n`);
    continue;
  }
  process.stdout.write(`\n${counter} ${step.id}\n$ ${shown(step)}\n`);

  const started = Date.now();
  // 相手の repo が無い形で走らせると、spawn は ENOENT を投げる。**走らせてから
  // 気づかない** よう、名指しで止まる。daemon も同じ (根が隣の repo のことがある)。
  const needs = step.cwd ?? step.daemon?.root;
  if (needs !== undefined && !existsSync(needs)) {
    process.stdout.write(`✗ ${needs} がありません (crawler の repo を横に clone すること)\n`);
    process.stdout.write(`\n直したら: pnpm run dev:up --from ${step.id}\n`);
    process.exit(1);
  }
  if (step.skipIf !== undefined && (await probe(step.skipIf))) {
    process.stdout.write(`✓ ${step.skipIf.label} は既に答えている (作り直さない)\n`);
    continue;
  }
  if (step.waitFor !== undefined) {
    const { label, port, url, timeoutMs } = step.waitFor;
    const where = url ?? `127.0.0.1:${String(port)}`;
    process.stdout.write(`⏳ ${label} (${where}) が答えるのを待っています\n`);
    if (!(await waitFor(step.waitFor, timeoutMs ?? 90_000))) {
      process.stdout.write(`✗ ${label} (${where}) が答えないまま時間切れ\n`);
      process.stdout.write(`\n直したら: pnpm run dev:up --from ${step.id}\n`);
      process.exit(1);
    }
  }

  const code = step.daemon === undefined ? await runShell(step) : await startDaemon(step);
  if (code !== 0) {
    process.stdout.write(`✗ ${step.id} で止まりました (${seconds(Date.now() - started)})\n`);
    if (step.daemon !== undefined) {
      process.stdout.write(`  ログ: .dev/logs/${step.id}.log\n`);
    }
    process.stdout.write(`\n直したら: pnpm run dev:up --from ${step.id}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${seconds(Date.now() - started)}\n`);
}

process.stdout.write(
  `\n全段おわり。画面: http://127.0.0.1:${String(dashboard.port)}/\n` +
    "\n撮ってみるなら:\n" +
    "  cd ../capture-scheduler && pnpm run smoke\n" +
    "\nいま何が立っているか: pnpm run dev:status   ／   片付け: pnpm run dev:down\n" +
    "\n名乗る名前を変えているなら (capture-scheduler の CAPTURE_LEDGER_SUBJECT)、\n" +
    "その名前にも許可が要ります —— doctor の can_submit が名指しします。\n",
);
