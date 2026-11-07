---
title: キャプチャオプション
description: この配備が「何を撮るか」をどう決めるか。形式と署名は環境変数から決まる。
---

capture-ledger 自身は何も撮りませんし、CLI が消えた今は BrowserHive とも話しません
（投げるのは Windmill の flow です）。ここに残っているのは **1 つの判断** ——
どの形式を要求するか、署名を必須にするか —— だけで、capture-ledger はそれを環境変数から
決め、投げるたびに載せます。

線の引き方はクロールの API と同じです。**呼ぶ側が「いつ」を決め、capture-ledger が
「何を」決める。** 形式はリクエストの性質ではなく配備の性質なので、呼び出し元から
受け取らないようにしてあります。

## フォーマット

`CAPTURE_LEDGER_CAPTURE_FORMATS` にカンマ区切りで書きます。既定は `wacz` ——
このパイプラインが作るのは再生できるアーカイブで、他の形式はその付随物だからです。

```sh
CAPTURE_LEDGER_CAPTURE_FORMATS=wacz   # png, webp, html, links, mhtml, wacz
CAPTURE_LEDGER_CAPTURE_SIGNING=1      # wacz-auth 署名を要求する。wacz が要る
```

| 値      | `captureFormats` のキー |
| ------- | ----------------------- |
| `png`   | `png`                   |
| `webp`  | `webp`                  |
| `html`  | `html`                  |
| `links` | `links`                 |
| `mhtml` | `mhtml`                 |
| `wacz`  | `wacz`                  |

6 つのキーは毎回**全部を明示して**送ります —— BrowserHive にとって「未設定」と
`false` は別物です。最低 1 つが true でないとサーバがリクエストを拒みます。

## 読むのは起動時の 1 回だけ

`CAPTURE_LEDGER_CAPTURE_FORMATS` はクロールのたびではなく、API の起動時に解釈します。
綴りを間違えていれば、その値を名指しでサーバが落ちます。毎回解釈する形にすると、
`waxz` のような打ち間違いは夜中の定期クロールが「形式が 1 つも有効でない」で
失敗して初めて表に出ます —— 原因の設定名を一言も含まないメッセージで。

## `links` はいつも付く

環境変数が何であれ、どのクロールのどの段にも `links: true` が付きます（`links` を
書いても書かなくても同じです）。無いとリンクを数えられず、「数えなかった」が
「そのページにリンクが 1 本も無かった」に見えます —— 設定の誤りが、サイトの事実と
区別できなくなります。

深さ 0 のクロールにも付きます。辿りませんが、数えます。読み込み済みの DOM を読むだけなので、
相手への要求は増えません。増えるのは、ページごとに bucket へ置く小さな JSON が 1 つです。

## 署名は落ちず、取り込みが落ちる

`CAPTURE_LEDGER_CAPTURE_SIGNING=1` は形式に `wacz` があることを要求します。サーバに後から
`INVALID_ARGUMENT` を言わせるのではなく、capture-ledger が起動時に拒みます。

**署名が得られなければ、その取り込みは失敗します。** BrowserHive は zip を書く前に
落とすので、署名済みのはずのものが未署名で出ることはありません。これは意図した
挙動ですが、運用上の帰結を明記しておきます —— 署名サービスの設定されていない配備で
署名を有効にすると、**全件**が失敗します。

無効のままにすれば、判断はサーバの `--signing-policy` に委ねられます。`required` で
動いている配備なら、capture-ledger が何も言わなくても署名されます。

結果は台帳に残ります。`archives.signed` は署名が付けば `true`、そもそも求めて
いなければ `null` —— 「このクロールは証拠として使える形のアーカイブを作ったか」に、
zip を 1 つも開かずに答えられます。

## ページの中で走らせるもの

BrowserHive v11.0.0 から、サーバは**走らせるものの顔ぶれを持ちません**。組み込みの
behavior も、サイト別の behavior もありません。送らなければページの中では何も走らず、
受け皿すら注入されません。それでも取り込みは成功し、アーカイブも出ます ——
スクロールも遅延読み込みも起きていない、というだけです。

**だからスクリプトがここに在ります。** 既定を持てるのは「このクロールは何を走らせるか」を
決める側だけなので、capture-ledger が `scripts` 表を持ち、解決した結果をクロールの行に
固定します。

ソースの出どころは [capture-scripts](https://github.com/uraitakahito/capture-scripts) で、
`.upstream/capture-scripts` の submodule として固定しています。あちらの `catalog.json` が、
ソースが自分では言えないこと —— `id` と `phase`、サイト用のスクリプトなら `sites`、既定に入るか（`default`）—— を持ちます。項目の並びが既定の実行順です。

```sh
# スクリプト（catalog.json）と受け皿の型を入れる。何度流しても同じ（同じバイト列は同じ版）
pnpm run scripts import .upstream/capture-scripts
pnpm run scripts list                     # 各 id の最新版（対象サイトつき）
pnpm run scripts list --seed https://laws.e-gov.go.jp/   # その起点のクロールが、scripts を書かないと走らせるもの（capture-scripts の egov-law-search も入る）
pnpm run scripts list autoscroll --all    # 1 つの id の版の並び
pnpm run scripts show autoscroll --version 1   # その版の source（無効な版も）
pnpm run scripts types                    # 受け皿（__bh）の型。import が写した物

# 1 本だけ試す・設定を変えるのは、いまも手で
pnpm run scripts add autoscroll --file ./autoscroll.js --options '{"maxSteps":60}'
pnpm run scripts add my-search --file ./my-search.ts --site www.example.com   # サイト用のスクリプト
pnpm run scripts disable autoscroll       # 既定から外す。名指しすれば走る（次の import でカタログに戻る）
```

`import` は **options について意見を持ちません**。同じ source なら options が何であれ同じ版
として扱うので、手で調整した版を黙って置き換えることがありません。`--options` を渡すのは
意見なので、そちらは版を分けます。

**既定に入るかは、カタログが決めます。** `"default": false` の項目は既定に入りません。`import` はその id の
全版を無効にします（最新版だけを無効にすると、古い版が既定に出てくるため）。`default` を省いた（`true` の）
項目は、取り込んだ版を有効にします。`enable`・`disable` で手で替えた物は、次の `import` まで効きます。
いま既定に入らないのは `autofetch` だけです（capture-scripts v0.9.0）。走らせるには `scripts` で名指しします。

`import` は、同じ置き場所の `types/host.d.ts`（受け皿 `__bh` の型）も `host_types` に写します。
こちらも中身が変わったときだけ版を足します。スクリプトを読む人に見せる写しで、クロールの変換が使う型は
ts-compile-service の pin です（`compiledWith.hostTypes` に出る）。ファイルの無い置き場所は、型を
入れずにスクリプトだけを入れ、そう言います。

`sha256` は**生成列**です。Postgres が `source` から数え、手で書き込むことはできません。
BrowserHive は受け取った両者を照合し、食い違えば `INVALID_ARGUMENT` で拒みます ——
生成列にしてあるので、あの照合が capture-ledger の数え間違いに答えていることはありえません。

`phase` は BrowserHive の 2 つの注入口のどちらを使うかです。`behavior` は読み込みの後・主フレーム・1
回で、受け皿を通して取り込みのログに行を書け（`__bh.log`）、結果を 1 回述べられます（`__bh.report`。
capture-scripts v0.7.0 から引数は 1 つ）。`preload` は**遷移の前**・iframe
を含む全フレーム・遷移のたびに走り、**ログに書く手段も報告する手段も持ちません**。書いた行の読み方は
[ページと取り込みのログ](/capture-ledger/ja/archive-ledger/#ページと取り込みのログ)にあります。

### サイト用のスクリプト（`sites`）

スクリプトは 1 本ずつ `sites`（対象サイト）を持てます。小文字のホスト名の列で、IDN は punycode で書き、ポート・
scheme・`*` は書けません。対象サイトのあるスクリプトは**サイト用のスクリプト**で、クロールの起点のどれかがそのホストに
あるときだけ走ります。照らすのは起点のホスト名との完全一致で、ポートは見ません。`example.com` と
`www.example.com` は別のホストです。対象サイトの無いスクリプトは、今までどおりどこでも走ります。対象サイトは版の一部で、
`options` と同じく、変えたら版が足されます。`import` が読む `catalog.json` の形は `capture-scripts/5`
（capture-scripts v0.11.0 で、[クロールごとの値](#クロールごとの値)の変数の宣言に値の形 `schema` が入った）で、`import` は
それより前の形を断ります。形の悪いホスト名や宣言も、DB に触る前に断ります。

capture-scripts のサイト用のスクリプトの見本は `egov-law-search`（対象サイト `laws.e-gov.go.jp`・v0.4.0 から）です。
[e-Gov 法令検索](https://laws.e-gov.go.jp/)の頁の中で、必須の変数 `query` の語で法令名を引き、件数と法令名を報告します。
起点が e-Gov 法令検索のクロールだけが既定で走らせ、ほかの起点では選ばれません（`query` を渡さなければ 400 です）。

決まりはクロールの単位で、起点で決まります。選ばれたサイト用のスクリプトは、そのクロールの全部の頁で
走ります。リンクを辿って別のホストへ出た頁でもです。だからサイト用のスクリプトは、冒頭で
`location.hostname` を見て、ほかの頁では何もせずに終わります（capture-scripts の check が、対象サイトの
ホスト名が source に出てくることを見ます）。

### クロールが固定するもの

`POST /api/crawls` はスクリプトを**始めるときに 1 度だけ**解決し、その結果 —— id・版・phase・
source・sha256・options・対象サイト・宣言 —— をクロールの行に書きます。以後の段はそれをそのまま使い、
台帳のスクリプトを引き直しません。長いクロールの途中で版を足しても、後半のページで走るものは
変わりません。[クロールごとの値](#クロールごとの値)も同じように固定します。`variables` は値ごと、
`secrets` は名前を結んだ Windmill の変数の path を。

| `scripts`                                                         | 走るもの                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 省く                                                              | **有効な**各 id の最新版のうち、対象サイトの無い物と、対象サイトが起点のホスト名を含む物を、カタログの順で  |
| `[{"catalog": "b"}, {"catalog": "a"}]`                            | そのとおり、**その並びで** —— 並びは指示の一部                                                              |
| `[{"inline": {"name": "x", "phase": "behavior", "source": "…"}}]` | 書いた TS を `inline-x`・版 1 で。台帳には登録されない（下記）                                              |
| `[]`                                                              | 何も走らない。「既定でよい」と「何も走らせない」は別の意思                                                  |
| 台帳に無い id・同じ id の重ね                                     | **400** で名指し（`ids`）。クロールは立たない                                                               |
| 対象サイトが起点のどのホスト名も含まないサイト用のスクリプト      | **400** `site scripts need a seed on their site` で名指し（`ids`、対象サイトは `hint`）。クロールは立たない |
| 省いたのに、有効なスクリプトが全部ほかのホスト用                  | **400** `no default scripts for these seeds`（`hint` に並べる）。「スクリプトが無い」とは言わない           |

要素は、鍵が 1 つの object です（`catalog` か `inline` のどちらか）。

`GET /api/crawls/:id` が返すのは、台帳のスクリプトは身元 —— id・版・phase・sha256 —— と対象サイトだけで、
source は返しません。走ったバイト列はアーカイブ（`behaviors/custom.jsonl` と
`preload/scripts.jsonl`）と台帳（[版を読む](#版を読む)）に在ります。その場の TS には `inline`（`name`・`phase`・
source の UTF-8 の大きさ `bytes`）も返しますが、ここでも source は返しません。[capture-workbench](https://github.com/uraitakahito/capture-workbench) は走行中の
クロールを数秒ごとに引き直し、source は 1 MiB まであり得るからです。source は
`GET /api/crawls/:id/inline/:name` が `{ name, phase, source, sha256 }` で返します。台帳に登録されず、
アーカイブに在るのは変換後の JS なので、書いた物を取り戻せるのはこの口だけです。台帳のスクリプトには 404 を
返します。

型の検査で落ちたクロールの誤りは、`GET /api/crawls/:id/diagnostics` で読み直せます。台帳は、そのクロールに
固定したスクリプトの写しを、webhook と同じ形で ts-compile-service に送り直します。flow の compile の段と
同じ組み合わせを検査するので、同じ誤りが、全部、行と列で返ります ——
`{ typescript, diagnostics: [{ script, line, col, code, message }] }`（スクリプトの外、型の lib の誤りは、
`script` の代わりに `file` を持ちます）。通る組み合わせなら `diagnostics` は空で、検査に使った
`hostTypes` も返します。この口には `CAPTURE_LEDGER_TS_COMPILE_URL` が要り（capture-scheduler の compose が
ts-compile を host の `127.0.0.1:28080` に出しています）、無ければ口を出しません。何も書き換えず、
ts-compile-service しか呼ばないので GET で、許可はクロールのほかの口と同じです。サービスに届かなければ
503 を返します。

`POST /api/crawls/:id/inline/:name/fix`（本文は `{}`）は、その場の TS の型の誤りの直し方を Claude に訊き、
**同じ検査に通った直ししか返しません**。台帳はまず組み合わせを検査し直してから、行番号つきのその場の TS・
一緒に走るスクリプト（読むだけで、変えさせない）・誤り・受け皿の型（`host_types`）を Claude に渡し、
行の範囲の置き換えと、誤りごとの 1 行の理由を返させます。置き換えを当て、`// @ts-nocheck`・`@ts-ignore`・
`@ts-expect-error`・`as any`・`: any` を足した案、`import` か `export` を足した案（module になり、黙って
走らなくなる）、元の行の半分（少なくとも 3 行は許す）を超えて置き換えた案は断り、ほかのスクリプトと
一緒に ts-compile-service で検査します。通らなければ、同じ会話に継ぎ足してもう 1 度だけ訊きます
（2 回まで）。ほかには何も送りません（頁の文字・変数の値・シークレットは送らない）。確かめるのは型だけで、
動きが変わっていないかは差分を読んで確かめてください。

| 答え                                                    | いつ                                                                         | Claude を呼んだか  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| 200 `{ rounds, source, edits, notes, compiled, usage }` | 検査に通った直しがある（`edits` は置き換えた範囲ごとの `before` と `after`） | 呼んだ             |
| 409 `scripts compile`                                   | いまの組み合わせが型を通る（直す物が無い）                                   | 呼ばない           |
| 422 `no errors in this inline script`                   | 誤りがこのスクリプトに無い（ほかのスクリプトか lib に在る）                  | 呼ばない           |
| 429 `claude budget exhausted`                           | 組織がこの月の上限に届いた                                                   | 呼ばない           |
| 422 `no fix passed the checks`                          | 2 回で通らなかった（最後の誤りと断った理由つき）                             | 呼んだ             |
| 422 `claude refused`                                    | 安全の判定で断られた                                                         | 呼んだ             |
| 502 `claude failed`・503 `ts-compile unreachable`       | API か ts-compile-service が答えなかった                                     | 呼んだかもしれない |

Claude を呼んだ頼みは、1 回ごとに表 `derivations` に 1 行残します（入力の digest・model・prompt の版・
effort・回数・出力・usage・費用）。WACZ には書きません。組織ごとの月の上限は、その費用を足して数えます
（`CAPTURE_LEDGER_CLAUDE_BUDGET_USD`、既定 5）。口は `CAPTURE_LEDGER_ANTHROPIC_API_KEY` があるときだけ出し、
鍵があって `CAPTURE_LEDGER_TS_COMPILE_URL` が無ければ API は起動で止まります。答えの `usage` に token の数と
費用（`usd`）が載ります。

最初の段の報告が来ると、各要素に `jsSha256` と `compiledWith`（`{ typescript, hostTypes }`）も
付きます。その段が走らせた JavaScript の sha256 と、何で・何に向けて変換したか ——
ts-compile-service が答え、flow が報告（`POST /api/crawls/:id/pages` の `compiled`）で
運んだ物です。台帳のスクリプトの `sha256` は TypeScript に打たれ、アーカイブに残るのは JavaScript。
その間を継ぐのがこの値で、台帳が報告から写します。段ごとに同じ hash が来なければ 409 ——
走行中のクロールの下で変換サービスが替わったということです。報告が来る前はどちらも
`null` です。

### 版を読む

スクリプトの source は、クロールを始められる人が HTTP で読めます。

| 口                                       | 返すもの                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scripts`                       | 各 id に 1 行（サイト用のスクリプトも、既定に入らない物も）: 既定で走る版（有効な版の中の最新）か、無ければ最新版を `enabled: false` で。`id`・`version`・`phase`・`sha256`・`sites`・`enabled`。`scripts` を書かないクロールが走らせるのは、`enabled` の物のうち対象サイトの無い物と、起点のホストに合う物。行は既定の実行順（カタログの順で、カタログに無い物はその後ろに `id` 順） |
| `GET /api/scripts/:id/versions`          | 1 つの id の版の並び（新しい順）: `version`・`phase`・`sha256`・`sites`・`enabled`・`bytes`・`createdAt`。source は返さない                                                                                                                                                                                                                                                           |
| `GET /api/scripts/:id/versions/:version` | 1 版を丸ごと: 上に `id`・`source`・`options` を足した物。無効な版も返す（過去のクロールが走らせた物）                                                                                                                                                                                                                                                                                 |
| `GET /api/host-types`                    | `import` が写した、いちばん新しい受け皿の型: `version`・`sha256`・`createdAt`・`source`・`bytes`                                                                                                                                                                                                                                                                                      |
| `POST /api/scripts/check`                | 書きかけの TS の変数の宣言と誤り: `params`・`diagnostics`（[クロールごとの値](#クロールごとの値)）。ts-compile-service の宛先が無い配備には無い                                                                                                                                                                                                                                       |

どれもクロールの口と同じ問い（呼び出し元の組織のどれかに `can_submit`）を訊きます。名乗りが
無ければ 401、許可が無ければ 404 で、在らない id や版と同じ答えです。版が 1 以上の整数でなければ、
何より先に 400 です。`bytes` は UTF-8 の大きさです。`pnpm run scripts show --version` は 1 版の口と
同じ関数で読みます。

**版の番号は使い回されます。** `add` は最新の版 + 1 を採るので、最新の版を消して足し直すと、同じ番号が
別の中身になります（capture-scheduler の e2e は毎回これをします）。ある版がクロールの走らせた物かを
確かめるには、その `sha256` をクロールの物と比べます。

### その場の TS

`scripts` の要素には、台帳のスクリプトの名指しのほかに、その場で書いた TS を置けます。

```json
{ "inline": { "name": "close-banner", "phase": "behavior", "source": "(() => {\n  …\n})();\n" } }
```

- **台帳には登録されません。** 台帳はクロールの行の写しにだけ、`inline-<name>`・版 1・options 空で
  固定します。sha256 は台帳が `source` から打ちます（`scripts` の生成列と同じ値）。写しの形は台帳のスクリプトと
  同じなので、flow も変換も BrowserHive も区別しません。
- **`inline-` は、その場の TS に取ってあります。** 台帳のスクリプトの id には使えません（CLI の `add` と
  `import` が断り、DB の CHECK が最後に断ります）。アーカイブに残るのは id と JS だけなので、
  id の頭で、台帳のスクリプトかその場の物かが分かります。
- **`name` は `^[a-z][a-z0-9-]*$` で、`inline-` と合わせて 64 字まで。** ts-compile-service の id と
  同じ綴りで、合わなければ `POST` が 400 で断ります。
- **書けるのは、strict の TypeScript として型が通るスクリプトです。** 段の最初に ts-compile-service が
  台帳のスクリプトと一緒に型を検査し、1 本でも誤りがあれば段ごと落ちます（`error` に最初の診断が、台帳の上限の 2,000 字まで残ります。
  全部を読み直すのは `GET /api/crawls/:id/diagnostics`）。
  IIFE で包んでください。同じ段のスクリプトは 1 つの program で検査されるので、top-level の名前は
  ほかのスクリプトや DOM の大域（`name` など）とぶつかります。`export` は `BH0006` で段ごと落ちます
  （ページでは構文エラーになり、何も走らないためです）。型の検査を外すなら、1 行目に `// @ts-nocheck`
  （構文は見ます）。
- **[Zod](https://zod.dev/) を読めます。** 先頭の文に `import { z } from "zod"` か `import * as z from "zod/mini"`
  を書きます。ts-compile-service が使う名前だけを JS に束ねるので、スクリプトごとに 85 KB ほど増え（`zod/mini` は
  15 KB）、WACZ の `behaviors/custom.jsonl` にもその大きさで残ります。形が合わなくてもクロールは成功のままなので、
  `parse` より `safeParse` と `__bh.log.error` を使います。`preload` では使えません（`BH0004`）。
  書き方は capture-scripts の README の「Zod」。
- **`POST /api/crawls` の本文は、全体で 1 MiB までです。** 超えると、何かを検査する前に 413 で断ります。
- **`preload` には受け皿（`__bh`）がありません。** 型の上では見えますが、ページには在りません。

### クロールごとの値

スクリプトは、クロールごとに違う値 —— 検索語や、口座の鍵 —— を読めます。変数はスクリプトの中で宣言し、
シークレットは `params` で宣言します。

**変数**は source の `defineParams` で宣言します。`.optional()` の無い名前は必須です。

```ts
import { z } from "zod";

const { query } = defineParams(z.object({ query: z.string().min(1).describe("法令名の検索語") }));
```

`POST /api/crawls` の本文の `variables`（名前 → 文字列）で渡し、**記録に残ります**。クロールの行に固定され、段ごとに
運ばれ、BrowserHive がアーカイブの `settings.variables` に書き、`GET /api/crawls/:id` が返します。

**台帳は行を立てる前に ts-compile-service に訊きます。** スクリプトと、渡した変数の名前（値は送りません）を `/compile` に
送り、答えの宣言を行に固定します。必須の名前が足りなければ `400 missing variables` で、行も run も残りません。
判定は ts-compile-service の 1 か所です（`BH0001`）。宣言に無い名前も、宣言の形（`.min`・`.max`・`.length`・`z.enum`）に
合わない値も 400 です。ふつうの型の誤りはここでは断らず、行を立てて flow の compile の段で落とします（落ちた行から
「直し方を訊く」へ進むため）。宣言を読めないスクリプト（`BH0002`）が混ざるときも行を立て、同じ段で理由を残します。
書ける形は capture-scripts の README の「クロールごとの値」にあります。

台帳のスクリプトの変数は `catalog.json` の `params` にも写され（`GET /api/scripts` が `params` で返します）、
workbench はそれで欄を作ります。

```json
{
  "name": "query",
  "kind": "variable",
  "required": true,
  "summary": "法令名の検索語",
  "schema": { "type": "string", "minLength": 1 }
}
```

書きかけの TS の宣言は `POST /api/scripts/check`（`{ source, phase }` → `{ params, diagnostics }`）で読めます。行を立てず、
値も受けません。`BH0001` は誤りに数えません（書いている最中の「まだ渡していない」は誤りではないので）。

**シークレット**（`kind: "secret"`）は、`catalog.json` の `params` か、その場の TS に添える `params` で宣言します（変数は
ここには書けません）。本文に欄はありません。宣言が名前を Windmill の secret 変数
`f/waggle_secrets/<名前>` に結び、そこへは人が前もって置きます（`wmill variable add <値> f/waggle_secrets/<名前> --secret`。
置き場と手順は capture-scheduler の docs にあります）。クロールを始めるとき、台帳は webhook と同じ URL と token で
Windmill に「在るか・secret か」を訊き、**値は読まずに**（`variables/get` に `decrypt_secret=false`）、
`{ path, editedAt }` を行に固定します。値を読むのは flow の `crawl_host` だけで、取り込みの直前に読みます。
値は台帳にも webhook の本文にもアーカイブ（`settings.secrets` に在るのは名前だけ）にも `GET /api/crawls/:id`
にも在りません。スクリプトが値を取り込みのログ（`__bh.log`・`__bh.report`・例外の文）に書いても、BrowserHive が
**長さに依らず** `***` に替えてから行に残すので、`.result.json` と 1 ページのログの口にも在りません。
隠せるのは記録からだけで、ページの JS からは読めますし、スクリプトが通信に載せれば WARC には残ります。次の段を送る前に台帳は `editedAt` を読み直し、変わっていてもクロールは止めず、
`rotated`（気づいた段と新しい時刻）に残します。

名前は `^[a-z][a-z0-9_]*$` で 64 字まで、1 クロールの変数は 32 個まで、値は 4,096 字までの文字列です。
宣言に既定値は書けません。任意の変数とシークレットは、渡されなければ `undefined` で、スクリプトが自分のソースの既定に倒します。

| 答え                                                                     | いつ                                                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `400 missing variables`（`names`・`diagnostics`）                        | 必須の変数が渡されていない（`diagnostics` は `BH0001` の行と列）                                   |
| `400 invalid variables`（`names`・`hint`）                               | 値が宣言の形に合わない（`.min` に足りない字数、`z.enum` に無い字など）                             |
| `400 unknown variables`（`names`）                                       | どのスクリプトも宣言していない名前を渡した（宣言を読めないスクリプトが在れば見ない）               |
| `400 secrets cannot be passed as variables`（`names`）                   | シークレットとして宣言された名前を変数で渡した —— アーカイブに値が残ってしまう                     |
| `400 conflicting params`（`names`）                                      | 同じ名前を、別々のスクリプトが別の種類か別の形で宣言している                                       |
| `400 invalid params`（`script`・`hint`）                                 | その場の TS の `params` が宣言の決まり（`import` と同じ）に合わない。変数は書けない                |
| `503 ts-compile unreachable`                                             | ts-compile-service に訊けない（400・409 の答えも含む。版のずれはログの本文で分かる）。何も始めない |
| `400 unknown secrets`（`secrets: [{ name, path, declaredBy }]`・`hint`） | `required` のシークレットが Windmill に無い。`required` でない物が無ければ渡さないだけ             |
| `400 not a secret variable`（`secrets`）                                 | Windmill に在るが secret の印が無い                                                                |
| `400 secrets need the windmill webhook`（`names`）                       | シークレットを宣言したスクリプトが在るのに、この配備の webhook の URL が flow の物でない           |
| `503 windmill unreachable`                                               | Windmill に訊けなかった。何も始めない                                                              |

どれもクロールは立ちません。`GET /api/crawls/:id` は `variables`（値ごと）と `secrets`
（`[{ name, path, editedAt, rotated }]`。名前順）を返します。

## capture-ledger がいまも決めないもの

以前の CLI は BrowserHive の `CaptureRequest` のフィールドそれぞれに旗を対応させていました
（`--device-pixel-ratios` / `--operation-delay-ms` / `--dismiss-banners` /
`--accept-language` / `--session`）。**これらはもう存在しません。** `captureFormats`・
`signing`・上のスクリプトを除けば、capture-ledger はページの描き方について何も送りません
—— 送らないものはすべて、その BrowserHive サーバの設定どおりになります（意味は
BrowserHive 自身のドキュメントが定義します）。

## 呼び出し元がクロールごとに渡せるもの

相手への当たり方と範囲を、`POST /api/crawls` のボディで渡せます
（[アーカイブ台帳](/capture-ledger/ja/archive-ledger/#リンクを辿る)を参照）。

| フィールド        | 既定                                                               | 意味                                                                      |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `rules`           | `[{ "follow": "same-origin" }]`                                    | どのリンクを撮って辿り、撮るだけにし、落とすか                            |
| `maxDepth`        | 2。`fromTargets` のときは 0                                        | どこまで辿るか                                                            |
| `maxPages`        | 30。ただし起点の数は下回らない                                     | 総ページ数                                                                |
| `perHostDelayMs`  | 2000                                                               | 同じホストのページ間の間隔                                                |
| `hostParallelism` | 4                                                                  | 同時に触るホストの数                                                      |
| `scripts`         | 有効な各 id の最新版（ほかのホスト用のサイト用のスクリプトを除く） | ページの中で走らせるもの（上記）                                          |
| `variables`       | 無し                                                               | 選んだスクリプトが宣言した、クロールごとの値（[上記](#クロールごとの値)） |
| `userAgent`       | 無し（ブラウザの字のまま）                                         | 送る `User-Agent`（[下記](#クロールごとの-user-agent)）                   |

知らないキーは黙って落とさず **400** で返します。

### クロールごとの User-Agent

`userAgent` は、そのクロールで送る `User-Agent` です。省くか空白だけなら、ブラウザの字（`HeadlessChrome` を含み、断るサイトがあります）のまま送ります。
`{chrome}` はブラウザの字から Headless を外した物を指すので、`{chrome} BrowserHive` はブラウザを上げても古くなりません。解くのは BrowserHive で、台帳は打った字のまま持ちます。
`GET /api/crawls/:id` はその字を返し（頼まなければ `null`）、実際に送った字はアーカイブの `settings.userAgent` に残ります。

形は BrowserHive の契約と同じです。合わなければ `400 userAgent must be printable ASCII, at most 512 characters` で断ります。字の中身は頼む人が決めます。

`BrowserHive` の語は 2 つのことを変えます。相手のサイトが BrowserHive が撮ったと分かるのは、字にこの語があるときだけです（`{chrome}` だけなら普通の Chrome と同じ字です）。robots.txt の読み方も決まります。語として含めば `BrowserHive` の名前で（その組が先で、無ければ `*`）、含まなければ `*` で照らします（`NotBrowserHiveAtAll` は語として含みません）。
