---
title: クイックスタート
description: Compose スタックを立ち上げ、capture_targets を seed し、最初のクロールを起こすまで。
---

スタックは capture-ledger に必要なものを一式立ち上げます — Postgres、
headless の Chromium 2 台、そしてその 1 台ずつに付く BrowserHive
（[固定した submodule](/capture-ledger/ja/upgrading-browserhive/)からビルド）です。実行基盤は
[Apple Container](https://github.com/apple/container)で、`container-compose` が駆動します。

成果物を置く store（SeaweedFS）は**このスタックには入っていません** —— crawler の 3 つの
repo が共有する 1 つの store で、[seaweedfs](https://github.com/uraitakahito/seaweedfs) が
起こします（§3）。

## 1. DNS ドメインを登録する（マシンごとに 1 回）

```sh
sudo container system dns create capture-ledger
sudo container system dns create crawler-storage   # 共有 store のぶん
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
最初から入っていて、書き足すのは OpenFGA の 2 つの ID（§5）と、クロールを起こすときの
4 行（§7）だけです。`-n` は既にある `.env` を上書きしないための印で、書き写した値を守ります。

## 3. 共有 store とスタックを起動する

成果物を置く store は crawler で 1 つだけ立てます。まだ起きていなければ先に起こします
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
[アーカイブの消し方など](https://github.com/uraitakahito/seaweedfs/blob/main/docs/operations.ja.md)にあります。

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

自分のページを撮りたいときは、同じように足します。
`--org acme` は、§7 のクロールが名乗る組織です。こうすると、そのクロールから見えます。

```sh
pnpm run targets add https://example.com/ --org acme
```

CLI のほかの使い方（ファイルから読む、一覧、無効にする）は、
[URL ソース](/capture-ledger/ja/url-source/#url-を追加する)にあります。

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

開いたら、`subject` に自分の名前（`whoami` の出力）、
`organizations` に `acme`（§7 でクロールを起こすときに名乗る組織）を入れて、「読み込む」を押します。
**この時点では「見えるアーカイブが無い」と出るのが正常です** ——
一覧に行が増えるのは §7 のクロールの後です。画面の部品と、出る文の意味は、
[アーカイブを見る](/capture-ledger/ja/picker/)にあります。

欄が無く「この API には名乗りの設定が無く…（全員 401）」とだけ出るなら、`.env` の
`CAPTURE_LEDGER_DEV_IDENTITY=1` を確かめてください。無いと resolver が誰も通しません。

## 7. クロールを起こす

取り込みはクロールとして起こします。段取りを決めるのは capture-ledger で、実際に撮るのは
[capture-scheduler](https://github.com/uraitakahito/capture-scheduler) の Windmill の flow です。
**ここから先は capture-scheduler が要ります** —— ここより前の段はそれ無しで動きますが、
取り込みだけは動きません。

### 1 度だけ: capture-scheduler とつなぐ

つなぐ手順は [capture-scheduler のクイックスタート](https://uraitakahito.github.io/capture-scheduler/ja/quickstart/)に
まとめてあります（Windmill を立て、flow と proto を入れ、トークンを渡す）。その途中で、
capture-scheduler の `pnpm run windmill:bootstrap` が、この repo の `.env` に貼る **4 行をまとめて
出します。4 行とも `.env` の末尾に貼ります**（同じ名前の行が前にあっても、後ろの行が効きます ——
`.env.example` を写した `.env` には、`#` 付きの見本の行が前に在ります）。**どれが欠けても、
クロールは最後まで走りません。**

| 行                                                                         | なぜ要るか                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL`<br>`CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN` | クロールを投げる先。無いと `/api/crawls` そのものが無く、`404` になります                                                                                                          |
| `CAPTURE_LEDGER_API_HOST=0.0.0.0`                                          | flow は段ごとの結果を API に報告し、その報告は**コンテナから**来ます。`127.0.0.1` のままでは届きません                                                                             |
| `CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099`                         | flow は JWT で名乗ります。API が受けるのは JWT か開発用ヘッダの**どちらか一方**で、この行を書くと JWT になります —— picker も、名乗りの 2 欄の代わりにトークンの欄を出します（§8） |

貼ったら、issuer（`pnpm run oidc:issuer`）を起こし、API を起こし直します。設定は起動のときに
1 度だけ読みます。API の起動ログの最後の行が `crawl level reports: ready` なら、4 行は効いています。
`blocked` なら、その上の warn が足りない行を名指しします
（[起動ログで確かめる](/capture-ledger/ja/development-environment/#起動ログで確かめる)）。
capture-scheduler のクイックスタートの最後にある `pnpm run doctor` が全部 ✓ なら、つながっています。
続く `pnpm run smoke` が 1 本撮って確かめます。

つないだ後は、毎日 04:00（日本時間）にも Windmill が `acme` の有効な行を全部撮ります
（[いつ走るか](https://uraitakahito.github.io/capture-scheduler/ja/schedule/)）。

### 起こす

JWT で名乗ります。§6 のヘッダは、JWT の設定の API には効きません。

```sh
pnpm run fga:grant submitter "$(whoami)" acme   # 1 度だけ。無いと 404
TOKEN=$(pnpm run --silent oidc:token --subject "$(whoami)" --org acme)
curl -X POST http://127.0.0.1:7070/api/crawls \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"seeds":["https://example.com/"],"maxDepth":0}'
# → 202 { "crawlId": "9072b625-…" }
```

`seeds` は種を名指しします。既定はリンクを 2 段まで辿ることで、`maxDepth: 0` でそのページだけを取ります。

§4 で入れた行を種にするなら `-d '{"fromTargets":{}}'` です。既定は深さ 0 —— 取るだけで辿りません。
以前の `POST /api/runs` がしていたのはこれです。行は足した順（`id` 順）に種になるので、
`{"fromTargets":{"limit":1}}` はいつもサンプルの 1 行目で、§4 で足した URL ではありません。

クロールがどう終わったかは、同じヘッダで `GET /api/crawls/<crawlId>` に訊きます。落ちたなら `error` に
「[段] 文」が、取れなかったページは `failures` に理由つきで、最後に投げた段の Windmill の run は
`lastJob` に出ます（`http://127.0.0.1:8000/run/<lastJob.id>?workspace=crawler` で開けます）。

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/crawls/<crawlId> \
  | jq '{state, pagesCaptured, error, lastJob, failures}'
```

:::caution[404 は 2 通りあります]
本文が `Route POST:/api/crawls not found` なら route が無い（webhook の 2 行が無い）、
`{"error":"not found"}` なら呼び出し元に `can_submit` が無い（`fga:grant submitter` が無い）です。
同じトークンで `GET /api/me` を訊くと、`canSubmit` がその答えです。
[アーカイブ台帳](/capture-ledger/ja/archive-ledger/#誰が起こしてよいか)を参照。
:::

## 8. 結果を見る

一覧は台帳（`archives` テーブル）から来ていて、**OpenFGA の `can_view` で
絞ってあります**。§7 と同じ token で API を直に叩けます。

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/archives | jq '.archives[0]'
```

picker で見るなら、§7 と同じ名乗りのトークンを画面に貼ります。API の設定は変えません。

```sh
pnpm run --silent oidc:token --subject "$(whoami)" --org acme | pbcopy
open http://127.0.0.1:7070/
```

§7 で 4 行を貼った API は JWT の設定なので、picker は §6 の 2 つの欄の代わりに「トークン」の欄を出します。
貼って「読み込む」を押すと、一覧の上に「（`whoami` の出力）（acme）として見ている」と出て、
§7 のクロールが撮ったページが並びます。トークンは 1 時間で切れます。
「401 — このトークンは通らない…」と出たら、同じコマンドで取り直して貼ります
（[アーカイブを見る](/capture-ledger/ja/picker/#3-手で使うjwt-の設定)）。

行をクリックすると、別のタブで [replay](https://github.com/uraitakahito/replay) が開きます。
replay はまず、その WACZ に入っているページの一覧を出します
（WACZ は Web Archive Collection Zipped —— 取り込んだ 1 ページをまとめたファイルです）。
**題名をクリックすると、再生が始まります。**

API の全体は[アーカイブ台帳](/capture-ledger/ja/archive-ledger/)にあります。

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

### 409 が続くとき

走行中のクロールは 1 本だけで、2 本目は `409` です。**段の報告が API に届かなかったクロールは
`running` のまま残り、以後の起動を全部 `409` で塞ぎます** —— API が `127.0.0.1` で待っていた、
宛先の IP が古かった、走っている間に JWT の設定を外した、などです。塞いでいる 1 本は `409` の
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

- アーカイブを配る・共有する、クロール API の全体 → [アーカイブ台帳](/capture-ledger/ja/archive-ledger/)
- 自分の URL を追加する → [URL ソース](/capture-ledger/ja/url-source/)
- 何を撮るかを変える → [キャプチャオプション](/capture-ledger/ja/capture-options/)
- Compose を使わずに動かす → [開発環境](/capture-ledger/ja/development-environment/)
