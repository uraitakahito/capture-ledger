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

**だから目録がここに在ります。** 既定を持てるのは「このクロールは何を走らせるか」を
決める側だけなので、capture-ledger が `scripts` 表を持ち、解決した結果をクロールの行に
固定します。

ソースの出どころは [capture-scripts](https://github.com/uraitakahito/capture-scripts) で、
`.upstream/capture-scripts` の submodule として固定しています。あちらの `catalog.json` が、
ソースが自分では言えないこと —— `id` と `phase` —— を持ちます。

```sh
# catalog ごと入れる。何度流しても同じ（同じバイト列は同じ版）
pnpm run scripts import .upstream/capture-scripts
pnpm run scripts list                     # scriptIds を書かないクロールが走らせるもの

# 1 本だけ試す・設定を変えるのは、いまも手で
pnpm run scripts add autoscroll --file ./autoscroll.js --options '{"maxSteps":60}'
pnpm run scripts disable autofetch        # 既定から外す。名指しすれば走る
```

`import` は **options について意見を持ちません**。同じ source なら options が何であれ同じ版
として扱うので、手で調整した版を黙って置き換えることがありません。`--options` を渡すのは
意見なので、そちらは版を分けます。

`sha256` は**生成列**です。Postgres が `source` から数え、手で書き込むことはできません。
BrowserHive は受け取った両者を照合し、食い違えば `INVALID_ARGUMENT` で拒みます ——
生成列にしてあるので、あの照合が capture-ledger の数え間違いに答えていることはありえません。

`phase` は BrowserHive の 2 つの注入口のどちらを使うかです。`behavior` は読み込みの後・
主フレーム・1 回で、受け皿を通して報告できます。`preload` は**遷移の前**・iframe を含む
全フレーム・遷移のたびに走り、**報告する手段を持ちません**。

### クロールが固定するもの

`POST /api/crawls` は目録を**始めるときに 1 度だけ**解決し、その結果 —— id・版・phase・
source・sha256・options —— をクロールの行に書きます。以後の段はそれをそのまま使い、
目録を引き直しません。長いクロールの途中で版を足しても、後半のページで走るものは
変わりません。

| `scriptIds`   | 走るもの                                                   |
| ------------- | ---------------------------------------------------------- |
| 省く          | **有効な**各 id の最新版を、`id` 順で                      |
| `["b", "a"]`  | そのとおり、**その並びで** —— 並びは指示の一部             |
| `[]`          | 何も走らない。「既定でよい」と「何も走らせない」は別の意思 |
| 目録に無い id | **400** で名指し。クロールは立たない                       |

`GET /api/crawls/:id` が返すのは身元 —— id・版・phase・sha256 —— だけで、source は
返しません。走ったバイト列はアーカイブ（`behaviors/custom.jsonl` と
`preload/scripts.jsonl`）と目録に在ります。

最初の段の報告が来ると、各要素に `jsSha256` と `compiledWith`（`{ typescript, hostTypes }`）も
付きます。その段が走らせた JavaScript の sha256 と、何で・何に向けて変換したか ——
ts-compile-service が答え、flow が報告（`POST /api/crawls/:id/pages` の `compiled`）で
運んだ物です。目録の `sha256` は TypeScript に打たれ、アーカイブに残るのは JavaScript。
その間を継ぐのがこの値で、台帳が報告から写します。段ごとに同じ hash が来なければ 409 ——
走行中のクロールの下で変換サービスが替わったということです。報告が来る前はどちらも
`null` です。

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

| フィールド        | 既定                         | 意味                                 |
| ----------------- | ---------------------------- | ------------------------------------ |
| `scope`           | `same-origin`                | `same-host` にするとホスト単位に緩む |
| `maxDepth`        | 2。`fromTargets` のときは 0  | どこまで辿るか                       |
| `maxPages`        | 30。ただし種の数は下回らない | 総ページ数                           |
| `perHostDelayMs`  | 2000                         | 同じホストのページ間の間隔           |
| `hostParallelism` | 4                            | 同時に触るホストの数                 |
| `scriptIds`       | 有効な各 id の最新版         | ページの中で走らせるもの（上記）     |

知らないキーは黙って落とさず **400** で返します。
