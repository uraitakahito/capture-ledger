---
title: クイックスタート
description: Compose スタックを立ち上げ、capture_targets を seed し、最初のクロールを起こすまで。
---

スタックは capture-ledger に必要なものを一式立ち上げます — Postgres、SeaweedFS、
headless の Chromium 2 台、そしてその 1 台ずつに付く BrowserHive
（[固定した submodule](/capture-ledger/ja/upgrading-browserhive/)からビルド）です。実行基盤は
[Apple Container](https://github.com/apple/container)で、`container-compose` が駆動します。

## 1. DNS ドメインを登録する（マシンごとに 1 回）

```sh
sudo container system dns create capture-ledger
```

プロジェクト名がそのまま DNS ドメインになります。コンテナは `<service>.capture-ledger`
という名前になり、**コンテナ間からもホストからも**解決できます — capture-ledger 自身を
ホストで動かしてこのスタックに繋げられるのはこのためです。登録が無いと
container-compose は `container exec` で **各コンテナの中の** `/etc/hosts` に
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
最初から入っていて、書き足すのは OpenFGA の 2 つの ID だけです（§5）。`-n` は既にある
`.env` を上書きしないための印で、書き写した ID を守ります。

## 3. スタックを起動する

```sh
pnpm run stack:up
```

起動の前に、道具と DNS ドメイン（§1）と submodule（§2）を確かめ、足りなければ
名前を挙げて止まります。

初回は BrowserHive と Chromium イメージをソースからビルドするため、数分かかります。
状態を確認します (まだ起動していなければ grpcurl がそのまま失敗を報告します):

```sh
grpcurl -plaintext -emit-defaults -import-path proto -proto browserhive/v1/capture.proto \
  localhost:50051 browserhive.v1.CaptureService/GetServerStatus \
  | jq '{busy, browser: .browser.url}'
# → { "busy": false, "browser": "http://chromium-1.capture-ledger:9222/" }
```

これは `browserhive-1` です。スタックには 2 つ在ります —— BrowserHive は browser を
ちょうど 1 台持つので、Chromium 1 台に 1 つ —— 2 つ目は `localhost:50052` で答えます。
`-emit-defaults` を付けているのは `busy: false` を見せるためです。grpcurl は既定値の
フィールドを落とすので、付けないと空いている server は `null` と出ます。

`-import-path proto -proto …` は、この repo に vendor した契約を grpcurl に
指しています。BrowserHive は reflection を提供しません —— 未実装ではなく意図的な
判断で、有効にするには descriptor set を同梱して実行時に読ませることになり、
`.proto` がランタイムの資産になってしまうためです。したがって呼ぶ側がサービスを
知る手段がこの `.proto` です —— クライアントの生成元と同じファイルです。

Chromium は 2 台とも headless です。描画を見たい場合は、ローカルの Chrome で
`chrome://inspect` を開き、_Configure…_ に `localhost:9222` と `localhost:9223`
を登録してください。

## 4. データベースを準備する

**dev コンテナはありません。** capture-ledger はホストで動き、名前でスタックに届きます
（接続文字列は `.env` に入っています）。

```sh
pnpm install         # 初回のみ
pnpm run db:migrate  # capture_targets テーブルを作成
pnpm run db:seed     # サンプル 5 件を投入
```

## 5. 認可を準備する

アーカイブ API と picker は OpenFGA を通します。**store と model の ID は
デプロイして初めて決まる**ので、compose には書けません。手で叩いて `.env` に
貼ります。

```sh
pnpm run fga:migrate  # OpenFGA の datastore を作る
pnpm run fga:deploy   # model を送り、store id と model id を印字する
```

印字された 2 行を `.env` の `CAPTURE_LEDGER_FGA_STORE_ID` と `CAPTURE_LEDGER_FGA_MODEL_ID` に
書き写してください。

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

一覧が空なら `.env` の `CAPTURE_LEDGER_DEV_IDENTITY=1` を確かめてください。無いと
resolver が誰も通さず、picker は `401` で空のままになります。

:::caution[スケジューラから叩くなら loopback では届きません]
既定の待ち受けは `127.0.0.1` で、**コンテナから届きません**。capture-scheduler の Windmill に
日次を任せるなら 0.0.0.0 で起こしてください:

```sh
CAPTURE_LEDGER_API_HOST=0.0.0.0 pnpm run api
```

コンテナ側が指す先は bridge100 の `http://192.168.64.1:7070` です ―― **ホスト名では
引けません**。capture-scheduler の `CAPTURE_LEDGER_API_URL` の既定がその値なので、通常は何も設定せずに
`pnpm run windmill:capture-ledger-token` を走らせるだけで揃います。外に出す以上、
前段の認証を確かめてから開けてください。
:::

## 7. クロールを起こす

取り込みはクロールとして起こします。段取りを決めるのは capture-ledger で、実際に投げるのは
Windmill の flow です。

```sh
curl -X POST http://127.0.0.1:7070/api/crawls \
  -H 'content-type: application/json' \
  -H "X-Capture-ledger-Subject: $(whoami)" -H "X-Capture-ledger-Organizations: acme" \
  -d '{"fromTargets":{"limit":1}}'
# → 202 { "crawlId": "9072b625-…" }
```

`fromTargets` は §4 で入れた行を種にします。既定は深さ 0 —— 取るだけで辿りません。
以前の `POST /api/runs` がしていたのはこれです。

:::caution[この段にはスケジューラ側のスタックが要ります]
`/api/crawls` は **`CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` と `CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN` の
両方が設定されているときにしか出ません**。capture-ledger はもう BrowserHive と直接
話さないので、投げる先が無ければ出す口も無く、route は `404` を返します。flow は
[capture-scheduler](https://github.com/uraitakahito/capture-scheduler) に居ます。ここより前の段は
それ無しで動きますが、取り込みだけは動きません。

`can_submit` にも注意してください。許可の無い呼び出し元にも `404` が返ります。
[アーカイブ台帳](/capture-ledger/ja/archive-ledger/#誰が起こしてよいか)を参照。
:::

## 8. 結果を見る

§6 の picker を読み込み直します。行をクリックすると
[replay](https://github.com/uraitakahito/replay) で開きます。
一覧は台帳（`archives` テーブル）から来ていて、**OpenFGA の `can_view` で
絞ってあります**。API を直に叩くこともできます。

```sh
curl -s -H "X-Capture-ledger-Subject: $(whoami)" -H "X-Capture-ledger-Organizations: acme" \
  http://127.0.0.1:7070/api/archives | jq '.archives[0]'
```

API の全体は[アーカイブ台帳](/capture-ledger/ja/archive-ledger/)に、クロール自体の
終わり方は `GET /api/crawls/<crawlId>` にあります。

### まだ終わっていないとき

**ページが台帳に載るのは、そのページの居た段を flow が報告した後**です。picker に
出てこないなら、段がまだ開いているか、そのページが失敗しています。走行中の取り込みに
問い合わせる口はありません —— 取り込みは 1 回の gRPC 呼び出しで、結果は呼んだ側
（Windmill の run）に返り、成果物の隣の `.result.json` manifest にも書かれます。
BrowserHive が答えるのは「いま busy かどうか」です。

```sh
grpcurl -plaintext -emit-defaults -import-path proto -proto browserhive/v1/capture.proto \
  localhost:50051 browserhive.v1.CaptureService/GetServerStatus \
  | jq '{busy, browser: .browser.url}'
```

`"busy": true` ならその browser はページの途中です。もう 1 つは `localhost:50052`。

成果物は同梱の SeaweedFS バケット (`browserhive`) に置かれます。命名規則や
WACZ の中身は BrowserHive のストレージのページにあります。

## 次に読むもの

- アーカイブを配る・共有する、クロール API の全体 → [アーカイブ台帳](/capture-ledger/ja/archive-ledger/)
- 自分の URL を追加する → [URL ソース](/capture-ledger/ja/url-source/)
- 何を撮るかを変える → [キャプチャオプション](/capture-ledger/ja/capture-options/)
- Compose を使わずに動かす → [開発環境](/capture-ledger/ja/development-environment/)
