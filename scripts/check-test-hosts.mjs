/**
 * 試験の場所に example 名が書かれていないかを見張る。試験の名前は .test に揃えた
 * （RFC 2606 が試験のために取っておいた名前。site.test・other-site.test・a.test など）。
 *
 * ## なぜ要るのか
 *
 * example 名（example.com・.org・.net とその下、*.example）は文書のための名前で、網によって
 * 答えが変わる。2026-10 に、この LAN のルータ（Aterm）が example.com に 127.0.0.1 を返し、
 * browserhive の単体試験が手元でだけ赤になった。名前を引く試験は締め出し（test/no-dns.ts）が
 * 捕まえるが、名前を書くこと自体は捕まえない。書き手は長く example.com を書いてきたので、
 * 見張らなければ戻ってくる。
 *
 * ## 何を見るか
 *
 * git が追跡する text のファイルのうち、SCOPES に挙げた場所（試験と、試験が読む物）。
 * 名前の形は 4 つ: example.com など・その SURT（com,example）・*.example・その SURT（example,a）。
 * 正規表現の中の \. も同じ名前として見る。
 *
 * ## 見ないもの
 *
 * docs・src のコメント・UI の placeholder。example は文書のための名前で、そこが本来の使い道。
 * .env.example（名前ではなくファイル名）と、zip や画像のような text でないファイル。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** この repo の試験の場所。repo ごとに違うのはここだけ。 */
const SCOPES = ["test", "scripts/targets-smoke.mjs", "scripts/scripts-smoke.mjs"];

const FIND = [
  // example.com・.org・.net とその下（www.example.com・someone@example.com・example\.com）
  /(?<![A-Za-z0-9-])example\\{0,2}\.(?:com|org|net)(?![A-Za-z0-9-])/i,
  // その SURT（com,example,www)/）
  /(?<![A-Za-z0-9-])(?:com|org|net),example(?![A-Za-z0-9-])/i,
  // *.example（a.example・*://*.example/*）。.env.example は除く
  /(?:^|[^A-Za-z0-9.-])(?!env\\{0,2}\.example)(?:[A-Za-z0-9-]+|\*)(?:\\{0,2}\.[A-Za-z0-9-]+)*\\{0,2}\.example(?![A-Za-z0-9.-])/i,
  // その SURT（example,a)/）
  /(?<![A-Za-z0-9-])example,[A-Za-z0-9-]+[),]/i,
];

const files = execFileSync("git", ["ls-files", "--", ...SCOPES], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
let found = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (text.includes("\u0000")) continue;
  text.split("\n").forEach((line, index) => {
    if (FIND.some((re) => re.test(line))) {
      found++;
      console.error(
        `${file}:${index + 1}: example 名が残っています（.test の名前へ。site.test など）: ${line.trim()}`,
      );
    }
  });
}
if (found > 0) process.exit(1);
console.log(`試験の場所に example 名はありません（${files.length} ファイル）`);
