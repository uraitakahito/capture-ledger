/**
 * クロールの語を、旧い言い方で書いていないかを見張る。規則は下の RULES の 7 つ。
 *
 * ## なぜ要るのか
 *
 * - **クロールの seed は「起点」と書く。** 2026-10 に「種」から「起点」へそろえた（docs・コメント・
 *   試験の名前・CLI の説明で 78 か所）。「種」は読み手に通じにくく、単独では「しゅ」（種類）とも読める
 * - **クロールは「始める」と書く。** 2026-10 に「起こす」から「始める」へそろえた（fga:grant の答え
 *   「…のクロールを始められます」・docs・コメント・試験の名前で 96 か所）。目的語の無い「起こす」は
 *   「目を覚まさせる」に読める。プロセスの「起こす」（dev:up が起こす・API を起こし直す・webhook で
 *   起こす）は別の意味で、見ない
 * - **ページで走らせる物は「スクリプト」、置き場は「台帳」と書く。** 2026-10 に「目録」「台本」から
 *   そろえた（CLI の答え「台帳に無い」・docs・コメント・試験の名前で 194 か所）。「目録」は browserhive と
 *   wacz-validator では WACZ の中の storage の目録を、「台本」は dashboard では代役の台本を指す。
 *   台帳はどちらも持たないので、両方とも全部見る（dashboard と capture-scheduler も見張っている）
 * - **network は「通信」と書く。** 2026-11 に「網」から「通信」へそろえた（browserhive の docs・
 *   コメント・試験の名前・契約の説明で 100 か所あまり、この repo では注記 7 か所と browserhive の
 *   契約の写し）。「網」は network を 1 字で写した書き手の癖で、読み手に通じにくい。通信そのもの
 *   （通信の記録・通信に載せる）も、通信が止むこと（通信が静まる・通信・CPU・DOM の静止）も「通信」、
 *   基盤のネットワーク（私設ネットワーク・内部ネットワーク）は「ネットワーク」。比喩の「網」
 *   （回帰の網・網から漏れる・粗い網）も言い換えた。「安全網」「網羅」は別の語で、見ない
 * - **クロールの頼みに書く物は「その場の TS」と書く。** 2026-11 に（Jira CAPTURE-83）、「その場の JS」から
 *   そろえた。`scripts[].inline.source` は compile の段で strict の TypeScript として検査されるのに、JS と名乗って
 *   いた。JS になるのは変換の後なので、走った JS・変換後の JS・`jsSha256` はそのまま（dashboard と
 *   capture-scheduler も見張っている）
 * - **スクリプトの `sites` は「対象サイト」と書く。** 2026-11 に「札」からそろえた（docs・コメント・試験の
 *   名前・CLI の答えで 100 行あまり）。「札」は tag を 1 字で写した書き手の癖で、読み手に通じない。同じ字で
 *   書いていた `labels` は「ラベル」、BrowserHive の `correlationId` は「相関キー」（browserhive・dashboard・
 *   capture-scheduler も見張っている）
 * - **repo の一式は「Web Capture」と書く。** 2026-11 に「crawler」からそろえた。crawler はふつうの名詞と紛れ、
 *   動いている識別子（`crawler-storage`・Windmill の workspace の id）とも同じ字になる（capture-scheduler も見張っている）
 *
 * 書き手（人と Claude）は長くこの形で書いてきたので、見張らなければ戻ってくる。
 *
 * ## 何を見るか
 *
 * git が追跡する text のファイルの全行。docs に限らない —— 語は、書かれる場所を選ばずに広がる。
 *
 * - 「種」: 熟語（種類・種別）と、数のあとの「N 種」の外に立つ「種」
 * - 「起こす」: クロールを始める意味の形（OKOSU。dashboard・capture-scheduler と同じ並び）
 * - 「目録」「台本」: 全部
 * - 「網」: 熟語（安全網・網羅）の外に立つ「網」。browserhive の契約の写し（src/rpc/generated/）も
 *   見る —— 写しに残っていれば、pin の先の browserhive がまだ直っていないということ
 * - 「その場の JS」: 形の並び（OLD_INLINE。dashboard・capture-scheduler と同じ並び）
 * - 「札」: 全部
 * - 「crawler」: 一式の意味の形の並び（OLD_SUITE。capture-scheduler と同じ並び）。`crawler-storage`・`/w/crawler/`・
 *   `workspace crawler`・試験の入力値・ふつうの名詞は見ない
 *
 * ## 見ないもの
 *
 *   - submodule（.upstream/）と lockfile。この repo の言葉ではない
 *   - この file 自身。説明と、探す字そのものを書くため
 *   - 「起点」を seed の意味で使っているか、「起こす」がクロールの意味か。語の意味は機械には
 *     見えないので、「起こす」は形の並びで見る（並びに無い言い回しは止まらない）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoFiles } from "./repo-files.js";
import { ROOT } from "./root.js";

const SELF = "src/tools/check-terms.ts";
/** 許す形。足すときは、その形が seed の意味を持ちえないことを確かめる。 */
const ALLOWED = /種類|種別|\d\s?種/gu;
/**
 * クロールを始める意味の「起こす」の形。dashboard・capture-scheduler と同じ並び。
 * 足すときは、プロセスの「起こす」（dev:up が起こす・起こし直す・webhook で起こす）に当たらないことを確かめる。
 */
const OKOSU =
  /クロールを起こ|クロールは起こ|取り込みを起こ|取り込みの実行を起こ|起こしたクロール|起こせ(ます|ません|る|ない|れば|ば|て)|起こす(面|欄|口)|起こした(人|本人|行)|起こしました|起こしてよ|下敷きにして起こ|「起こす」|"起こす"/u;

/** 「網」のうち許す熟語。足すときは、その形が network の意味を持ちえないことを確かめる。 */
const AMI_ALLOWED = /安全網|網羅/gu;

/**
 * その場で書く物の古い呼び名（2026-11 まで）。JS になるのは変換の後なので、走った JS・変換後の JS は当てない。
 * 足すときは、それらと `jsSha256` に当たらないことを確かめる。
 */
const OLD_INLINE =
  /その場の JS|その場で書いた JS|JS の名前|JS の箱|書きかけの JS|この JS の id|その JS の id|\binline JS\b/u;

/**
 * repo の一式の古い呼び名（2026-11 まで）。capture-scheduler と同じ並び。
 * 足すときは、動いている識別子（`crawler-storage`・`/w/crawler/`・`workspace crawler`）と、ふつうの名詞
 * （The crawler honoured robots）に当たらないことを確かめる。
 */
const OLD_SUITE =
  /(?<!workspace )\bcrawler ?(の|で|が|を|全体)|\bcrawler repo(s|sitory|sitories)\b|\ball of crawler\b|\b[Tt]he crawler's development\b/u;

interface Rule {
  find: (line: string) => boolean;
  say: string;
}

const RULES: Rule[] = [
  {
    find: (line) => line.replace(ALLOWED, "").includes("種"),
    say: "「種」が残っています。クロールの seed は「起点」と書きます（本で数えるなら「起点の URL が N 本」）。",
  },
  {
    find: (line) => OKOSU.test(line),
    say: "「起こす」が残っています。クロールは「始める」と書きます（「始められます」「始めた人」）。",
  },
  {
    find: (line) => line.includes("目録") || line.includes("台本"),
    say:
      "「目録」か「台本」が残っています。ページで走らせる物は「スクリプト」、置き場は「台帳」（台帳に無い）、" +
      "対象サイトのある物は「サイト用のスクリプト」と書きます。",
  },
  {
    find: (line) => line.replace(AMI_ALLOWED, "").includes("網"),
    say:
      "「網」が残っています。network は「通信」（通信の記録・通信が静まる）、" +
      "基盤のネットワークは「ネットワーク」と書きます（安全網・網羅はそのまま）。",
  },
  {
    find: (line) => OLD_INLINE.test(line),
    say:
      "その場で書く物の古い呼び名が残っています。書く物は TypeScript なので、「その場の TS」と書きます" +
      "（走った JS・変換後の JS・jsSha256 はそのまま）。",
  },
  {
    find: (line) => line.includes("札"),
    say:
      "「札」が残っています。スクリプトの `sites` は「対象サイト」、`labels` は「ラベル」、" +
      "`correlationId` は「相関キー」と書きます。",
  },
  {
    find: (line) => OLD_SUITE.test(line),
    say:
      "repo の一式の古い呼び名が残っています。一式は「Web Capture」と書きます" +
      "（crawler-storage・workspace の id・ふつうの名詞の crawler はそのまま）。",
  },
];

// 追跡している物と、まだ add していない新しい物（`repo-files.ts`）。
const files = repoFiles(ROOT).filter(
  (f) => f !== SELF && f !== "pnpm-lock.yaml" && !f.startsWith(".upstream/"),
);

const found = RULES.map((rule) => ({ ...rule, hits: [] as string[] }));
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue; // submodule の入口はディレクトリで、読めない
  }
  if (text.includes("\0")) continue; // 画像などの binary
  text.split("\n").forEach((line, i) => {
    found.forEach((rule) => {
      if (rule.find(line)) rule.hits.push(`${file}:${String(i + 1)}: ${line.trim()}`);
    });
  });
}

for (const rule of found) {
  if (rule.hits.length === 0) continue;
  console.error(rule.say);
  for (const hit of rule.hits) console.error(`  ${hit}`);
}
if (found.some((rule) => rule.hits.length > 0)) process.exit(1);
console.log(`check:terms: ${String(files.length)} ファイルを見て、0 件`);
