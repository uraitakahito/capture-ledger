/**
 * ホストで動く長生きのプロセス (issuer 9099 / api 7070 / validator 7180 / dashboard 7080) を
 * 見つけて、止める。validator には、動いている build も訊く。
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
    // **動いている build が名乗る口。** daemon は自分で建て直らない —— wacz-validator を
    // 出しても、:7180 は起こした時の build のまま動き続ける (2026-09-26 に見たとき、
    // v0.28.1 が 2 日動いていて、その間に出た v0.29.0・v0.30.0 の rule はどれも画面に
    // 出ていなかった)。dev:status は、ここで訊いた `gitSha` を根の checkout と比べる。
    identity: "/healthz",
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
 * 動いている build が名乗る版と commit。`identity` を持つものだけ訊ける。
 * 答えない・形が違うときは undefined —— **訊けないことを、名乗らないことと混ぜない**
 * (呼ぶ側は「訊けない」と書く)。
 */
export const runningBuild = async (spec) => {
  if (spec.identity === undefined) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${String(spec.port)}${spec.identity}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    const { version, gitSha } = await response.json();
    return typeof version === "string" && typeof gitSha === "string"
      ? { version, gitSha }
      : undefined;
  } catch {
    return undefined;
  }
};

/** 根の HEAD (40 桁) と、未コミットの変更の有無。git が答えなければ undefined。 */
export const checkoutOf = (root) => {
  const head = capture("git", ["-C", root, "rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) return undefined;
  const dirty = capture("git", ["-C", root, "status", "--porcelain"]).trim() !== "";
  return { head, dirty };
};

/**
 * 動いている build を、根の checkout と比べる。
 *
 * **比べるのは commit だけ。** 未コミットの変更は中身を比べられないので、どちらかに
 * 在れば `unsure` と言う —— 同じと言えば嘘になりうるし、違うと言っても嘘になりうる。
 * `-dirty` は wacz-validator の scripts/gen-build-info.mjs が `git status --porcelain`
 * から付ける印で、こちらの `dirty` も同じものを見る。
 *
 * 短い SHA は **前方一致** で比べる。短くする桁数は repo の大きさで伸びるので、
 * build した日と今日とで長さが違いうる。
 *
 * @returns "same" | "differs" | "unsure"
 */
export const compareBuild = (running, checkout) => {
  const dirty = running.gitSha.endsWith("-dirty");
  const sha = dirty ? running.gitSha.slice(0, -"-dirty".length) : running.gitSha;
  // "nogit" (git の無い所で建てた) や空は比べようがない。空のまま前方一致を
  // 取ると、どの HEAD にも一致してしまう。
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return "unsure";
  if (!checkout.head.startsWith(sha)) return "differs";
  return dirty || checkout.dirty ? "unsure" : "same";
};

/**
 * `sha` が根の HEAD の祖先か —— つまり、動いている build より checkout が先に進んだか。
 *
 * 違うときに「古い」と言ってよいのはこの場合だけ。checkout を古いタグへ戻したときや、
 * 別の branch にいるときは、動いている build のほうが新しいか、どちらでもない。
 * git が知らない commit (消えた branch で建てた) も「祖先ではない」に落とす。
 */
export const behindHead = (root, sha) =>
  spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", sha, "HEAD"]).status === 0;

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
