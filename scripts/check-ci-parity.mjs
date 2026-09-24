/**
 * CI の本体 job が走らせる検査と、`package.json` の `check` が束ねる検査が、
 * **顔ぶれも並びも一致している**ことを確かめる。
 *
 * ## なぜ要るのか
 *
 * 「commit 前に走らせるもの」の一覧が 2 か所に書かれている —— `check` と workflow。
 * どちらかを直してもう片方を忘れると、片側でしか走らない検査ができる。
 * 2026-09-11 に 2 通りの形で踏んだ:
 *
 *   - `--` の綴りを見る検査が **workflow の inline shell にしか無かった**。
 *     手元では走らせようが無く、CI に指摘されて初めて気づいた
 *   - browserhive で `check` の**並びが CI と違っていた**。`typecheck` が `build` より
 *     先に並んでおり、`dist` が空のまっさらな clone だけが `TS6305` で落ちた ——
 *     CI は build を先に走らせるので緑のまま
 *
 * ## なぜ `pnpm run check` の 1 行に畳まないのか
 *
 * 畳めば一覧は 1 本になるが、**どれが落ちたかが GitHub の UI で分からなくなる**
 * (最初に落ちた 1 つの後ろが全部見えない)。capture-scheduler の ci.yaml がその理由で個別に
 * 並べる形を選んでいる。**並べたままずれを禁じる**のがこの検査器の役目。
 *
 * ## 見るもの
 *
 *   1. 顔ぶれ —— 片方にしか無い検査があれば落ちる
 *   2. 並び   —— 順序が違えば落ちる
 *   3. 素性   —— `pnpm run <script>` でない `run:` step は、下の表に無ければ落ちる
 *
 * ## 例外表は両方向で検める
 *
 * 「書いたのに実在しない例外」も落とす。片方向だけの検査は、**消したものが表に
 * 残っていても通る** —— browserhive の script 参照の検査器で実際に踏んだ形。
 *
 * ## 見ないもの —— 見られないもの
 *
 *   - `uses:` の step。checkout や setup-node は検査ではなく runner の支度で、
 *     `check` に対応するものが無い
 *   - **`check` が足りているかどうか。** どちらにも書かれていない検査は、ここからは
 *     見えない。守れるのは「二度書いたものがずれないこと」だけで、それ以上を名乗らない
 *   - `ONLY_IN_CHECK` に書いた「別 job が持っている」が本当かどうか。job 名は
 *     書き写しているだけ
 *
 *   pnpm run check:ci-parity        # check から自動で走る
 *
 * 見つかれば終了コード 1。効いていることを見たいなら、workflow の step を 2 つ
 * 入れ替えて走らせ直すこと。
 */
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/ci.yaml";
const JOB = "check";

/**
 * `check` に入れられない `run:` step。**名前で引く。**
 *
 * ここに書いたものだけが「script でない step」として許される。書いたのに実在
 * しなければ、それも落とす。
 */
const ONLY_IN_CI = {
  "Install dependencies": "依存の導入。検査ではない",
  "Apply migrations": "postgres の service と DATABASE_URL が要る",
  "Migration round-trip (down then up)": "同上。手元の `check` が DB を要求しないため",
  "Targets CLI against Postgres":
    "同上。撮る対象の CLI を本物の DB に当てる (scripts/targets-smoke.mjs)",
  "Install OpenFGA CLI": "runner にバイナリを置く step。script には畳めない",
};

/** 別の job / workflow が持っている `check` の構成要素。 */
const ONLY_IN_CHECK = {
  audit: "audit.yaml。PR と push に加えて毎日走る (勧告は PR の合間にも公開される)",
  "openapi:diff": "contract-sync job。submodule の認証を全検査に背負わせないため",
  "check:store-name":
    "contract-sync job。検査の実体 (check-store-name.sh) が submodule の中にあり、submodule を取る job がそこだけ",
  "site:check": "site.yaml。submodule とタグの取得が要る",
};

/** `check` が束ねる script を、書かれた順に。 */
const checkMembers = () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const chain = pkg.scripts?.check ?? "";
  return [...chain.matchAll(/pnpm run ([a-z][a-z0-9:._-]*)|pnpm (test)\b/g)].map(
    (m) => m[1] ?? m[2],
  );
};

/**
 * workflow から本体 job の `run:` step を、順番どおりに取り出す。
 *
 * job の境目は「2 空白のキー」。`steps:` 以下だけを見る。YAML の parser は使わない
 * —— この repo 群の検査器は workflow や compose をテキストとして読む
 * (browserhive の stack コマンドの検査器が先例)。依存を増やさないためでもある。
 */
const ciSteps = () => {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l === `  ${JOB}:`);
  if (start < 0) throw new Error(`${WORKFLOW} に job "${JOB}" が無い`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z][a-z0-9-]*:/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const steps = [];
  let name = null;
  for (const line of lines.slice(start, end)) {
    const named = /^\s+- name:\s*(.+?)\s*$/.exec(line);
    if (named) {
      name = named[1];
      continue;
    }
    if (/^\s+- uses:/.test(line)) {
      name = null;
      continue;
    }
    // `- run: cmd` と、`- name:` に続く `run: cmd` の両方。**書き方は repo ごとに違う**
    // —— browserhive は名前を付けず `- run:` だけを並べる。
    const run = /^\s+-?\s*run:\s*(.*)$/.exec(line);
    if (run) steps.push({ name, run: run[1].trim() });
    if (run) name = null;
  }
  return steps;
};

const problems = [];
const steps = ciSteps();

// ① CI の step を、検査 (script) と それ以外 に仕分ける
const ciMembers = [];
const seenExceptions = new Set();
for (const step of steps) {
  const m = /^pnpm run ([a-z][a-z0-9:._-]*)$|^pnpm (test)$/.exec(step.run);
  if (m) {
    ciMembers.push(m[1] ?? m[2]);
    continue;
  }
  // 名前で引き、無ければ実行文字列で引く。名前を付けない repo があるため。
  const key = step.name !== null && step.name in ONLY_IN_CI ? step.name : step.run;
  if (key in ONLY_IN_CI) {
    seenExceptions.add(key);
    continue;
  }
  problems.push(
    `  ${WORKFLOW} の "${step.name ?? "(名前なし)"}" は script ではない: ${step.run.slice(0, 48)}\n` +
      `      script にするか、ONLY_IN_CI に理由つきで書くこと`,
  );
}

// ② 書いたのに実在しない例外 —— 表が腐る穴
for (const name of Object.keys(ONLY_IN_CI)) {
  if (!seenExceptions.has(name)) {
    problems.push(`  ONLY_IN_CI の "${name}" が ${WORKFLOW} に無い（表が腐っている）`);
  }
}

// ③ 別 job が持つと宣言したものが、本当に check に在り、本体 job に無いか
const members = checkMembers();
for (const [script, why] of Object.entries(ONLY_IN_CHECK)) {
  if (!members.includes(script)) {
    problems.push(`  ONLY_IN_CHECK の "${script}" が check に無い（表が腐っている: ${why}）`);
  }
  if (ciMembers.includes(script)) {
    problems.push(`  "${script}" は本体 job にも在る。ONLY_IN_CHECK から外すこと`);
  }
}

// ④ 顔ぶれと並び
const expected = members.filter((s) => !(s in ONLY_IN_CHECK));
if (expected.join(" → ") !== ciMembers.join(" → ")) {
  problems.push(
    `  本体 job と check の一覧が違う\n` +
      `      check : ${expected.join(" → ")}\n` +
      `      CI    : ${ciMembers.join(" → ")}`,
  );
}

if (problems.length > 0) {
  console.error(`${WORKFLOW} の ${JOB} と package.json の check がずれている:\n`);
  for (const p of problems) console.error(p);
  console.error(`\n── ${String(problems.length)} 件。二度書いた一覧は、片方だけ直すと必ずずれる。`);
  process.exit(1);
}

console.log(
  `✓ ci-parity: ${WORKFLOW} の ${JOB} job と package.json の check が一致 ` +
    `(検査 ${String(ciMembers.length)} 本、` +
    `CI のみ ${String(Object.keys(ONLY_IN_CI).length)} 本、別 job ${String(Object.keys(ONLY_IN_CHECK).length)} 本)`,
);
