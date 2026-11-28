/**
 * クロールの語を、旧い言い方で書いていないかを見張る。規則は下の RULES の 14 個。
 *
 * ## なぜ要るのか
 *
 * - **クロールの seed は「起点」と書く。** 2026-10 に「種」から「起点」へそろえた（docs・コメント・
 *   試験の名前・CLI の説明で 78 か所）。「種」は読み手に通じにくく、単独では「しゅ」（種類）とも読める
 * - **クロールは「始める」と書く。** 2026-10 に「起こす」から「始める」へそろえた（fga:grant の答え
 *   「…のクロールを始められます」・docs・コメント・試験の名前で 96 か所）。目的語の無い「起こす」は
 *   「目を覚まさせる」に読める。プロセスの「起こす」（dev:up が起こす・API を起こし直す・webhook で
 *   起こす）は別の意味で、見ない
 * - **取り込みを頼む側が付けて、BrowserHive が頁の中で走らせる物は capture scripts と書く。** 日本語の文でも英字で、
 *   1 本は capture script、文と見出しの頭は Capture scripts。2026-11 に（Jira CAPTURE-506）「スクリプト」から替えた
 *   （docs・コメント・試験の名前・CLI の字）。「スクリプト」だけでは、頁自身の JavaScript と紛れる。BrowserHive が自分で入れる
 *   乱数を記録するスクリプトと、package.json の script（`pnpm run` の各スクリプト）は capture scripts でないので、その形だけを
 *   許す（NOT_CAPTURE_SCRIPTS）。その前の 2026-10 に「目録」「台本」から「スクリプト」へそろえた（docs・コメント・試験の名前で 194 か所）。「目録」は browserhive と
 *   wacz-validator では BrowserHive WACZ の中の storage/ の目録を、「台本」は capture-workbench では代役の台本を指す。
 *   capture-ledger はどちらも持たないので、両方とも全部見る（capture-workbench と capture-scheduler も見張っている）。
 *   置き場の呼び名は 2026-11 に「台帳」から「登録済みのスクリプト」へ替え（下の「台帳」の項）、CAPTURE-506 で「登録済みの
 *   capture scripts」にした
 * - **network は「通信」と書く。** 2026-11 に「網」から「通信」へそろえた（browserhive の docs・
 *   コメント・試験の名前・契約の説明で 100 か所あまり、この repo では注記 7 か所と browserhive の
 *   契約の写し）。「網」は network を 1 字で写した書き手の癖で、読み手に通じにくい。通信そのもの
 *   （通信の記録・通信に載せる）も、通信が止むこと（通信が静まる・通信・CPU・DOM の静止）も「通信」、
 *   基盤のネットワーク（私設ネットワーク・内部ネットワーク）は「ネットワーク」。比喩の「網」
 *   （回帰の網・網から漏れる・粗い網）も言い換えた。「安全網」「網羅」は別の語で、見ない
 * - **クロールの頼みに書く物は「その場の TS」と書く。** 2026-11 に（Jira CAPTURE-83）、「その場の JS」から
 *   そろえた。`scripts[].inline.source` は compile の段で strict の TypeScript として検査されるのに、JS と名乗って
 *   いた。JS になるのは変換の後なので、走った JS・変換後の JS・`jsSha256` はそのまま（capture-workbench と
 *   capture-scheduler も見張っている）
 * - **スクリプトの `sites` は「対象サイト」と書く。** 2026-11 に「札」からそろえた（docs・コメント・試験の
 *   名前・CLI の答えで 100 行あまり）。「札」は tag を 1 字で写した書き手の癖で、読み手に通じない。同じ字で
 *   書いていた `labels` は「ラベル」、BrowserHive の `correlationId` は「相関キー」（browserhive・capture-workbench・
 *   capture-scheduler も見張っている）
 * - **repo の一式は「Web Capture」と書く。** 2026-11 に「crawler」からそろえた。crawler はふつうの名詞と紛れ、
 *   動いている識別子（`crawler-storage`・Windmill の workspace の id）とも同じ字になる（capture-scheduler も見張っている）
 * - **7080 番の Web アプリは「capture-workbench」、文で短く書くときは「workbench」と書く。** 2026-11 に「dashboard」から
 *   そろえた（repo の改名に合わせて）。この repo に Grafana の dashboard は無いので、語を全部見る（capture-scheduler も同じ）
 * - **WACZ を開くビューアは「replayweb-player」と書く。** 2026-11 に「replay」から replayweb-server へ、同じ月の CAPTURE-465 で
 *   replayweb-player へ替えた（repo の改名に合わせて。兄弟の capture-player と語尾を揃えた）
 * - **HTTP の method と path の組は「エンドポイント」、待ち受けの番号は「ポート」、スクリプトを差し込む時は「phase」、
 *   成果物を PUT する先は「受け取り先」と書く。** 2026-11 に（Jira CAPTURE-184）、1 字の語から意味ごとに替えた。
 *   同じ字がエンドポイント・ポート・phase・受け取り先・`POST /api/crawls` の本文の schema を兼ねていた。
 *   クライアントのオブジェクトを指していた「窓」の付く語も、クライアント・store・物の名前に替えた
 *   （capture-workbench・capture-scheduler・browserhive も見張っている）
 *
 * 書き手（人と Claude）は長くこの形で書いてきたので、見張らなければ戻ってくる。
 *
 * ## 何を見るか
 *
 * git が追跡する text のファイルの全行。docs に限らない —— 語は、書かれる場所を選ばずに広がる。
 *
 * - 「種」: 熟語（種類・種別）と、数のあとの「N 種」の外に立つ「種」
 * - 「起こす」: クロールを始める意味の形（OKOSU。capture-workbench・capture-scheduler と同じ並び）
 * - 「目録」「台本」: 全部
 * - 「スクリプト」: NOT_CAPTURE_SCRIPTS の形を除いて全部。browserhive の契約の写し（src/rpc/generated/）と、走った migration
 *   （001〜048）の注記と、Claude に渡す決まりの文（PROMPT_FILES）は見ない —— 写しの字は browserhive が決め、走った
 *   migration の注記は書き換えない（040 の前例）。決まりの文は版と一緒に変える
 * - 「網」: 熟語（安全網・網羅）の外に立つ「網」。browserhive の契約の写し（src/rpc/generated/）も
 *   見る —— 写しに残っていれば、pin の先の browserhive がまだ直っていないということ
 * - 「その場の JS」: 形の並び（OLD_INLINE。capture-workbench・capture-scheduler と同じ並び）
 * - 「札」: 全部
 * - 「crawler」: 一式の意味の形の並び（OLD_SUITE。capture-scheduler と同じ並び）。`crawler-storage`・`/w/crawler/`・
 *   `workspace crawler`・試験の入力値・ふつうの名詞は見ない
 * - 「dashboard」: 全部（大文字小文字を問わない）。browserhive の契約の写し（src/rpc/generated/）も見る
 * - 「口」: 切り口・入口・出口・窓口・口座を外して残った字。「注入口」は先に名指しで止める。browserhive の契約の写し
 *   （src/rpc/generated/）も見る —— 写しに残っていれば、pin の先の browserhive がまだ直っていないということ
 * - 「replay」: 旧い名前の形の並びだけ（OLD_REPLAY_NAMES）。語の replay は合本の形式（replay.json）と、画面の字と、ReplayWeb.page の
 *   振る舞いの文に残るので見ない
 *
 * - **「台帳」は使わない。** 2026-11 に（Jira CAPTURE-186）、意味ごとに書き分けた。capture-ledger というシステムは
 *   capture-ledger、スクリプトの置き場は「登録済みのスクリプト」（CLI の答えは「登録されていない: <id>」）、
 *   DB に入ったことは「capture-ledger に載る」、docs のページの題は「アーカイブの記録」。2 字がシステム・DB の行・
 *   置き場を兼ね、帳簿の語なのに「台帳が 400 で断る」と動く主語になっていた。許す語は無い。capture-workbench・
 *   capture-scheduler・browserhive も見張っている
 * - **BrowserHive WACZ Profile に適合する WACZ は「BrowserHive WACZ」、WARC は「BrowserHive WARC」と書く。** 2026-11 に
 *   （Jira CAPTURE-341）、別名を決めた。「BrowserHive の WACZ」「BrowserHive's WARC」は、作り手を言うだけの句と
 *   Profile に適合することを言う句の区別が付かない。仕様の名前（「BrowserHive の WACZ Profile」）は当てない。
 *   形の並びで見る（BH_ARTIFACT）
 * - **ページの JS が受け取った乱数を残すことは「乱数を記録する」、残した物は「乱数の記録」と書く。** 2026-11 に（t-azdk）、
 *   「乱数を控える」「乱数の控え」から替えた（docs・コメント・試験の名前）。「控える」はふつう「やめておく」と
 *   読まれ、`recordRandom` が乱数を使わない設定に見えた（英語はもとから record random values）。「記録」だけでは
 *   WARC の記録・通信の記録と取り違えるので、名詞は「乱数の記録」と修飾を付ける。乱数と並ぶ形と、乱数の字の無い
 *   よく戻る形（控えるスクリプト・控えた取り込み・控えなかった取り込み）だけを見るので（OLD_RANDOM）、
 *   ほかの意味の「控え」（WACZ の末尾の控え・shots-manifest.json の控え・控えめ）は見ない。browserhive の契約の写し
 *   （src/rpc/generated/）は見ない —— 写しの字は browserhive が決める（browserhive の lint:terms が見る）。走った migration の注記も
 *   書き換えないので、040 の注記の「控えさせる」「控えそのもの」は残る（この型に当たらない）。capture-workbench・
 *   capture-scheduler・browserhive も見張っている
 *
 * ## 見ないもの
 *
 *   - submodule（.upstream/）と lockfile。この repo の言葉ではない
 *   - tasks/。判断と教訓の記録で、やめた語を名指すのが仕事（browserhive の lint:terms と同じ）
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
 * クロールを始める意味の「起こす」の形。capture-workbench・capture-scheduler と同じ並び。
 * 足すときは、プロセスの「起こす」（dev:up が起こす・起こし直す・webhook で起こす）に当たらないことを確かめる。
 */
const OKOSU =
  /クロールを起こ|クロールは起こ|取り込みを起こ|取り込みの実行を起こ|起こしたクロール|起こせ(ます|ません|る|ない|れば|ば|て)|起こす(面|欄)|起こした(人|本人|行)|起こしました|起こしてよ|下敷きにして起こ|「起こす」|"起こす"/u;

/** 「網」のうち許す熟語。足すときは、その形が network の意味を持ちえないことを確かめる。 */
const AMI_ALLOWED = /安全網|網羅/gu;
/**
 * BrowserHive の成果物の、別名でない呼び方（CAPTURE-341）。「BrowserHive WACZ」「BrowserHive の WACZ Profile」には当たらない。
 * 足すときは、その 2 つに当たらないことを確かめる。
 */
const BH_ARTIFACT = /BrowserHive\s*(?:の|['’]s)\s*WA(?:RC|CZ)(?!\s*Profile)/u;
/** 「口」を、エンドポイント・ポート・phase・受け取り先の意味に取れない語。「注入口」は「入口」を含むので先に止める。 */
const NOT_KUCHI = /切り口|入口|出口|窓口|口座/gu;

/**
 * 乱数を残す意味の「控え」（t-azdk）。乱数と並ぶ形と、乱数の字の無いよく戻る形だけ。capture-workbench と同じ並び。
 * 足すときは、ほかの意味の「控え」（WACZ の末尾の控え・shots-manifest.json の控え・控えめ）に当たらないことを確かめる。
 */
const OLD_RANDOM =
  /乱数\s*[をのは]\s*控え|控えた\s*乱数|控える\s*スクリプト|控え(?:た|なかった)\s*取り込み/u;
/** browserhive の契約の写し。OLD_RANDOM はここを見ない（写しの字は browserhive が決め、browserhive の lint:terms が見る）。 */
const GENERATED = "src/rpc/generated/";

/**
 * 「スクリプト」のうち、capture scripts でない物（CAPTURE-506）。足すときは、取り込みを頼む側が付けて BrowserHive が頁の中で
 * 走らせる物でないことを確かめる。
 */
const NOT_CAPTURE_SCRIPTS = /乱数を記録するスクリプト|`pnpm run` の各スクリプト/gu;
/**
 * Claude に渡す決まりの文。版（`FIX_PROMPT_VERSION`・`PAIR_PROMPT_VERSION`）と結んであり、字を変えると版を上げて
 * 答えを測り直す要がある（`fix:eval`・`change:eval`）。CAPTURE-506 では変えなかったので、「スクリプト」の規則は見ない。
 */
const PROMPT_FILES: ReadonlySet<string> = new Set([
  "src/changes/summarize.ts",
  "src/scripts/fix.ts",
]);
/** 走った migration（049 より前）。注記は書き換えない。 */
const RAN_MIGRATION = /^src\/db\/migrations\/0(?:[0-3]\d|4[0-8])-/u;

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
  find: (line: string, file: string) => boolean;
  say: string;
}

/** replayweb-player の旧い名前の形（replay と、2026-11 の CAPTURE-465 までの replayweb-server）。語の replay は禁じない（上の注記）。 */
const OLD_REPLAY_NAMES =
  /uraitakahito[/:]replay(?![\w-])|\.upstream\/(?:browserhive\/)?replay(?![\w-])|\bREPLAY_(?:ORIGIN|TAG|REV)\b|\breplayOrigin(?:FromEnv)?\b|\breplayHref\b|\breplay\.(?:capture-ledger|browserhive|test)\b|\breplayweb[-_]server\b|REPLAYWEB_SERVER|\breplaywebServer/u;

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
      "「目録」か「台本」が残っています。ページで走らせる物は capture scripts、置き場は「登録済みの capture scripts」（登録されていない）、" +
      "対象サイトのある物は「サイト用の capture scripts」と書きます。",
  },
  {
    find: (line, file) =>
      !file.startsWith(GENERATED) &&
      !RAN_MIGRATION.test(file) &&
      !PROMPT_FILES.has(file) &&
      line.replace(NOT_CAPTURE_SCRIPTS, "").includes("スクリプト"),
    say:
      "「スクリプト」が残っています。取り込みを頼む側が付けて BrowserHive が頁の中で走らせる物は、日本語の文でも " +
      "capture scripts（1 本は capture script、文と見出しの頭は Capture scripts）と書きます（CAPTURE-506）。" +
      "頁自身の JavaScript は「頁の JS」と書きます。",
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
      "「札」が残っています。capture scripts の `sites` は「対象サイト」、`labels` は「ラベル」、" +
      "`correlationId` は「相関キー」と書きます。",
  },
  {
    find: (line) => OLD_SUITE.test(line),
    say:
      "repo の一式の古い呼び名が残っています。一式は「Web Capture」と書きます" +
      "（crawler-storage・workspace の id・ふつうの名詞の crawler はそのまま）。",
  },
  {
    find: (line) => /dashboard/iu.test(line),
    say:
      "「dashboard」が残っています。7080 番の Web アプリは「capture-workbench」、" +
      "文で短く書くときは「workbench」と書きます。",
  },
  {
    find: (line) => OLD_REPLAY_NAMES.test(line),
    say:
      "replay の旧い名前が残っています。WACZ を開くビューアは「replayweb-player」、環境変数は REPLAYWEB_PLAYER_*、" +
      "submodule は `.upstream/replayweb-player` と書きます。",
  },
  {
    find: (line) => line.includes("注入口") || line.replace(NOT_KUCHI, "").includes("口"),
    say:
      "「口」が残っています。HTTP の method と path の組は「エンドポイント」、待ち受けの番号は「ポート」、" +
      "capture scripts を差し込む時（behavior・preload）は「phase」、成果物を PUT する先は「受け取り先」と書きます" +
      "（切り口・入口・出口・口座はそのまま）。",
  },
  {
    find: (line) => line.includes("台帳"),
    say:
      "「台帳」が残っています。システムは capture-ledger、置き場は「登録済みの capture scripts」（登録する・登録されていない）、" +
      "DB に入ったことは「capture-ledger に載る」と書きます（CAPTURE-186）。",
  },
  {
    find: (line) => BH_ARTIFACT.test(line),
    say:
      "「BrowserHive の WACZ」の形が残っています。BrowserHive WACZ Profile に適合する物は「BrowserHive WACZ」" +
      "「BrowserHive WARC」（英語は a BrowserHive WACZ）、作り手を言うだけなら「BrowserHive が作った WACZ」と書きます" +
      "（CAPTURE-341）。",
  },
  {
    find: (line, file) => !file.startsWith(GENERATED) && OLD_RANDOM.test(line),
    say:
      "乱数の「控え」が残っています。ページの JS が受け取った乱数を残すことは「乱数を記録する」（記録した・記録しなかった・" +
      "記録できなかった）、残した物は「乱数の記録」と書きます（t-azdk）。",
  },
];

// 追跡している物と、まだ add していない新しい物（`repo-files.ts`）。
const files = repoFiles(ROOT).filter(
  (f) =>
    f !== SELF && f !== "pnpm-lock.yaml" && !f.startsWith(".upstream/") && !f.startsWith("tasks/"),
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
      if (rule.find(line, file)) rule.hits.push(`${file}:${String(i + 1)}: ${line.trim()}`);
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
