/**
 * コードから「事実」を取り出す唯一の入口。
 *
 * ドキュメントに書かれた事実のうち、ledger のソースやピン留め設定を写しただけの
 * ものは、ここを経由して実物から読む。手書きでコピーするとコード側の変更に
 * 追随せず、しかも間違いに誰も気付かない。
 *
 * BrowserHive 側の事実は対象外。あちらの docs へリンクする（DRY）。
 *
 * browserhive の同名ファイルは ts-morph で `@glossary` も抽出するが、ledger には
 * 用語集にすべき語彙がないので `#region` とピン検査だけを持つ。依存はゼロ。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ledger ルート。docs-site は ledger 直下にあり、astro dev/build は docs-site を
// cwd に実行されるので、その親がリポジトリルート。
// ※ import.meta.url は astro ビルド後の dist パスになるため使えない。
const ROOT = resolve(process.cwd(), "..");

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/**
 * `// #region <name>` … `// #endregion` で囲まれた実ソース片を返す。
 *
 * region 名は行末までで区切る。`\b` では不十分で、`s` と `-` の間には単語境界が
 * あるため、`archives-columns` を要求すると `#region archives-columns-v2` にも
 * マッチして黙って別の断片を配信してしまう。この仕組みが防ぐはずの乖離そのもの。
 *
 * region が見つからなければ throw するが、**それでビルドが落ちるとは限らない**。
 * 拡張子次第で、実測（Starlight 0.41.4 / Astro 7.1.3）した結果はこう:
 *
 *   .mdx — @astrojs/mdx の vite プラグイン経由で throw が表面化し exit 1。
 *          下の browserhivePin() は .mdx から呼ばれているので、こちらは本当に
 *          ビルドが落ちる。
 *   .md  — Starlight の docs loader が捕まえて
 *          `[ERROR] [starlight-docs-loader] Error rendering …` と記録するだけで
 *          exit 0 になる。
 *
 * region を参照しているページ（databases とその下のページ、各 ja）は全部
 * .md なので、region に関してはビルドはガードにならない。非ゼロで落ちるのは
 * src/tools/check-doc-refs.ts の方で、CI が site:check を走らせるのはこのため。
 */
export function sourceRegion(file: string, region: string): string {
  const re = new RegExp(
    String.raw`//\s*#region\s+${region}[ \t]*\r?$([\s\S]*?)//\s*#endregion`,
    "m",
  );
  const m = re.exec(read(file));
  if (!m) throw new Error(`region '${region}' not found in ${file}`);
  return m[1].replace(/^\n/, "").replace(/\s+$/, "");
}

/**
 * The BrowserHive version the `.upstream/browserhive` submodule points at.
 *
 * There used to be four copies of this string — the proto:sync path, setup.sh,
 * and both compose files — and a check here that they agreed, because a bump
 * had to edit all four by hand. The submodule replaced all of them, so there is
 * nothing left to disagree: this reads the one pointer and reports it.
 *
 * `git describe --tags` gives the tag name when the submodule sits exactly on a
 * tag (`v1.6.0`) and a descriptor when it does not (`v1.6.0-3-gabc1234`) — so
 * the docs show, accurately, that the pin has drifted off a release. An
 * uninitialised submodule throws, which fails the build.
 *
 * The leading `v` is dropped. What `describe` hands back is a tag NAME, and the
 * page asks which VERSION is pinned — Semantic Versioning is explicit that
 * `v1.6.0` is the former and `1.6.0` the latter. Stripping one character keeps
 * the two apart, and keeps this page reading the same either side of the day
 * BrowserHive started prefixing its tags.
 */
export function browserhivePin(): string {
  try {
    const described = execFileSync("git", ["-C", ".upstream/browserhive", "describe", "--tags"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    // Anchored, so only a prefix goes — a drift descriptor keeps its own text.
    return described.replace(/^v/, "");
  } catch (cause) {
    throw new Error(
      "cannot read the BrowserHive pin from .upstream/browserhive — " +
        "run `git submodule update --init --recursive`",
      { cause },
    );
  }
}
