/**
 * コードが読む環境変数と、`.env.example` が宣言している環境変数が一致している
 * ことを確かめる。
 *
 * **古い雛形は、雛形が無いより悪い。** 在ると「これで全部だ」と信じて使うので、
 * 足りないときに疑う先が残らない。雛形を置く以上、この検査は対で要る。
 *
 * 読み取りは 3 つの仕組みに散っている:
 *
 *   1. `src/config/` の required / optional / need (collectEnv が配るもの)
 *   2. commander の `.env()` —— `--help` にも出るので、ここは意図して残してある
 *   3. 素の `process.env[...]`
 *
 * **読み取り関数の名前が、そのままこの検査の契約になっている。** 1 の名前を
 * 増やしたり変えたりしたら PATTERNS も直すこと。直し忘れると、読まれている変数が
 * 「もう誰も読まない」として大量に報告される。
 *
 * しかも 1 は `env.ts` の外 (`config/identity.ts`) でも使われ、3 は `scripts/`
 * でも使われる。だから「`env.ts` を読めば分かる」は成り立たないし、
 * 手で数えれば取りこぼす。
 *
 * 名前は必ずリテラルで書くこと。組み立てた名前はここに映らないので、黙って
 * 未文書になる。
 *
 * `pnpm run check` と CI の独立したステップの両方から走る。CI の check job は
 * `pnpm run check` を呼ばず個別のステップを並べているので、package.json に
 * 足すだけでは CI に入らない。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// cwd に依存させない。scripts/ から走らせても repo の root から走らせても同じ
// 結果になること。相対パスで書くと、CI と手元で答えが変わりうる。
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_DIRS = ["src", "scripts"];
const TEMPLATE = ".env.example";

// 開き括弧の後の空白を許すこと。prettier は長い呼び出しを改行するので、
// `optional(\n  "NAME",` の形が普通に現れる。空白を許さないとその行を見落とし、
// **検査は緑のまま網から漏れる**。
const PATTERNS = [
  /\b(?:required|optional|need)\(\s*"([A-Z_0-9]+)"/g,
  /\.env\(\s*"([A-Z_0-9]+)"\)/g,
  /process\.env\[\s*"([A-Z_0-9]+)"\s*\]/g,
];

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

/** name -> 最初に見つけたファイル。直す人には「どこで読まれているか」が要る。 */
const used = new Map();
for (const dir of SOURCE_DIRS) {
  for (const file of walk(resolve(ROOT, dir)).filter((f) => /\.(ts|mjs)$/.test(f))) {
    const source = readFileSync(file, "utf8");
    for (const pattern of PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        if (!used.has(match[1])) used.set(match[1], relative(ROOT, file));
      }
    }
  }
}

// **コメント行も「宣言されている」と数える。** 既定値を見せるだけの変数は
// コメントで置いてあるため。`#NAME=` と `NAME=` の両方を受ける。
const templateLines = readFileSync(resolve(ROOT, TEMPLATE), "utf8").split("\n");
const declared = new Set(
  templateLines.flatMap((line) => /^\s*#?\s*([A-Z_0-9]+)=/.exec(line)?.slice(1, 2) ?? []),
);
/** 生の空行 (`NAME=`)。必須の変数以外がこの形だと、写した .env が既定値を失う。 */
const liveEmpty = templateLines.flatMap(
  (line) => /^([A-Z_0-9]+)=\s*$/.exec(line)?.slice(1, 2) ?? [],
);

/** `as const` の配列から名前を取り出す。env.ts と scripts/env.mjs の一覧用。 */
const listFrom = (source, constName) => {
  const block = new RegExp(`${constName}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  return block === null ? [] : [...block[1].matchAll(/"([A-Z_0-9]+)"/g)].map((m) => m[1]);
};

const envTs = readFileSync(resolve(ROOT, "src/config/env.ts"), "utf8");
const required = new Set(listFrom(envTs, "REQUIRED_ENV"));
const optional = new Set(listFrom(envTs, "OPTIONAL_ENV"));
const scriptEnv = new Set(
  listFrom(readFileSync(resolve(ROOT, "scripts/env.mjs"), "utf8"), "SCRIPT_ENV"),
);

const problems = [];
for (const [name, file] of used) {
  if (!declared.has(name)) {
    problems.push(`${TEMPLATE} に無い: ${name}  (${file} が読んでいる)`);
  }
}
// 片側だけ見ると雛形は増える一方になる。残骸が残っていると、読む人は「これも
// 要るのか」と埋めようとして、埋められずに止まる。抜けと同じくらい人を止める。
for (const name of declared) {
  if (!used.has(name)) {
    problems.push(`もう誰も読まない: ${name}  (${TEMPLATE} から消すこと)`);
  }
}

// ─── A. `??` による env の読み取りが残っていないか ─────────────────────────
// `??` は未設定のときしか既定値にしない (POSIX の ${VAR-word} 側)。この repo は
// ${VAR:-word} 側に揃えてあるので、1 か所でも残ると、その変数だけ空文字の意味が
// 違う状態に戻る。
for (const dir of SOURCE_DIRS) {
  for (const file of walk(resolve(ROOT, dir)).filter((f) => /\.(ts|mjs)$/.test(f))) {
    const source = readFileSync(file, "utf8");
    for (const hit of source.matchAll(/process\.env\["([A-Z_0-9]+)"\]\s*\?\?/g)) {
      problems.push(
        `?? で読んでいる: ${hit[1]}  (${relative(ROOT, file)})\n` +
          "    ?? は未設定のときしか既定値にしない。optional() を使うこと。",
      );
    }
  }
}

// ─── B. guardEnv の網が、実際に読まれている変数を覆っているか ──────────────
// 覆えていない変数は「空で設定されている」を検出されないまま素通りする。
for (const [name, file] of used) {
  if (required.has(name) || optional.has(name) || scriptEnv.has(name)) continue;
  problems.push(
    `検査の一覧に無い: ${name}  (${file} が読んでいる)\n` +
      "    src/config/env.ts の REQUIRED_ENV / OPTIONAL_ENV か、\n" +
      "    scripts/env.mjs の SCRIPT_ENV に足すこと。",
  );
}
for (const name of [...required, ...optional, ...scriptEnv]) {
  if (!used.has(name)) {
    problems.push(`一覧にあるが誰も読まない: ${name}  (検査の一覧から消すこと)`);
  }
}

// ─── C. 雛形の生の空行は必須の変数だけか ───────────────────────────────────
// 任意の変数を生の空行にすると、写した .env が空文字をセットし、既定値を失う。
for (const name of liveEmpty) {
  if (!required.has(name)) {
    problems.push(
      `生の空行にできない: ${name}  (${TEMPLATE})\n` +
        "    写すと空文字がセットされ、既定値を潰す。値を書くかコメントにすること。",
    );
  }
}

// ─── D. scripts/env.mjs の optional が env.ts のものと同じ意味か ───────────
// 実装の文字列ではなく **振る舞い** で比べる。実装が変わっても意味が同じなら通る。
{
  const { optional: scriptOptional } = await import(new URL("./env.mjs", import.meta.url).href);
  const probe = "__CHECK_ENV_PROBE__";
  const cases = [
    [undefined, "FALLBACK"],
    ["", "FALLBACK"],
    ["x", "x"],
  ];
  for (const [value, want] of cases) {
    if (value === undefined) delete process.env[probe];
    else process.env[probe] = value;
    const got = scriptOptional(probe, "FALLBACK");
    if (got !== want) {
      problems.push(
        `scripts/env.mjs の optional がずれている: ` +
          `${JSON.stringify(value)} -> ${JSON.stringify(got)} (期待 ${JSON.stringify(want)})\n` +
          "    src/config/env.ts の optional と同じ意味でなければならない。",
      );
    }
  }
  delete process.env[probe];
}

if (problems.length > 0) {
  console.error(`環境変数の一覧が ${TEMPLATE} とずれています:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${TEMPLATE} が .env の唯一の出どころです (.env は cp -n ${TEMPLATE} .env で写して作る)。` +
      "\n新しい変数を足したら、値の例と「なぜ要るか」も一緒に書くこと ——" +
      "\n名前だけでは何を入れるべきか分かりません。",
  );
  process.exit(1);
}

console.log(`✓ env check passed: ${String(used.size)} 個、すべて ${TEMPLATE} にある`);
