/**
 * docs-site/ の Starlight のドキュメントが嘘をつかないことを確かめる。
 *
 * `astro build` が自力で捕まえるずれは 1 種類だけ: .upstream/browserhive の
 * submodule を初期化していないと、描画中に docs-site/src/lib/extract.ts から
 * throw する。固定した版を読んでいるのが .mdx のページなので、こちらはビルドが
 * 落ちる。残りはこのスクリプトの仕事:
 *
 *   1. 訳の欠落 —— 日本語版の無い英語ページ、あるいは英語の原文が無い日本語
 *      ページ。Starlight はページが無いと黙って英語に落とすので、半分だけ訳した
 *      サイトも緑でビルドでき、読み手が違う言語に着地するまで誰も気づかない。
 *   2. 壊れた `#region` の抜粋。ビルドが覆っていると思ってはいけない: region が
 *      無いと "Failed to parse Markdown file" とログに出るのに、`astro build` は
 *      全ページをビルドしたと報告して 0 で終わる (キャッシュを消してから 2 度実測)。
 *      ビルドに任せると、ドキュメントは空のコードフェンスのまま出てしまう。上の
 *      固定版と違う理由は拡張子 —— .mdx からの throw は vite を通って表に出るが、
 *      .md からのものは Starlight の docs loader が捕まえる —— で、ここで
 *      `#region` を参照しているページはどれも .md。
 *   3. 死んだソースのパス —— コードスパンに書かれた `src/….ts` のうち、その後
 *      名前が変わったか消えたもの。
 *   4. 古い画面の絵 —— docs-site/src/assets/picker/ の PNG は `scripts/docs-shots.mjs` の
 *      生成物で、撮ったときの画面のソース (`src/api/picker.ts`) の sha256 を
 *      shots-manifest.json に控えてある。**いまのソースと控えが違えば落とす** ——
 *      「画面を変えたら撮り直せ」を機械で言う。絵は画面の書き写しで、書き写しは
 *      直した日から腐る。あわせて、ページが import する PNG が在ること、どこからも
 *      使われない PNG が無いことも見る (撮ったが使われない絵は腐る)。
 *      capture-scheduler が「compose の pin と manifest の版」でやっているのと同じ考え方。
 *   5. 画面から docs へのリンク —— picker のヘッダの「使い方」(`src/api/picker.ts` の
 *      PICKER_DOCS_URL) が、在るページを指しているか。ページの名前を変えても画面は普通に
 *      開くので、ここで見ないとリンクは黙って 404 になる。
 *
 * 訳について見るのはページの **存在** だけで、構造は一切見ない。両方の言語に同じ
 * 見出しを強いると日本語が悪くなる。ページの歩調を合わせるのは人の仕事で、
 * ページが消えないようにするのがこちらの仕事。
 *
 * `pnpm run site:check` (ビルド + このスクリプト) から走る。問題の一覧を出して 1 で
 * 終わるので、CI が PR を落とす。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = resolve(ROOT, "docs-site/src/content/docs");
const JA = join(DOCS, "ja");

const isPage = (name) => /\.mdx?$/.test(name);

/**
 * ページを再帰的に集め、`dir` からの相対パスで返す (`databases/urls.md` の形)。
 *
 * 子ディレクトリまで降りるのは、そこに置いたページも訳の欠落と `#region` の
 * 検査を受けるべきだから。以前は `isFile()` で止まっていたので、
 * `databases/` 配下の 10 ページがまるごと無検査だった。
 *
 * `ja` は英語ページの隣にある翻訳の入れ物なので、走査から外す。
 */
const pagesIn = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (prefix === "" && entry.name === "ja") return [];
      return pagesIn(join(dir, entry.name), `${prefix}${entry.name}/`);
    }
    return entry.isFile() && isPage(entry.name) ? [`${prefix}${entry.name}`] : [];
  });

const problems = [];

// ─── 1. 英語 ↔ 日本語のページの対応 ────────────────────────────────────────
const en = pagesIn(DOCS);
const ja = new Set(pagesIn(JA));

for (const page of en) {
  if (!ja.has(page)) {
    problems.push(`ja/${page} is missing (English page has no Japanese counterpart)`);
  }
}
for (const page of ja) {
  if (!en.includes(page)) {
    problems.push(`${page} is missing (orphan Japanese page with no English original)`);
  }
}

// ─── 2. コードスパンに書かれたソースのパス ─────────────────────────────────
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });

for (const file of walk(DOCS).filter((f) => isPage(f))) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);

  for (const [, path] of text.matchAll(/`(src\/[A-Za-z0-9_\-/]+\.ts)`/g)) {
    if (!existsSync(resolve(ROOT, path))) {
      problems.push(`${rel}: \`${path}\` does not exist (renamed or moved?)`);
    }
  }

  // ```ts file="src/…#region" —— 差し込まれる抜粋。
  //
  // ビルドに任せずここで見ているのは、`astro build` がこれで落ちないから: region が
  // 無いと "Failed to parse Markdown file" とログに出るのに、ビルドは全ページを
  // ビルドしたと報告して 0 で終わる。ビルドに頼ると、ドキュメントが黙って空の
  // コードフェンスを出すことになる。
  for (const [, path, region] of text.matchAll(/file="([^"#]+)#([^"]+)"/g)) {
    const abs = resolve(ROOT, path);
    if (!existsSync(abs)) {
      problems.push(`${rel}: file="${path}" does not exist`);
      continue;
    }
    const source = readFileSync(abs, "utf8");
    // 名前は行末まで続いていなければならない。extract.ts と同じ規則。`\b` では
    // 足りない: `s` と `-` の間に単語の境界が在るので、`urls-columns` を求めると
    // `#region urls-columns-v2` という印にも当たってしまう —— そして非 0 で終わる
    // のはこの検査だけなので、ここが緩いとずれがそのまま出荷される。
    const re = new RegExp(
      String.raw`//\s*#region\s+${region}[ \t]*\r?$[\s\S]*?//\s*#endregion`,
      "m",
    );
    if (!re.test(source)) {
      problems.push(
        `${rel}: region "${region}" not found in ${path} (renamed, removed, or missing #endregion?)`,
      );
    }
  }
}

// ─── 3. 画面の絵 (picker) ──────────────────────────────────────────────────
const SHOTS_DIR = resolve(ROOT, "docs-site/src/assets/picker");
const manifestPath = join(SHOTS_DIR, "shots-manifest.json");

if (!existsSync(manifestPath)) {
  problems.push(
    "docs-site/src/assets/picker/shots-manifest.json is missing (run `pnpm run docs:shots`)",
  );
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sourceNow = createHash("sha256")
    .update(readFileSync(resolve(ROOT, manifest.source)))
    .digest("hex");
  // sha256 は script が書く。手で直して緑にしないこと —— 絵は古いままになる。
  if (manifest.sourceSha256 !== sourceNow) {
    problems.push(
      `screenshots are stale: ${manifest.source} has changed since they were taken — ` +
        "run `pnpm run docs:shots` and commit the result",
    );
  }

  const onDisk = readdirSync(SHOTS_DIR).filter((name) => name.endsWith(".png"));
  const listed = new Set(manifest.shots);
  // ページが import している PNG。`../../assets/picker/x.png` (英語) と
  // `../../../assets/picker/x.png` (日本語) の両方を拾う。
  const imported = new Map();
  for (const file of walk(DOCS).filter((f) => isPage(f))) {
    const text = readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(/from\s+"(?:\.\.\/)+assets\/picker\/([^"]+\.png)"/g)) {
      imported.set(name, relative(ROOT, file));
    }
  }
  for (const [name, page] of imported) {
    if (!onDisk.includes(name)) {
      problems.push(`${page}: assets/picker/${name} does not exist (run \`pnpm run docs:shots\`)`);
    }
  }
  for (const name of onDisk) {
    if (!listed.has(name)) {
      problems.push(`assets/picker/${name} is not in shots-manifest.json (hand-made image?)`);
    } else if (!imported.has(name)) {
      problems.push(`assets/picker/${name} is not used by any page (unused images rot)`);
    }
  }
  for (const name of listed) {
    if (!onDisk.includes(name)) {
      problems.push(`shots-manifest.json lists ${name} but the file does not exist`);
    }
  }
}

// ─── 4. 画面から docs へのリンク ───────────────────────────────────────────
const PUBLISHED = "https://uraitakahito.github.io/capture-ledger/";
const pickerSource = readFileSync(resolve(ROOT, "src/api/picker.ts"), "utf8");
const docsUrl = /PICKER_DOCS_URL\s*=\s*"([^"]+)"/.exec(pickerSource)?.[1];
if (docsUrl === undefined) {
  problems.push("src/api/picker.ts: PICKER_DOCS_URL not found (renamed? update this check)");
} else if (!docsUrl.startsWith(PUBLISHED) || !docsUrl.endsWith("/")) {
  problems.push(`src/api/picker.ts: PICKER_DOCS_URL (${docsUrl}) is not a page under ${PUBLISHED}`);
} else {
  const slug = docsUrl.slice(PUBLISHED.length, -1);
  if (!["md", "mdx"].some((ext) => existsSync(join(DOCS, `${slug}.${ext}`)))) {
    problems.push(
      `src/api/picker.ts: PICKER_DOCS_URL points at "${slug}", but there is no such docs page`,
    );
  }
}

// ─── 報告 ──────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`✗ doc-ref check failed (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nDocs reference something that no longer matches the repository, or a\n" +
      "page exists in only one language. Fix the doc or restore what it points at.",
  );
  process.exit(1);
}

console.log(
  `✓ doc-ref check passed: ${String(en.length)} pages in English and Japanese, all source paths and screenshots resolve`,
);
