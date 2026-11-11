---
title: クイックスタート
description: Compose スタックを立ち上げ、データベースを準備し、最初のクロールを始めるまで。
---

スタックは capture-ledger に必要なものを一式立ち上げます — Postgres、
headless の Chromium 2 台、そしてその 1 台ずつに付く BrowserHive
（[固定した submodule](/capture-ledger/ja/upgrading-browserhive/)からビルド）です。実行基盤は
[Apple Container](https://github.com/apple/container)で、`container-compose` が駆動します。

成果物を置く store（SeaweedFS）は**このスタックには入っていません** —— [Web Capture](https://uraitakahito.github.io/capture-ledger/ja/#web-capture) の
repo が共有する 1 つの store で、[seaweedfs](https://github.com/uraitakahito/seaweedfs) が
起こします（§3）。

## いちばん短い道

**§1 と §2 だけは手で**（DNS の登録は `sudo` が要るので道具からは打てず、submodule と
`.env` は clone した直後の 1 度だけ）。そのあとは 1 本で立ち上がります:

```sh
pnpm run dev:up
```

立ち上げの段を、上から順に起こします。
どの段で何を打つかは、`pnpm run dev:up --dry-run` が一覧にします（何も起こしません）。
**打つコマンドを 1 行ずつ印字してから走る**ので、出力を上から読めば、
下の §3〜§7 の手順が並んでいます。capture-scheduler の `doctor` が全部 ✓ なら、撮れる状態です。

| 打つもの                     | 何をするか                                                             |
| ---------------------------- | ---------------------------------------------------------------------- |
| `pnpm run dev:up --dry-run`  | 段の一覧だけを出す。**何も起こさない**                                 |
| `pnpm run dev:up --from api` | 途中から。転んだ段を直したあとに使う（失敗時に名指しされます）         |
| `pnpm run dev:status`        | いま何が立っているか。何も変えない                                     |
| `pnpm run dev:down`          | ホストで動かしたもの → 両 repo のコンテナ（共有 store は落としません） |

:::note[隣に clone しておく repo]
`dev:up` は、隣の repo でもその repo のコマンドを打ちます（**向こうのファイルには書きません**）。
capture-scheduler（Windmill とクロールの flow）、
[wacz-validator](https://github.com/uraitakahito/wacz-validator)（検証の daemon）、
[capture-workbench](https://github.com/uraitakahito/capture-workbench)（Web Capture を開発するときに手元で開く Web アプリ）で、
`--dry-run` の一覧では `cd ../…` から始まる行です。
capture-ledger と同じ親ディレクトリに無いなら、`--scheduler`・`--validator`・`--workbench` に場所を渡します。
無いまま走らせると、その段で名指しして止まります。
capture-scheduler には DNS ドメインの登録も 1 度だけ要ります
（[capture-scheduler のクイックスタート](https://uraitakahito.github.io/capture-scheduler/ja/quickstart/)）。
:::

**下の §3 以降は、同じ段を 1 つずつ手でやる道です。**
`dev:up` は §3〜§7 の script をそのまま呼んでいるだけで、別の実装を持っていません。
検証の daemon と workbench（§8）だけは、`dev:up` が起こします。

## 1. DNS ドメインを登録する（マシンごとに 1 回）

```sh
sudo container system dns create capture-ledger
sudo container system dns create crawler-storage   # 共有 store のぶん
```

プロジェクト名がそのまま DNS ドメインになります。コンテナは `<service>.capture-ledger`
という名前になり、コンテナどうしはこの名前で呼び合います（たとえば BrowserHive は
`chromium-1.capture-ledger` に繋ぎます。共有 store も同じ仕組みで `seaweedfs.crawler-storage` です）。
登録が無いと container-compose は `container exec` で **各コンテナの中の** `/etc/hosts` に
追記する方式に退行します（お使いの Mac の `/etc/hosts` は触りません）。その
書き込みはこのスタックの非 root コンテナでは失敗しますが、container-compose は
終了状態を見ず何も出力しないため、**一部のサービスだけ名前が引けない**という
追いにくい症状になります。

## 2. 上流のソースを取ってきて、設定の雛形を写す

```sh
git submodule update --init --recursive   # 上流のソースを .upstream/ に取ってくる
cp -n .env.example .env                   # 設定の雛形を写す (既にあれば上書きしない)
```

`.upstream/` の submodule に、BrowserHive をはじめ上流のソースがすべて入っています。
build context はどれもここを指すので、空のままでは何もビルドできません。

`.env` は `.env.example` の写しです。何も調べず、値も変えません。開発用の値は雛形に
最初から入っています。**手で書き足すものはありません** —— OpenFGA の 2 つの ID（§5）も
クロールの行（§7）も、走らせてみないと決まらない値なので、**道具が `.env.local` に
書きます**（node は `.env` の後にそれを読むので、重なればそちらが効きます）。
`-n` は既にある `.env` を上書きしないための印で、手で直した値を守ります。

## 3. 共有 store とスタックを起動する

成果物を置く store は Web Capture で 1 つだけ立てます。まだ起きていなければ先に起こします
（submodule に入っているので、この repo から出る必要はありません）:

```sh
sh .upstream/seaweedfs/scripts/stack.sh up
```

続けて、この repo のスタック:

```sh
pnpm run stack:up
```

起動の前に、道具と DNS ドメイン（§1）と submodule（§2）、そして**共有 store が起きているか**
を確かめ、足りなければ名前を挙げて止まります。
store の中身を消す・見る手順は
[アーカイブの消し方など](https://uraitakahito.github.io/seaweedfs/ja/operations/)にあります。

初回は BrowserHive と Chromium イメージをソースからビルドするため、数分かかります。
状態を確認します (まだ起動していなければ curl がそのまま失敗を報告します):

```sh
curl -fsS http://localhost:50051/status | jq '{busy, browser: .browser.url}'
# → { "busy": false, "browser": "http://chromium-1.capture-ledger:9222/" }
```

これは `browserhive-1` です。スタックには 2 つ在ります —— BrowserHive は browser を
ちょうど 1 台持つので、Chromium 1 台に 1 つ —— 2 つ目は `localhost:50052` で答えます。

`/status` は BrowserHive の HTTP API です (JSON。v12 から。このスタックでは平文)。
契約は、この repo に vendor した OpenAPI 文書
(`src/rpc/generated/browserhive/openapi.json`、submodule からの写し) —— capture-ledger が
`.result.json` manifest を照らすのと同じファイルです。

Chromium は 2 台とも headless です。描画を見たい場合は、ローカルの Chrome で
`chrome://inspect` を開き、_Configure…_ に `localhost:9222` と `localhost:9223`
を登録してください。

続けて全文検索です。API は検索が無いと起動しません
（[全文検索](/capture-ledger/ja/archive-ledger/#全文検索)）。OpenSearch を、**そのサービスだけ名指しで**
起こし（名前を付け忘れると全部のコンテナが作り直されます）、宛先を `.env.local` に書きます:

```sh
pnpm run stack:up --profile search opensearch
pnpm run search:connect   # OpenSearch が答えるのを待ち、CAPTURE_LEDGER_OPENSEARCH_URL を .env.local に書く
```

## 4. データベースを準備する

```sh
pnpm install         # 初回のみ
pnpm run db:migrate  # テーブルを作成
pnpm run scripts import .upstream/capture-scripts  # ページの中で走らせるものを入れる
```

:::caution[スクリプトを入れ忘れない]
BrowserHive は**走らせるものの顔ぶれを持ちません**。登録済みのスクリプトが無いと、クロールはページの中で
何も走らせず —— スクロールも遅延読み込みも起きないまま、**成功したアーカイブが出ます**。
入っているかは `pnpm run scripts list` が言います。
:::

## 5. 認可を準備する

アーカイブ API と picker は OpenFGA を通します。**store と model の ID は
デプロイして初めて決まる**ので、compose にも雛形にも書けません。手で叩きます。

```sh
pnpm run fga:migrate  # OpenFGA の datastore を作る
pnpm run fga:deploy   # model を送り、store id と model id を .env.local に書く
```

`fga:deploy` は 2 行を印字したうえで、**`.env.local` に書き込みます。書き写す作業は
ありません。** `.env` は触りません —— 人が書くファイルに道具は手を入れない、という境界です
（[設定のファイルは 2 枚ある](/capture-ledger/ja/development-environment/#設定のファイルは-2-枚ある)）。

model id は走らせるたびに変わります（OpenFGA は同じ内容でも新しいモデルを作ります）。
**API が起動中なら、起こし直してください。**

:::note[この段はもう飛ばせません]
OpenFGA を通らない CLI は無くなりました。capture-ledger への入口はすべて API で、
API はこの 2 つの ID を要ります。
:::

## 6. API を起動する

API と、それが `/` に出す picker は **host 側で動かします**。スタックに
そのサービスはありません（§5 と同じ理由で、OpenFGA の ID が起動後にしか
決まらないため）。

```sh
pnpm run api
open http://127.0.0.1:7070/
```

:::note[この API は §7 で一度止めて、起こし直します]
**設定を読むのは起動のときの 1 度だけ**です。§7 の `pnpm run connect` と `pnpm run idp:bootstrap` が
`.env.local` に行を書くので、いま走らせているプロセスはそれを知らないまま終わります —— `Ctrl-C` で止めて、
同じ `pnpm run api` をもう一度打ちます。**2 本目を並べて立てることはできません**
（`EADDRINUSE: address already in use 0.0.0.0:7070` で落ちます）。
**どこに残っているか分からなくなったら** `pnpm run dev:status` が pid と起動時刻を出し、
`pnpm run dev:down` が止めます（`container-compose down` はコンテナしか知らないので、
ホストで動く API は残ります）。

いまの 1 本は「API が動くこと」と「picker が開くこと」を見るためのものです。
:::

開いたら、`subject` に自分の名前（`whoami` の出力）、
`organizations` に `acme`（§7 でクロールを始めるときに名乗る組織）を入れて、「読み込む」を押します。
**この時点では「見えるアーカイブが無い」と出るのが正常です** ——
一覧に行が増えるのは §7 のクロールの後です。画面の部品と、出る文の意味は、
[アーカイブを見る](/capture-ledger/ja/picker/)にあります。

欄が無く「この API には名乗りの設定が無く…（全員 401）」とだけ出るなら、`.env` の
`CAPTURE_LEDGER_DEV_IDENTITY=1` を確かめてください。無いと resolver が誰も通しません。

## 7. クロールを始める

取り込みはクロールとして始めます。段取りを決めるのは capture-ledger で、実際に撮るのは
[capture-scheduler](https://github.com/uraitakahito/capture-scheduler) の Windmill の flow です。
**ここから先は capture-scheduler が要ります** —— ここより前の段はそれ無しで動きますが、
取り込みだけは動きません。

### 1 度だけ: capture-scheduler とつなぐ

つなぐ手順は [capture-scheduler のクイックスタート](https://uraitakahito.github.io/capture-scheduler/ja/quickstart/)に
まとめてあります（Windmill を立て、flow を入れ、トークンを渡す）。その途中で、
capture-scheduler の `pnpm run windmill:bootstrap` が、この repo に渡す **行を自分の repo の中に
置きます**。**取りに行くのはこちらの仕事**です:

```sh
pnpm run connect   # ../capture-scheduler の行を読み、この repo の .env.local に書く
```

向こうのコマンドがこの repo の `.env` を書き換えることはありません —— 打った repo の外が
変わるのは、打った人の予想に反するからです。API に要るのは次の行で、**どれが欠けても、
クロールは最後まで走りません。** 最後の行は capture-scheduler からは来ません。
下の `pnpm run idp:bootstrap` が書きます。

| 行                                                                         | なぜ要るか                                                                                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL`<br>`CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN` | クロールを投げる先。無いと `/api/crawls` そのものが無く、`404` になります                                                                                                        |
| `CAPTURE_LEDGER_API_HOST=0.0.0.0`                                          | flow は段ごとの結果を API に報告し、その報告は**コンテナから**来ます。`127.0.0.1` のままでは届きません                                                                           |
| `CAPTURE_LEDGER_OIDC_ISSUER`<br>`CAPTURE_LEDGER_OIDC_CLIENT_IDS`           | flow は JWT で名乗ります。API が受けるのは JWT か開発用ヘッダの**どちらか一方**で、これを書くと JWT になります —— picker も、名乗りの 2 欄の代わりにトークンの欄を出します（§8） |

`connect` を打ったら、手元の IdP（Identity Provider —— 身元を証明するサービス）を用意し、API を起こし直します。
設定は起動のときに 1 度だけ読みます。IdP は [Floci](https://github.com/floci-io/floci) で、
Amazon Cognito の手元の代役です。§3 のスタックがサービス `idp` として動かしています
（[開発用の IdP](/capture-ledger/ja/development-environment/#開発用の-idpfloci)）。

```sh
pnpm run idp:bootstrap   # プール・app client・自分の利用者を作り、表の最後の行を .env.local に書く
pnpm run idp:grant       # flow の app client と自分の利用者に、acme のクロールを許す
```

`idp:bootstrap` は引き渡しファイル `.dev/idp.env` も書きます。capture-scheduler の
`windmill:capture-ledger-token` がそれを読むので、その段はこの後です（`dev:up` もその順に打ちます）。
`windmill:bootstrap` を打ち直したときは、`connect` も打ち直します（token が変わっています）。
API の起動ログの最後の行が `crawl level reports: ready` なら、行は効いています。
`blocked` なら、その上の warn が足りない行を名指しします
（[起動ログで確かめる](/capture-ledger/ja/development-environment/#起動ログで確かめる)）。
capture-scheduler のクイックスタートの最後にある `pnpm run doctor` が全部 ✓ なら、つながっています。
続く `pnpm run smoke` が 1 本撮って確かめます。

つないだ後は、予定の期限が来ると API がクロールを始めます。予定は、capture-workbench のタブ「定期実行」で
作るまで 1 つもありません（[定期実行](/capture-ledger/ja/schedules/)）。

### 始める

JWT で名乗ります。§6 のヘッダは、JWT の設定の API には効きません。

```sh
TOKEN=$(pnpm run --silent idp:token)   # idp:bootstrap が作った自分の利用者（acme）
curl -X POST http://127.0.0.1:7070/api/crawls \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"seeds":["https://example.com/"],"maxDepth":0}'
# → 202 { "crawlId": "9072b625-…" }
```

`seeds` は起点の URL を名指しします。既定はリンクを 2 段まで辿ることで、`maxDepth: 0` でそのページだけを取ります。

サイト用のスクリプトを試すなら、起点を `https://laws.e-gov.go.jp/` にし、本文に `"variables":{"query":"個人情報"}` を足します。
`scripts` を書かなければ、capture-scripts から入れた `egov-law-search`（対象サイト `laws.e-gov.go.jp`）が既定に入り、頁の中で法令名を
`query` の語で検索します。`query` は必須で、渡さなければ `400 missing variables` です
（[キャプチャオプション](/capture-ledger/ja/capture-options/)の「サイト用のスクリプト」）。

クロールがどう終わったかは、同じヘッダで `GET /api/crawls/<crawlId>` に訊きます。落ちたなら `error`
に「[段] 文」が、取れなかったページは `failures` に理由とページの id（`page`）つきで、
最後に投げた段の Windmill の run は `lastJob`
に出ます（`http://127.0.0.1:8000/run/<lastJob.id>?workspace=crawler` で開けます）。
そのページの取り込みのログは `GET /api/crawls/<crawlId>/pages/<page>/log`
が返します（[ページと取り込みのログ](/capture-ledger/ja/archive-ledger/#ページと取り込みのログ)）。

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/crawls/<crawlId> \
  | jq '{state, pagesCaptured, error, lastJob, failures}'
```

:::caution[404 は 2 通りあります]
本文が `Route POST:/api/crawls not found` なら route が無い（webhook の 2 行が無い）、
`{"error":"not found"}` なら呼び出し元に `can_submit` が無い（`pnpm run idp:grant` を打っていない）です。
同じトークンで `GET /api/me` を訊くと、`canSubmit` がその答えです。
[アーカイブの記録](/capture-ledger/ja/archive-ledger/#誰が始めてよいか)を参照。
:::

## 8. 結果を見る

いちばん早いのは workbench です。`dev:up` が最後に起こしているので、開くだけ:

```sh
open http://127.0.0.1:7080/
```

[capture-workbench](https://github.com/uraitakahito/capture-workbench) は **1 行 = 1 本のクロール**で、
状態・撮れた数・WACZ の数と、run（Windmill）と 2 つの再生（[replayweb-server](https://github.com/uraitakahito/replayweb-server) の「ReplayWeb.page ↗」と
[capture-player](https://github.com/uraitakahito/capture-player) の「Web Capture ↗」）への行き先が並びます。
アーカイブの画面では、行の「検証」から **撮れたものが WACZ の仕様どおりか**を見られます
（[wacz-validator](https://github.com/uraitakahito/wacz-validator) が答えます。
capture-ledger が署名した URL を渡すので、**store の鍵はどこにも増えません**）。
行の「開く」で **WACZ の中身**も見られます —— ファイルの木、行、field に割った 1 行、
WARC のレコードと画像。撮らなかった・撮れなかった記録（`WARC-Type: metadata`）も、そこに出ます。
**トークンを貼る必要はありません** —— あちらが自分の app client `workbench` で手元の IdP にサインインします
（手元では境界ではありません。Floci の管理の API は、届くものなら誰にでも利用者を作らせ、トークンを出します）。

以下は、その workbench が叩いているものを手で確かめる道です。

一覧は capture-ledger（`archives` テーブル）から来ていて、**OpenFGA の `can_view` で
絞ってあります**。§7 と同じトークンで API を直に叩けます。

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/archives | jq '.archives[0]'
```

picker で見るなら、§7 と同じ名前のトークンを画面に貼ります。API の設定は変えません。

```sh
pnpm run --silent idp:token | pbcopy
open http://127.0.0.1:7070/
```

§7 で行を受け取った API は JWT の設定なので、picker は §6 の 2 つの欄の代わりに「トークン」の欄を出します。
貼って「読み込む」を押すと、一覧の上に「（自分の `sub`）（acme）として見ている」と出て
（`sub` は Floci が利用者に付けた ID で、`idp:token` が出します）、
§7 のクロールが撮ったページが並びます。トークンは 1 時間で切れます。
「401 — このトークンは通らない…」と出たら、同じコマンドで取り直して貼ります
（[アーカイブを見る](/capture-ledger/ja/picker/#3-手で使うjwt-の設定)）。

行をクリックすると、別のタブで [replay](https://github.com/uraitakahito/replayweb-server) が開きます。
replay はまず、その WACZ に入っているページの一覧を出します
（WACZ は Web Archive Collection Zipped —— 取り込んだ 1 ページをまとめたファイルです）。
**題名をクリックすると、再生が始まります。**

API の全体は[アーカイブの記録](/capture-ledger/ja/archive-ledger/)にあります。

### まだ終わっていないとき

**ページが capture-ledger に載るのは、そのページの居た段を flow が報告した後**です。picker に
出てこないなら、段がまだ開いているか、そのページが失敗しています。走行中の取り込みに
問い合わせるエンドポイントはありません —— 取り込みは 1 回の HTTP 呼び出し（`POST /captures`）で、
結果は呼んだ側（Windmill の run）に返り、成果物の隣の `.result.json` manifest にも
書かれます。BrowserHive が答えるのは「いま busy かどうか」です。

```sh
curl -fsS http://localhost:50051/status | jq '{busy, browser: .browser.url}'
```

`"busy": true` ならその browser はページの途中です。もう 1 つは `localhost:50052`。

成果物は同梱の SeaweedFS バケット (`browserhive`) に置かれます。命名規則や
WACZ の中身は BrowserHive のストレージのページにあります。

### 409 が続くとき

走行中のクロールは 1 本だけで、2 本目は `409` です。**段の報告が API に届かなかったクロールは
`running` のまま残り、以後の起動を全部 `409` で塞ぎます** —— API が `127.0.0.1` で待っていた、
宛先の IP が古かった、走っている間に JWT の設定を外した、トークンが古かった、Windmill で run を取り消した、などです
（[クロールの行の終わり方](/capture-ledger/ja/archive-ledger/#クロールの行の終わり方)）。塞いでいる 1 本は `409` の
本文が名指しするので、その id で締めます。

```sh
# 409 の本文: {"error":"a crawl is already in progress","crawlId":"9072b625-…","startedAt":"…"}
curl -X POST http://127.0.0.1:7070/api/crawls/<crawlId>/failed \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"reason":"報告が届かなかったので手で締めた"}'
# → { "closed": true }
```

締めるのは走行中の行だけで、flow が落ちたときに締めに来る route と同じものです。
何が欠けていたかは、capture-scheduler の `pnpm run doctor` が名指しします。

## 次に読むもの

- アーカイブを配る・共有する、クロール API の全体 → [アーカイブの記録](/capture-ledger/ja/archive-ledger/)
- 定期的に撮る → [定期実行](/capture-ledger/ja/schedules/)
- 何を撮るかを変える → [キャプチャオプション](/capture-ledger/ja/capture-options/)
- Compose を使わずに動かす → [開発環境](/capture-ledger/ja/development-environment/)
