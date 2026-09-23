/**
 * ホストで動く長生きのプロセス (issuer 9099 / api 7070) を見つけて、止める。
 *
 * ## なぜ pidfile ではなく port から探すのか
 *
 * 止めたい相手は、たいてい **手で起こしたもの** —— 別のターミナルで
 * `pnpm run api` と打って、そのまま忘れたもの。pidfile を置く道具だけが
 * 書き込む台帳では、そういう置き忘れが 1 件も載らない。2026-09-20 に
 * `EADDRINUSE 127.0.0.1:9099` で止まったのも、まさにそれだった。
 *
 * 港は嘘をつかない。`lsof` で「いま 9099 を持っているのは誰か」を訊けば、
 * 誰が起こしたものでも見つかる。
 *
 * ## 誰のものかは、名乗りで決める
 *
 * **port から引いた PID を、そのまま kill してはいけない。** 番号は使い回されるし、
 * 先客かもしれない。止める前に 2 つを見る:
 *
 *   1. コマンド行が、その entry を動かしているか (`dist/api/server.js`)
 *   2. **プロセスの cwd が、この repo の根と同じか**
 *
 * コマンド行だけでは足りない。pnpm から起こすと **引数は相対パス** になるので
 * (`node … dist/api/server.js`)、別の clone の API と区別が付かない。cwd を足すと
 * 区別が付く —— pnpm は必ず package.json の在る場所で起こすため。
 *
 * これは pidfile より強い証拠になる。pidfile は「そう書いた」という記録でしかなく、
 * PID が回ってきた別人を指していても見た目は同じだが、この 2 つは **いま動いている
 * ものそのもの** から読む。
 *
 * 自分のものでなければ **止めずに名指しする**。何が港を握っているかが分かれば、
 * 決めるのは打った人でよい。
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 画面は隣の repo で走る。**cwd が違うので、根も 1 本ごとに持たせる。** */
const DASHBOARD = fileURLToPath(new URL("../../dashboard/", import.meta.url));
/** WACZ を検証する daemon も隣の repo。 */
const VALIDATOR = fileURLToPath(new URL("../../wacz-validator/", import.meta.url));

/**
 * 2 つの path が同じディレクトリを指すか。
 *
 * **末尾の `/` の有無で比べない。** `fileURLToPath(new URL("..", …))` は `/` 付きを
 * 返し、`resolve()` は付けない —— 文字列のまま比べると、同じ場所なのに一致しない。
 * dev:up が `--dashboard` の既定を `resolve()` で作った日に、動いている画面が
 * **「別のものが握っている」**と報告された (実測)。`resolve` で両側を揃える。
 */
const sameDir = (a, b) => a !== undefined && resolve(a) === resolve(b);

/**
 * ホストに残るもの。**compose では消えない** —— どれもコンテナではないので、
 * `container-compose down` は 1 つも止めない。
 *
 * `root` を 1 本ごとに持つのは、dashboard が **隣の repo** で走るから。持ち主の判定に
 * 使う cwd はこの repo の根と一致しないので、`ROOT` 固定にすると「自分のものではない」
 * と言い続けることになる (実装中に実際にそうなった)。
 */
export const HOST_PROCESSES = [
  {
    name: "issuer",
    port: 9099,
    root: ROOT,
    entry: "dist/dev/issuer-cli.js",
    run: "pnpm run oidc:issuer",
  },
  { name: "api", port: 7070, root: ROOT, entry: "dist/api/server.js", run: "pnpm run api" },
  {
    name: "validator",
    port: 7180,
    root: VALIDATOR,
    entry: "packages/daemon/dist/cli.js",
    // **鍵を渡さない。** 読むのは台帳が署名した URL だけなので、`AWS_*` は要らない ——
    // 渡した瞬間に「鍵を持つ相手を増やさない」という、この経路を選んだ理由が消える。
    // build を挟むのは、clone した直後でも 1 本で立つようにするため (数秒)。
    // `daemon...`（末尾の 3 点）で依存（contract・core・protocol）ごと建てる。daemon だけを
    // 建てると、core を変えたあとに古い core/dist の上で新しい daemon が黙って立つ（実際に
    // そうなっていた。気づかなかったのは、毎回 pnpm run check を先に打っていたから）。
    run: "pnpm --filter @wacz-validator/daemon... build && node packages/daemon/dist/cli.js --port 7180",
  },
  {
    name: "dashboard",
    port: 7080,
    root: DASHBOARD,
    entry: "src/server.mjs",
    run: "pnpm run dev",
    // **7000 ではない。** macOS の ControlCenter (AirPlay Receiver) が `*:7000` を
    // 握っているので、port から持ち主を引くこの道具は毎回「別のものが握っている」と
    // 言うことになる (実測)。dashboard 側も 7080 を既定にしてある。
  },
];

const capture = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "") : "";
};

/** その port を LISTEN している PID。`lsof` が無ければ空。 */
export const listeners = (port) =>
  capture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid));

/**
 * 起動時刻・コマンド行・cwd。居なければ undefined。
 *
 * **`lstart` と `command` を 1 回の `ps` で取らない。** `lstart` の綴りは locale で
 * 変わるので (`Sat Sep 20 …` / `月  9/21 …`)、語数を決め打ちして切ると、
 * **コマンド行の先頭を時刻として食う**。実際に食った。時刻は表示するだけなので、
 * 割らずにそのまま持つ。
 */
export const describe = (pid) => {
  const startedAt = capture("ps", ["-p", String(pid), "-o", "lstart="]).trim();
  if (startedAt === "") return undefined;
  const command = capture("ps", ["-p", String(pid), "-o", "command="]).trim();
  // `lsof -Fn` は 1 行 1 フィールドで、`n` で始まる行が path。
  const cwd = capture("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return { pid, startedAt, command, cwd };
};

/**
 * いま port を握っているものを、`HOST_PROCESSES` の 1 つについて調べる。
 *
 * 複数返りうる (別の clone が同じ port を取れることは無いが、lsof は
 * 同じプロセスの複数の socket を返しうる)。PID で畳む。
 */
export const inspect = (spec) => {
  const seen = new Map();
  for (const pid of listeners(spec.port)) {
    if (seen.has(pid)) continue;
    const info = describe(pid);
    if (info === undefined) continue;
    const here = sameDir(info.cwd, spec.root);
    seen.set(pid, { ...info, ours: here && info.command.includes(spec.entry) });
  }
  return [...seen.values()];
};

/**
 * SIGTERM を送り、消えるまで待つ。
 *
 * `api` は SIGTERM で outbox のタイマーを止め、接続を閉じてから終わる
 * (`src/api/server.ts` の shutdown)。待たずに次へ進むと、港が空く前に
 * 「止めた」と言うことになる。
 *
 * @returns "stopped" | "gone" | "running"
 */
export const stop = async (pid, { timeoutMs = 10_000, stepMs = 100 } = {}) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return "gone";
  }
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    if (describe(pid) === undefined) return "stopped";
    await sleep(stepMs);
  }
  return "running";
};

/**
 * 動いているコンテナを、DNS ドメインごとに数える。
 *
 * `container ls` が使えない (入っていない・落ちている) ときは undefined。
 * **数えられないことと 0 件は別** なので、混ぜない。
 */
export const containersByDomain = () => {
  const out = capture("container", ["ls", "--format", "json"]);
  if (out.trim() === "") return undefined;
  let rows;
  try {
    rows = JSON.parse(out);
  } catch {
    return undefined;
  }
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const domain = row?.configuration?.dns?.domain;
    if (typeof domain !== "string" || domain === "") continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return counts;
};
