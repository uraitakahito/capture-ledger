/**
 * ソースのコメントが名指しするファイルが、この repo に実在することを見張る。
 *
 * ## なぜ要るのか
 *
 * `check-doc-refs.mjs` は docs-site のページについて同じことを見ているが、**ソースの
 * コメントは誰も見ていない。** そして腐るのはコメントのほうが速い —— ドキュメントは
 * 「読み物」として書き直されるが、コメントは隣のコードを直すときにしか目に入らない。
 *
 * run を crawl に畳んだとき、識別子とエンドポイントはきれいに追随したのに、コメントには
 * 消えたファイルを現在形で指す記述が 17 箇所残った。いちばん悪かったのは `api/server.ts`
 * で、**運用手順として「片付けは api/runs.ts の GET を見ること」と指示していた** ——
 * 読んだ人はそのファイルを探しに行き、無い。
 *
 * ## 何を見るか
 *
 * コメント行の中で、**backtick で囲まれた** 拡張子が .ts / .mts / .mjs / .sql / .yml / .yaml の path。それがこの repo のどこかのファイルと（末尾一致で）
 * 対応するかを見る。run.ts は src/client/run.ts に、api/runs.ts は src/api/runs.ts に当たる。
 *
 * ## 規約 —— backtick は「この repo で開けるもの」の印
 *
 * 除外リストは**持たない**。持たずに済むように、次の 2 つは backtick を外して散文に
 * 畳むことにした:
 *
 *   - **消えたファイルの歴史** 「以前の CLI 経路 (run.ts) が読んでいたのと同じ表で」。
 *     歴史は残すが、開けないものを開けるかのように書かない。
 *   - **他の repo のファイル** 「wacz-validator の packages/core/src/wacz/s3-range-reader.ts」。
 *     CI は 1 つの repo しか checkout しないので、そもそもここからは解決できない。
 *
 * 除外リストを作ると、腐った参照を消す代わりにリストへ足す道ができてしまう。
 *
 * ## 見ないもの
 *
 * **識別子は見ない。** 同じ規則を backtick の識別子に当てると `slowMo` や
 * `exactOptionalPropertyTypes` のような外部 API・TS 設定名がほぼ全部偽陽性になる
 * (実測)。しかも死んだフィクスチャに名前が残っていると「生きている」と判定されて
 * すり抜ける。**path だけが機械で確かめられる。**
 *
 *   node scripts/check-comment-refs.mjs      # `pnpm run check` と CI から走る
 *
 * 見つかれば終了コード 1。効いていることを見たいなら、どこかのコメントに
 * 存在しないファイル名を backtick 付きで書いて走らせ直す —— その行が赤くなる。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 走査するのはこの 3 つ。生成物と依存は入っていない。 */
const ROOTS = ["src", "test", "scripts"];

/**
 * package.json のコメントも見る。JSON にはコメントの構文が無いので、この repo は先頭の `//` という
 * 鍵に、文字列の配列で書いている (npm は `//` を使わないと決めている)。そこで名指ししたファイルも、
 * ソースのコメントと同じ規則で見張る —— 依存や script の理由を書いた行は、相手のファイルが
 * 改名されても誰も開かないので、ソースのコメントより腐りやすい。
 */
const MANIFESTS = ["package.json", "docs-site/package.json"];

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });

/** 実在の一覧は repo 全体から採る (docs や .github のファイルも名指しされうる)。 */
const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.upstream|\.astro|graphify-out)(\/|$)/;
const every = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    if (SKIP.test(relative(ROOT, p))) return [];
    return entry.isDirectory() ? every(p) : [p];
  });

const real = every(ROOT).map((f) => relative(ROOT, f));

/**
 * 参照が実在に当たるか。**末尾一致**で見る —— コメントは api/runs.ts のように
 * 途中から書くことが多く、完全な相対 path を強いると読みにくくなる。
 */
const resolves = (ref) => real.some((f) => f === ref || f.endsWith(`/${ref}`));

const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const REF = /`([A-Za-z0-9_./-]+\.(?:ts|mts|mjs|sql|yml|yaml))`/g;

const problems = [];

for (const root of ROOTS) {
  const dir = resolve(ROOT, root);
  if (!existsSync(dir)) continue;
  for (const file of walk(dir).filter((f) => /\.(ts|mts|mjs)$/.test(f))) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (!COMMENT.test(line)) continue;
      for (const [, ref] of line.matchAll(REF)) {
        if (ref.startsWith(".")) continue;
        if (resolves(ref)) continue;
        problems.push(`${rel}:${String(i + 1)}: \`${ref}\` はこの repo に無い`);
      }
    }
  }
}

for (const rel of MANIFESTS) {
  const notes = JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"))["//"];
  if (!Array.isArray(notes)) continue;
  for (const [i, line] of notes.entries()) {
    for (const [, ref] of String(line).matchAll(REF)) {
      if (ref.startsWith(".")) continue;
      if (resolves(ref)) continue;
      problems.push(`${rel} の "//" の ${String(i + 1)} 行目: \`${ref}\` はこの repo に無い`);
    }
  }
}

// ─── 報告 ──────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`✗ comment-ref check failed (${String(problems.length)} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nコメントが、この repo に無いファイルを名指ししています。改名や削除に追随して\n" +
      "いないか、あるいは他 repo のファイル・消えたファイルの歴史を指しています。\n" +
      "後者なら backtick を外して散文に畳んでください (どの repo のものかを書く)。",
  );
  process.exit(1);
}

console.log(
  `✓ comment-ref check passed: ${String(real.length)} 個のファイルに対して参照はすべて解決`,
);
