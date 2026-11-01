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

## リンクを辿るクロールには `links` が足される

`maxDepth` が 1 以上のクロールには、環境変数が何であれ `links: true` が付きます。
無いと 1 段目で必ず止まり、しかも「そのページにリンクが 1 本も無かった」ように
見えます —— 設定の誤りが、サイトの事実と区別できなくなります。

深さ 0 のクロールには足しません。辿らないリンクを取り出させても、相手と bucket に
無駄が出るだけです。

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
ソースが自分では言えないこと —— `id` と `phase`、サイト用のスクリプトなら `sites`、既定に入るか（`default`）—— を持ちます。

```sh
# スクリプト（catalog.json）と受け皿の型を入れる。何度流しても同じ（同じバイト列は同じ版）
pnpm run scripts import .upstream/capture-scripts
pnpm run scripts list                     # 各 id の最新版（札つき）
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
いま既定に入らないのは `autofetch` だけです（capture-scripts v0.6.1）。走らせるには `scripts` で名指しします。

`import` は、同じ置き場所の `types/host.d.ts`（受け皿 `__bh` の型）も `host_types` に写します。
こちらも中身が変わったときだけ版を足します。スクリプトを読む人に見せる写しで、クロールの変換が使う型は
ts-compile-service の pin です（`compiledWith.hostTypes` に出る）。ファイルの無い置き場所は、型を
入れずにスクリプトだけを入れ、そう言います。

`sha256` は**生成列**です。Postgres が `source` から数え、手で書き込むことはできません。
BrowserHive は受け取った両者を照合し、食い違えば `INVALID_ARGUMENT` で拒みます ——
生成列にしてあるので、あの照合が capture-ledger の数え間違いに答えていることはありえません。

`phase` は BrowserHive の 2 つの注入口のどちらを使うかです。`behavior` は読み込みの後・
主フレーム・1 回で、受け皿を通して報告できます。`preload` は**遷移の前**・iframe を含む
全フレーム・遷移のたびに走り、**報告する手段を持ちません**。

### サイト用のスクリプト（`sites`）

スクリプトは 1 本ずつ `sites`（札）を持てます。小文字のホスト名の列で、IDN は punycode で書き、ポート・
scheme・`*` は書けません。札のあるスクリプトは**サイト用のスクリプト**で、クロールの起点のどれかがそのホストに
あるときだけ走ります。照らすのは起点のホスト名との完全一致で、ポートは見ません。`example.com` と
`www.example.com` は別のホストです。札の無いスクリプトは、今までどおりどこでも走ります。札は版の一部で、
`options` と同じく、変えたら版が足されます。`import` が読む `catalog.json` の形は `capture-scripts/4`
（capture-scripts v0.6.0 で、[クロールごとの値](#クロールごとの値)の宣言 `params` が入った）で、`import` はそれより前の
形を断ります。形の悪いホスト名や宣言も、DB に触る前に断ります。

capture-scripts のサイト用のスクリプトの見本は `egov-law-search`（札 `laws.e-gov.go.jp`・v0.4.0 から）です。
[e-Gov 法令検索](https://laws.e-gov.go.jp/)の頁の中で法令名を「セキュリティ」で引き、件数と法令名を報告します。
起点が e-Gov 法令検索のクロールだけが既定で走らせ、ほかの起点では選ばれません。

決まりはクロールの単位で、起点で決まります。選ばれたサイト用のスクリプトは、そのクロールの全部の頁で
走ります。リンクを辿って別のホストへ出た頁でもです。だからサイト用のスクリプトは、冒頭で
`location.hostname` を見て、ほかの頁では何もせずに終わります（capture-scripts の check が、札の
ホスト名が source に出てくることを見ます）。

### クロールが固定するもの

`POST /api/crawls` はスクリプトを**始めるときに 1 度だけ**解決し、その結果 —— id・版・phase・
source・sha256・options・札・宣言 —— をクロールの行に書きます。以後の段はそれをそのまま使い、
台帳のスクリプトを引き直しません。長いクロールの途中で版を足しても、後半のページで走るものは
変わりません。[クロールごとの値](#クロールごとの値)も同じように固定します。`variables` は値ごと、
`secrets` は名前を結んだ Windmill の変数の path を。

| `scripts`                                                         | 走るもの                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 省く                                                              | **有効な**各 id の最新版のうち、札の無い物と、札が起点のホスト名を含む物を、`id` 順で               |
| `[{"catalog": "b"}, {"catalog": "a"}]`                            | そのとおり、**その並びで** —— 並びは指示の一部                                                      |
| `[{"inline": {"name": "x", "phase": "behavior", "source": "…"}}]` | 書いた JS を `inline-x`・版 1 で。台帳には登録されない（下記）                                      |
| `[]`                                                              | 何も走らない。「既定でよい」と「何も走らせない」は別の意思                                          |
| 台帳に無い id・同じ id の重ね                                     | **400** で名指し（`ids`）。クロールは立たない                                                       |
| 札が起点のどのホスト名も含まないサイト用のスクリプト              | **400** `site scripts need a seed on their site` で名指し（`ids`、札は `hint`）。クロールは立たない |
| 省いたのに、有効なスクリプトが全部ほかのホスト用                  | **400** `no default scripts for these seeds`（`hint` に並べる）。「スクリプトが無い」とは言わない   |

要素は、鍵が 1 つの object です（`catalog` か `inline` のどちらか）。

`GET /api/crawls/:id` が返すのは、台帳のスクリプトは身元 —— id・版・phase・sha256 —— と札だけで、
source は返しません。走ったバイト列はアーカイブ（`behaviors/custom.jsonl` と
`preload/scripts.jsonl`）と台帳（[版を読む](#版を読む)）に在ります。その場の JS には `inline`（`name`・`phase`・
source の UTF-8 の大きさ `bytes`）も返しますが、ここでも source は返しません。dashboard は走行中の
クロールを数秒ごとに引き直し、source は 1 MiB まであり得るからです。source は
`GET /api/crawls/:id/inline/:name` が `{ name, phase, source, sha256 }` で返します。台帳に登録されず、
アーカイブに在るのは変換後の JS なので、書いた物を取り戻せるのはこの口だけです。台帳のスクリプトには 404 を
返します。

最初の段の報告が来ると、各要素に `jsSha256` と `compiledWith`（`{ typescript, hostTypes }`）も
付きます。その段が走らせた JavaScript の sha256 と、何で・何に向けて変換したか ——
ts-compile-service が答え、flow が報告（`POST /api/crawls/:id/pages` の `compiled`）で
運んだ物です。台帳のスクリプトの `sha256` は TypeScript に打たれ、アーカイブに残るのは JavaScript。
その間を継ぐのがこの値で、台帳が報告から写します。段ごとに同じ hash が来なければ 409 ——
走行中のクロールの下で変換サービスが替わったということです。報告が来る前はどちらも
`null` です。

### 版を読む

スクリプトの source は、クロールを始められる人が HTTP で読めます。

| 口                                       | 返すもの                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scripts`                       | 各 id に 1 行（サイト用のスクリプトも、既定に入らない物も）: 既定で走る版（有効な版の中の最新）か、無ければ最新版を `enabled: false` で。`id`・`version`・`phase`・`sha256`・`sites`・`enabled`。`scripts` を書かないクロールが走らせるのは、`enabled` の物のうち札の無い物と、起点のホストに合う物 |
| `GET /api/scripts/:id/versions`          | 1 つの id の版の並び（新しい順）: `version`・`phase`・`sha256`・`sites`・`enabled`・`bytes`・`createdAt`。source は返さない                                                                                                                                                                         |
| `GET /api/scripts/:id/versions/:version` | 1 版を丸ごと: 上に `id`・`source`・`options` を足した物。無効な版も返す（過去のクロールが走らせた物）                                                                                                                                                                                               |
| `GET /api/host-types`                    | `import` が写した、いちばん新しい受け皿の型: `version`・`sha256`・`createdAt`・`source`・`bytes`                                                                                                                                                                                                    |

4 本ともクロールの口と同じ問い（呼び出し元の組織のどれかに `can_submit`）を訊きます。名乗りが
無ければ 401、許可が無ければ 404 で、在らない id や版と同じ答えです。版が 1 以上の整数でなければ、
何より先に 400 です。`bytes` は UTF-8 の大きさです。`pnpm run scripts show --version` は 1 版の口と
同じ関数で読みます。

**版の番号は使い回されます。** `add` は最新の版 + 1 を採るので、最新の版を消して足し直すと、同じ番号が
別の中身になります（capture-scheduler の e2e は毎回これをします）。ある版がクロールの走らせた物かを
確かめるには、その `sha256` をクロールの物と比べます。

### その場の JS

`scripts` の要素には、台帳のスクリプトの名指しのほかに、その場で書いた JS を置けます。

```json
{ "inline": { "name": "close-banner", "phase": "behavior", "source": "(() => {\n  …\n})();\n" } }
```

- **台帳には登録されません。** 台帳はクロールの行の写しにだけ、`inline-<name>`・版 1・options 空で
  固定します。sha256 は台帳が `source` から打ちます（`scripts` の生成列と同じ値）。写しの形は台帳のスクリプトと
  同じなので、flow も変換も BrowserHive も区別しません。
- **`inline-` は、その場の JS に取ってあります。** 台帳のスクリプトの id には使えません（CLI の `add` と
  `import` が断り、DB の CHECK が最後に断ります）。アーカイブに残るのは id と JS だけなので、
  id の頭で、台帳のスクリプトかその場の物かが分かります。
- **`name` は `^[a-z][a-z0-9-]*$` で、`inline-` と合わせて 64 字まで。** ts-compile-service の id と
  同じ綴りで、合わなければ `POST` が 400 で断ります。
- **書けるのは、strict の TypeScript として型が通る JS です。** 段の最初に ts-compile-service が
  台帳のスクリプトと一緒に型を検査し、1 本でも誤りがあれば段ごと落ちます（`error` に診断が残ります）。
  IIFE で包んでください。同じ段の JS は 1 つの program で検査されるので、top-level の名前は
  ほかの JS や DOM の大域（`name` など）とぶつかります。`export` を書くと型は通りますが、
  ページでは構文エラーになり、何も走りません。型の検査を外すなら、1 行目に `// @ts-nocheck`
  （構文は見ます）。
- **`POST /api/crawls` の本文は、全体で 1 MiB までです。** 超えると、何かを検査する前に 413 で断ります。
- **`preload` には受け皿（`__bh`）がありません。** 型の上では見えますが、ページには在りません。

### クロールごとの値

スクリプトは、クロールごとに違う値 —— 検索語や、口座の鍵 —— を読めます。読む名前は `catalog.json` の
`params` で宣言し、`import` が宣言を版に写します（`GET /api/scripts` が `params` で返します。札と同じく
版の一部です）。その場の JS にも同じ形の `params` を添えられます。宣言は、名前と、2 つの種類のどちらかと、
クロールが必ず渡すべきかと、何の値かを言います。

```json
{
  "name": "query",
  "kind": "variable",
  "required": false,
  "summary": "法令名の検索語。省けばソースの既定"
}
```

**変数**（`kind: "variable"`）は `POST /api/crawls` の本文の `variables`（名前 → 文字列）で渡し、**記録に残ります**。
クロールの行に固定され、段ごとに運ばれ、BrowserHive がアーカイブの `settings.variables` に書き、
`GET /api/crawls/:id` が返します。受けるのは宣言された名前だけで、知らない名前も、`required` の物の欠けも
400 です。例外は `params` を添えていないその場の JS で、何を読むか台帳に分からないので、それが混ざる間は
知らない名前も通します。

**シークレット**（`kind: "secret"`）には本文の欄がありません。宣言が名前を Windmill の secret 変数
`f/waggle_secrets/<名前>` に結び、そこへは人が前もって置きます（`wmill variable add <値> f/waggle_secrets/<名前> --secret`。
置き場と手順は capture-scheduler の docs にあります）。クロールを始めるとき、台帳は webhook と同じ URL と token で
Windmill に「在るか・secret か」を訊き、**値は読まずに**（`variables/get` に `decrypt_secret=false`）、
`{ path, editedAt }` を行に固定します。値を読むのは flow の `crawl_host` だけで、取り込みの直前に読みます。
値は台帳にも webhook の本文にもアーカイブ（`settings.secrets` に在るのは名前だけ）にも `GET /api/crawls/:id`
にも在りません。次の段を送る前に台帳は `editedAt` を読み直し、変わっていてもクロールは止めず、
`rotated`（気づいた段と新しい時刻）に残します。

名前は `^[a-z][a-z0-9_]*$` で 64 字まで、1 クロールの変数は 32 個まで、値は 4,096 字までの文字列です。
宣言に既定値は書けません。スクリプトは `__bh.vars.<名前>`（`__bh.secrets.<名前>`）を読み、渡されなければ
`undefined` を受け取って、自分のソースの既定に倒します。

| 答え                                                                     | いつ                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `400 missing variables`（`names`）                                       | `required` の変数が渡されていない                                                        |
| `400 unknown variables`（`names`）                                       | どのスクリプトも宣言していない名前を渡した（`params` の無いその場の JS が在れば見ない）  |
| `400 secrets cannot be passed as variables`（`names`）                   | シークレットとして宣言された名前を変数で渡した —— アーカイブに値が残ってしまう           |
| `400 conflicting params`（`names`）                                      | 同じ名前を、別々のスクリプトが別の種類で宣言している                                     |
| `400 invalid params`（`script`・`hint`）                                 | その場の JS の `params` が宣言の決まり（`import` と同じ）に合わない                      |
| `400 unknown secrets`（`secrets: [{ name, path, declaredBy }]`・`hint`） | `required` のシークレットが Windmill に無い。`required` でない物が無ければ渡さないだけ   |
| `400 not a secret variable`（`secrets`）                                 | Windmill に在るが secret の印が無い                                                      |
| `400 secrets need the windmill webhook`（`names`）                       | シークレットを宣言したスクリプトが在るのに、この配備の webhook の URL が flow の物でない |
| `503 windmill unreachable`                                               | Windmill に訊けなかった。何も始めない                                                    |

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

知らないキーは黙って落とさず **400** で返します。
