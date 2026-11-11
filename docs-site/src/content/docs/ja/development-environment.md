---
title: 開発環境
description: 前提・日々のコマンド・Compose を使わない実行・トラブルシュート。
---

## 前提

- **Node.js 26** (`.nvmrc` のバージョン)。nvm があれば `nvm use`。
- **pnpm 11** — `packageManager` が固定している版。Node 25 から corepack が同梱されないので、`npm i -g corepack` の後に `corepack enable` で入る。
- **[Apple Container](https://github.com/apple/container)** と **container-compose**
  （どちらも Homebrew）— スタックに必要。ホストだけの開発には不要。macOS 専用です。
- **`curl`** と **`git`** が PATH にあること。
- `DATABASE_URL` で届く **Postgres**。Compose スタックが立ち上げます。
- 実際に取り込むには **BrowserHive** と、それを回す Windmill の flow。capture-ledger は
  もう BrowserHive の在り処を持たず、`CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` へ投げるだけです。
  flow は [capture-scheduler](https://github.com/uraitakahito/capture-scheduler) に居ます。スタックが今も
  BrowserHive を build するのは flow が要るからで、固定バージョンは
  [BrowserHive の更新](/capture-ledger/ja/upgrading-browserhive/)を参照。

## 初回セットアップ

```sh
git clone https://github.com/<you>/capture-ledger.git
cd capture-ledger
nvm use
pnpm install
sudo container system dns create capture-ledger   # マシンごとに 1 回
git submodule update --init --recursive           # 上流のソースを .upstream/ に
cp -n .env.example .env                           # 設定の雛形をそのまま写す
pnpm run check       # push の前に走らせる検査の全部（中身は package.json の check）
```

スタックは `container-compose` を直接叩かず、`pnpm run stack:up` で起動してください。
起動の前に、道具と `capture-ledger` DNS ドメイン、すべての build context が指す
`.upstream/` の submodule、そして**共有 store が起きているか**を確かめ、足りなければ
名前を挙げて止まります。

成果物を置く store（SeaweedFS）は、このスタックには入っていません。[Web Capture](https://uraitakahito.github.io/capture-ledger/ja/#web-capture) の repo が
共有する 1 つの store（`seaweedfs.crawler-storage`）で、submodule から起こします:

```sh
sudo container system dns create crawler-storage   # マシンごとに 1 度だけ
sh .upstream/seaweedfs/scripts/stack.sh up
```

中身を消す・見る・store ごと作り直す手順は、
[seaweedfs の運用ガイド](https://uraitakahito.github.io/seaweedfs/ja/operations/)
に 1 つだけ置いてあります（この repo の bucket を空にするだけなら `pnpm run store:wipe`）。

### 環境変数

コードが読む環境変数は、読み取りの仕組みが 3 つに分かれています。
`src/config/` の `required()`/`optional()`、commander の `.env()`（こちらは
`--help` にも出ます）、そして素の `process.env[…]`（これは `scripts/` にもあります）。
数は `pnpm run check-env` が数えて出します。必須のものは `src/config/env.ts` の `REQUIRED_ENV` に並んでいます。

一覧は `.env.example` の 1 か所だけで、`.env` はその写しです（`cp -n .env.example .env`）。
値を調べて `.env` を作るものはありません —— 一覧が 2 つあれば必ずずれるからです。
OpenFGA の 2 つの ID は、走らせてみないと決まらないので雛形には名前しかありません
（`pnpm run fga:deploy` が `.env.local` に書きます。
[アーカイブの記録](/capture-ledger/ja/archive-ledger/#セットアップ)を参照）。

`src/tools/check-env.ts`（`pnpm run check` に含まれ、CI では独立したステップ）が、
コードの読み取りと `.env.example` の宣言を両方向で突き合わせます。古い雛形は
雛形が無いより悪い —— 信用して使われるので、足りないときに疑う先が残りません。

### 設定のファイルは 2 枚ある

実行系の script は `.env` と `.env.local` を**この順で** node に渡します
（`--env-file-if-exists` を 2 つ）。**後に渡したほうが勝つ**ので、同じ名前が両方に
在れば `.env.local` の値が効きます。

| ファイル     | 持ち主 | 中身                                                   |
| ------------ | ------ | ------------------------------------------------------ |
| `.env`       | 人     | `.env.example` の写し。**手で直すのはこちらだけ**      |
| `.env.local` | 道具   | 走らせてみないと決まらない値。git は無視する（生成物） |

`.env.local` に書く道具は、`pnpm run fga:deploy`（OpenFGA の store id と model id）、
`pnpm run connect`（capture-scheduler が渡す行 —— クイックスタート §7）、
`pnpm run idp:bootstrap`（手元の IdP —— Identity Provider、身元を証明するサービス —— の issuer と client の ID。クイックスタート §7）、
`pnpm run search:connect`（OpenSearch が答えた後の宛先 —— クイックスタート §3）です。
分けてあるのは持ち主が違うからで、道具が人の書いた行を並べ替えたり消したりすると、
次に何が起きたのか追えなくなります。

**どちらが勝っているかは、API の起動ログの 1 行目が言います**:

```text
config: .env (16 names), .env.local (6 names) — .env.local wins for CAPTURE_LEDGER_FGA_STORE_ID, … (a value set in the shell beats the files)
```

「`.env` を直したのに効かない」ときは、この行に名前が出ていないかを見ます。出ていれば
`.env.local` が勝っています。古い `.env.local` を疑うなら **作り直すのがいちばん速い** ——
`fga:deploy` も `connect` も `search:connect` も、何度打っても構いません。

この行が出すのは**名前だけで、値は出しません**。token が混じるうえ、出どころの説明に
値は要らないからです。端末で渡した値は、どちらのファイルにも勝ちます。

### 空文字は「値が無い」とは別の状態

`.env` に `FOO=` と書くと `FOO` は空文字になります。行ごと無ければ未設定です。
この 2 つは別の状態で、POSIX はそれぞれに別の記法を与えています ——
`${FOO:-default}` は両方で既定値に落ち、`${FOO-default}` は未設定のときだけです。

この repo は前者に揃えてあります。**空文字は「無い」と同じ意味**です。env は
`optional()`（または `need()`）で読み、`process.env[…] ?? default` は使いません
—— それは後者の意味で、空文字をそのまま値にしてしまいます。

そして「空で設定されている」はほぼ必ず打ち間違いなので、`src/config/env.ts` の
起動時検査は**黙って既定値に戻さず、名前を挙げて止まります**。これには理由があって、
空文字は「無い」より厳密に悪い状態でした —— `DATABASE_URL=` は commander の必須
チェックを通り、API は起動し、`/healthz` は 200 を返し、最初のクエリで
`DATABASE_URL` という語を一度も出さない SASL エラーになっていました。

そのため `.env.example` の行は 3 種類しかありません。

```sh
NAME=value     # 値を渡す
#NAME=value    # 既定値を見せるだけ（使うならコメントを外して値を書く）
#NAME=         # 起動前には値が決まらないもの（道具が .env.local に書く）
```

生の `NAME=` を書けるのは**必須のもの（`REQUIRED_ENV`）だけ**です。必須の空は `collectEnv` が
「不足」として報告します。この規則も `src/tools/check-env.ts` が検査しています。

## 日々のコマンド

| コマンド                                  | 内容                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run dev:up`                         | 立ち上げの段を順に。`--dry-run` で一覧、`--from <段>` で途中から。                                                                                                          |
| `pnpm run dev:status`                     | いま何が立っているか。**何も変えない。**                                                                                                                                    |
| `pnpm run dev:down`                       | ホストで動かしたもの → 両 repo のコンテナ（OpenSearch も）。共有 store は落とさない。                                                                                       |
| `pnpm run api`                            | ビルドしてから API を実行 (`tsc` → `node dist/api/server.js`)。                                                                                                             |
| `pnpm run build`                          | `tsconfig.build.json` で `dist/` に JS/d.ts を出力。                                                                                                                        |
| `pnpm run typecheck`                      | `tsc --noEmit`。テストと `*.config.ts` も含む。                                                                                                                             |
| `pnpm run lint` / `lint:fix`              | ESLint flat config (typescript-eslint recommendedTypeChecked)。                                                                                                             |
| `pnpm run format` / `format:check`        | Prettier。`.prettierignore` が `dist/` と `src/rpc/generated/` を除外。                                                                                                     |
| `pnpm test` / `test:watch`                | `test/` 配下の Vitest ユニットテスト。                                                                                                                                      |
| `pnpm run audit`                          | 既知の脆弱性 (`pnpm-lock.yaml`)。CI では毎日も走る。                                                                                                                        |
| `pnpm run check`                          | push の前に走らせる検査の全部。中身と並びは package.json の `check`（CI の check job は、ほかの job が持つ検査を除いて走らせる。除く物は `src/tools/check-ci-parity.ts`）。 |
| `pnpm run db:migrate` / `db:migrate:down` | `DATABASE_URL` に対する Kysely マイグレーション。                                                                                                                           |
| `pnpm run scripts`                        | ページで走らせるスクリプト（`scripts`）を取り込む・足す・見る・読む・外す・消す。受け皿の型（`host_types`）も出す。DB に直接書く。                                          |
| `pnpm run openapi:generate`               | 固定した submodule から BrowserHive の `openapi.json` を取り直し、型を再生成 (openapi-typescript)。                                                                         |
| `pnpm run openapi:check`                  | 型を再生成して `git diff --exit-code` (CI のドリフト検査)。                                                                                                                 |
| `pnpm run openapi:sync`                   | 固定した submodule から `openapi.json` を取り直すだけ。                                                                                                                     |
| `pnpm run site:dev` / `site:build`        | このドキュメントサイト。                                                                                                                                                    |
| `pnpm run site:check`                     | サイトをビルドし、参照の整合を検証。                                                                                                                                        |
| `pnpm run docs:shots`                     | docs に載せる画面の絵を撮り直す (スタックは要らない)。                                                                                                                      |

### ホストで動くもの

スタックに入っていないものがあります。**`pnpm run api` (7070)・[wacz-validator](https://github.com/uraitakahito/wacz-validator) の
daemon (7180)・[capture-workbench](https://github.com/uraitakahito/capture-workbench) の
`pnpm run dev` (7080) はホストのプロセス**で、コンテナではありません。

検証の daemon には **store の鍵を渡していません**。読むのは capture-ledger が署名した URL
だけなので要らず、渡せば「鍵を持つ相手を増やさない」という選択の意味が消えます。
daemon の既定の port は `0`（OS 任せ）なので、`--port 7180` で固定してあります ——
固定しないと下の 2 つが見つけられません（どちらも port から持ち主を引くため）。

daemon は **自分で建て直りません**。wacz-validator を出しても、7180 は起こした時の
build のまま動き続けます（2026-09-26 に見たとき、v0.28.1 が 2 日動いていて、その間に
出た v0.29.0・v0.30.0 の rule はどれも workbench に出ていませんでした）。`pnpm run dev:status` が、
動いている build（`/healthz` が名乗る commit）を wacz-validator の checkout の HEAD と
比べます。違えば、checkout が先に進んだのか（古い build）、それ以外か（違う build）を言い、
起こし直す 1 行を添えます。

workbench が 7000 ではなく **7080** なのは、macOS の ControlCenter (AirPlay Receiver) が
`*:7000` を握っているためです（実測）。`127.0.0.1:7000` に bind できてしまうので
気づきにくいのですが、port から持ち主を引く下の道具が毎回「別のものが握っている」と
言うことになります。

だから **`container-compose down` では消えません**。2026-09-20 に
`EADDRINUSE: address already in use 127.0.0.1:9099` で止まったのはこれで、前の日に
別のターミナルで起こした開発用の issuer（当時はホストで動いていました）が残っていました。スタックを落としたのに港が
塞がっている、という形で出ます。

```sh
pnpm run dev:status   # pid・起動時刻・port。validator は動いている build も。何も変えない
pnpm run dev:down     # ホストで動かしたもの → 両 repo のコンテナ
```

`dev:down` は **port を持っている相手が自分のものか** を先に確かめます —— コマンド行が
この repo の entry を動かしていて、かつプロセスの cwd がこの repo の根であること。
違えば **止めずに名指しします**（番号は使い回されるので、port から引いた PID を
そのまま kill してはいけません）。

## スタックで作業する

```sh
pnpm run stack:up
# 準備完了の判定は GET /status (BrowserHive の HTTP API)。
# browserhive-2 も同じ (localhost:50052)。
until curl -fsS http://localhost:50051/status >/dev/null 2>&1; do sleep 1; done
```

capture-ledger のコマンドは、この repo の端末でそのまま打ちます。
capture-ledger はホストで動き、
スタックが `127.0.0.1` に publish したポートを通してコンテナ側に繋がります。
接続文字列は雛形に入っているので、写した `.env` にそのまま在ります。

```sh
DATABASE_URL=postgres://capture_ledger:capture_ledger@127.0.0.1:5432/capture_ledger
```

:::danger[ホストからコンテナの名前を使わない]
platform DNS は `<service>.capture-ledger` をホストからも解決します —— しかし
**引けることと届くことは別**です。macOS 26 は Apple 署名でないバイナリ（`node` を含む）が
コンテナの subnet へ TCP を張るのを止めるので、名前は引けた上で `EHOSTUNREACH` になります。
`/usr/bin/curl` は Apple 署名なので**通ってしまい**、切り分けを誤らせます ——
同じ URL が curl では答え、node では落ちます。システム設定にこのノブはありません
（`node` は一覧に載りません）。

**コンテナの中で**動くもの（BrowserHive など）は名前のままで構いません。
コンテナ同士の通信は、この制限に当たりません。
:::

BrowserHive の在り処はもうここにありません。スタックが公開している 2 つの HTTP の
エンドポイント `localhost:50051` と `localhost:50052`（Chromium 1 台に BrowserHive 1 つ）は、
curl と flow のためのもので、capture-ledger のためではありません。

capture-ledger は **ts-compile-service** を呼びます。このスタックには無く、capture-scheduler の compose が
動かして、host の `127.0.0.1:28080` に出しています（capture-scheduler v0.28.0 から）。宛先は、
capture-scheduler の `windmill:bootstrap` がほかの行と一緒に渡し（capture-scheduler v0.30.0 から）、
`dev:up` の段の `pnpm run connect` が `.env.local` に `CAPTURE_LEDGER_TS_COMPILE_URL=http://127.0.0.1:28080` を
書きます。これで `GET /api/crawls/:id/diagnostics` が出ます。手で書くのは、`dev:up` を使わずに API を起こす
ときだけです。宛先は capture-scheduler の `pnpm run doctor` が見ます（`host→ts-compile`）。

Claude に直し方を訊くエンドポイント（`POST /api/crawls/:id/inline/:name/fix`）には、Anthropic の Console の API の鍵も
要ります（`CAPTURE_LEDGER_ANTHROPIC_API_KEY`）。`.env` にだけ書き、commit しません。SDK が自分で読む
`ANTHROPIC_API_KEY` は読みません。鍵があって ts-compile の宛先が無いと API は起動で止まるので、`dev:up` で
起こします（`dev:up` を使わないなら、宛先も書く）。`pnpm run fix:eval` は、決めた見本（型の誤りのある TS）を本物の
ts-compile-service と Claude で直させて測ります。**お金が掛かります**（見本ごとと合計の費用を出します）。
CI では走りません。`pnpm run change:eval` は、前回からの変化の要約を見本の差分（作った文と首相官邸の数行）で
測ります（Claude を 2 回。同じくお金が掛かり、CI では走りません）。

`pnpm run` 系のコマンドはこの `.env` を自分で読みます
（`node --env-file-if-exists=.env`）。シェルで `export` する必要はありません。
**すでに環境にある変数のほうが優先される**ので、一時的に別の DB を向きたいときは
`DATABASE_URL=... pnpm run db:migrate` と前置きすれば効きます。`node dist/...` を
直接叩く場合は読まれないので、そのときは自分で渡してください。

Postgres は `127.0.0.1:5432` にも公開しているので `localhost` でも繋がります。

Docker Compose から来た場合、日常のコマンドはこう対応します。

| Docker Compose                      | このスタックでは                              |
| ----------------------------------- | --------------------------------------------- |
| `docker compose up -d --build`      | `pnpm run stack:up`                           |
| `docker compose down`               | `pnpm run stack:down`                         |
| `docker compose ps`                 | `container ls`                                |
| `docker compose logs browserhive-1` | `container logs browserhive-1.capture-ledger` |
| `docker compose exec <svc> sh`      | `container exec -it <svc>.capture-ledger sh`  |
| `docker compose run --rm <svc> …`   | `container run --rm <image> …`                |

起動と停止だけ `container-compose` ではないのは、`scripts/stack.sh` が渡すものが 3 つあるから
です —— 署名の profile と env ファイルの対、submodule の版（渡らないで建った image は
BrowserHive が起動を拒みます）、そして起動の前の点検です。

Chromium は 2 台とも **headless** です。描画を見たいときは、ローカルの Chrome で
`chrome://inspect` を開き、_Configure…_ に `localhost:9222` と `localhost:9223`
を登録してターゲットを inspect します。

## 本番イメージ

`Dockerfile` は API のイメージを建てます。CI は変更のたびにこれを建て、1 度起動します。`DATABASE_URL` だけを渡すと、
足りない変数を名指しする文で止まらなければなりません。これで、イメージがアプリケーションまで起動することが分かります。

`dev:up` はこのイメージを使いません。API を host で動かすからです。取り込みの経路は、`pnpm run dev:up` と
capture-scheduler の `pnpm run smoke`・`pnpm run test:e2e` で確かめます。

## 外部の Postgres に対して動かす

```sh
DATABASE_URL=postgres://user:pass@db.host:5432/capture_ledger \
  pnpm run db:migrate

DATABASE_URL=postgres://user:pass@db.host:5432/capture_ledger \
CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=https://windmill.example/api/w/…/jobs/run/f/f/waggle/crawl_level \
CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=… \
  pnpm run api
```

webhook の URL の `…` は Windmill の workspace の id です（同梱の構成なら `crawler`）。
末尾の `f/waggle/crawl_level` は flow のパスで、決めているのは capture-scheduler です。
**名前が違っていても API は起動し、`POST /api/crawls` も `202` を返します。**
分かるのはその後で、クロールが `failed` になり、
API のログに `crawl webhook → 404 Not found: flow not found` が出ます。

Postgres の TLS は `DATABASE_URL` にパラメータを書きます (例: `?sslmode=require`)。

**BrowserHive の TLS はもうここで設定しません。** そのチャンネルを持っているのは
flow なので、CA は Windmill 側の変数 `u/admin/browserhive_tls_ca` に置きます
（空文字なら平文）。

## マイグレーション

マイグレーションは `src/db/migrations/<NNN>-<説明>.ts` に置き、`up(db)` /
`down(db)` を export します。ランナーは Kysely の `Migrator` +
`FileMigrationProvider` の薄いラッパで、適用済み ID を `kysely_migration`
テーブルで管理します (同時実行は `kysely_migration_lock` が守ります)。最新の状態で
`pnpm run db:migrate` を再実行しても何も起きません。

```sh
pnpm run db:migrate       # 適用
pnpm run db:migrate:down  # 直前の 1 つを巻き戻す
```

追加するときは:

1. フォルダの最後のファイルの次の連番を取る (例 `<NNN>-add-priority.ts`)。
2. スキーマビルダで `up` / `down` を実装する。ビルダで書けないもの (拡張、生成列、
   他カラムを参照する `CHECK`) は ``sql`…`.execute(db)`` を使う。
3. ローカルで往復させる:
   `pnpm run db:migrate && pnpm run db:migrate:down && pnpm run db:migrate`。
   CI も同じ往復を実行します。
4. マイグレーションと、それに依存するコードは同じ PR でコミットする。

作った物が無くなっても、古いマイグレーションのファイルは残します。適用済みの DB では、ファイルを消すと
Kysely が `corrupted migrations` で止まります。表を消すなら、落とすマイグレーションを足します。

## ローカルで身元を用意する

身元の入口は API の 1 つだけで、**既定では全員を拒みます。**

| 経路                 | 既定 | 開発用ヘッダ                    | JWT                          |
| -------------------- | ---- | ------------------------------- | ---------------------------- |
| API (`/api`, picker) | 拒否 | `CAPTURE_LEDGER_DEV_IDENTITY=1` | `CAPTURE_LEDGER_OIDC_ISSUER` |

以前は CLI の行がもう 1 つあり、環境から `CAPTURE_LEDGER_DEV_SUBJECT` と
`CAPTURE_LEDGER_OIDC_TOKEN` を読んでいました。その 2 つは、読む側の CLI ごと畳んだときに
`.env.example` からも消えています。**主体を名乗るのは投げる側の仕事**になりました。

**JWT の経路が開発用ヘッダより優先されます。** 両方設定された環境で、
そのポートに届く者が誰にでもなれるほうへ落ちてはいけないためです。
picker は、API がどちらで起きたかに合わせて欄を変えます —— 開発用ヘッダなら名乗りの 2 欄、
JWT ならトークンの欄です（[アーカイブを見る](/capture-ledger/ja/picker/)）。

### 開発用の IdP（Floci）

`CAPTURE_LEDGER_OIDC_ISSUER` を設定すると、API は **本番と同じ検証コード** を通ります
—— 署名、`iss` の照合、有効期限、JWKS（JSON Web Key Set。`<iss>/.well-known/jwks.json` に在る公開鍵）の取得。
そのうえで 2 つを確かめます。`token_use` が `access` であること（ID token は断ります）と、
`client_id` が `CAPTURE_LEDGER_OIDC_CLIENT_IDS` に在ることです。`aud` は照らしません。
Cognito の access token は `aud` を持たず、M2M（machine-to-machine。client credentials で取る機械の
トークン）は持てないからです。ISSUER が在って CLIENT_IDS が空なら、API は起動しません。

本番の IdP は Amazon Cognito です。
手元では Cognito を真似る [Floci](https://github.com/floci-io/floci) が代わりを務めます。
compose のサービス `idp` で、`127.0.0.1:4566` に出ています（コンテナからは `http://idp.capture-ledger:4566`）。
`pnpm run dev:up` は段 `idp` と `grant` でこれを用意します。手で打つなら次のとおりです。

```bash
pnpm run idp:bootstrap                 # プール・app client・自分の利用者を作り、.env.local に書く
pnpm run idp:grant                     # windmill の client と自分の利用者に acme の submitter
pnpm run api                           # 起こし直す。.env.local は起動のときに 1 度だけ読む
TOKEN=$(pnpm run --silent idp:token)
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/crawls
```

`idp:bootstrap` が作るのは、プール `capture-ledger-dev`、resource server `capture-ledger` と
scope `crawl`、群 `acme` と、その群に入れた `$(whoami)` の名前の利用者（群の名前が組織の名前です）、
それに次の app client です。

| app client  | 種類   | 使うもの                                                                                                                |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `workbench` | public | capture-workbench。authorization code と PKCE（Proof Key for Code Exchange）。戻り先は `http://127.0.0.1:7080/callback` |
| `cli`       | public | `pnpm run idp:token`（パスワードの流れ）。picker や `curl` に貼るトークン                                               |
| `windmill`  | secret | capture-scheduler のクロールの flow（client credentials）                                                               |

書くのは、`.env.local` の `CAPTURE_LEDGER_OIDC_ISSUER`（`http://127.0.0.1:4566/<プールの ID>`）と
`CAPTURE_LEDGER_OIDC_CLIENT_IDS`（**手で書きません**。プールの ID が `iss` に入るためです）、
それに引き渡しファイル `.dev/idp.env`（client の ID・windmill の secret・利用者のパスワードと `sub`）です。
引き渡しファイルは capture-scheduler の `windmill:capture-ledger-token` が読みます。
打ち直すと、在るものを使い回します。

トークンは `.env` に置きません —— 読むのは受け取る側の API で、投げる側が
`Authorization` ヘッダに載せるものだからです。

**主体は名前ではなく `sub` です。** 人の `sub` は Floci が付けた ID で（Cognito も同じです）、
機械の `sub` はその app client の ID です。OpenFGA の許可も `owner` tuple もこの値で書くので、
`idp:grant` は名前に許可を与えず、引き渡しファイル（と Floci）から `sub` を読みます。`idp:token` は利用者・`sub`・群を
標準エラーに出します。別の利用者のトークンは `pnpm run --silent idp:token --user 名前 --org 群` で取ります
（無ければ作ります。`--org` は繰り返せます）。その利用者がクロールを始めるには、
`pnpm run idp:grant --user 名前` を打ちます（無ければ作り、`acme` に入れ、その `sub` に許可を与えます）。

組織は `cognito:groups` のクレームから来ます。**機械のトークンには群が載りません**。
そこで `sub` が `client_id` と同じトークンには、OpenFGA でその主体に `can_submit` がある組織を
API が引きます（`src/api/authorization.ts` の `submitterOrganizations`）。windmill の client のトークンで始めたクロールの
owner は `user:<windmill の client の ID>` になり、そのアーカイブを人が消せなくなる状態です ——
認可の設計の穴を、ここで踏めます。

:::caution[開発用です]
Floci の管理の API は、既定の鍵（`test`/`test`）を条件なしに通します。Floci に届くものは、
誰でも利用者を作り、そのトークンを取れます。手元のスタックの中の心配として受け入れています。
ホストへは `127.0.0.1` にだけ出しています。

Floci はプールを**メモリに**持ちます。コンテナが作り直されると（`stack:up` など）プールが消え、
`iss` が替わり、前のトークンはどれも通らなくなります。`stack:up` だけを打ったときは
`pnpm run dev:up --from idp` を打ちます。`pnpm run dev:status` の IdP の行が、Floci が答えるかと、
`.env.local` のプールがまだ在るかを言います。
:::

### 本番の Cognito へ移るとき

変わるのは `CAPTURE_LEDGER_OIDC_ISSUER`（`https://cognito-idp.<region>.amazonaws.com/<プールの ID>`）と
`CAPTURE_LEDGER_OIDC_CLIENT_IDS` の値だけです。`jwtIdentityResolver` は 1 行も変わりません。
プール・app client・群は AWS の側で作ります。`idp:bootstrap`・`idp:token`・`idp:grant` は Floci 専用です。

ただし **JWKS を HTTP で取ってくる経路は単体試験では守れません**。
`createRemoteJWKSet` をローカルの鍵に差し替えても試験は緑のままです。そこで CI の job `idp` が
Floci を立て、Floci が実際に出したトークンを、本番と同じ取り方の鍵で確かめます（`test/idp-floci.test.ts`）。
本物の Cognito での往復は、本番の前に 1 度通します。

組織のクレームの綴りは `cognito:groups` で、Cognito も Floci も同じです。
綴りを持つのは `src/config/identity.ts` の `ORGANIZATIONS_CLAIM` 1 か所だけです ——
API は `identityFromClaims` を通してそこを読みます。

### 起動ログで確かめる

API は起動したときに、**最後の 1 行**で待ち受けのアドレス・名乗り方・クロールの段の報告を
受けられるかを言います（`src/api/startup-notes.ts`）。

```text
Archive API listening on 0.0.0.0:7070 — identity: JWT (http://127.0.0.1:4566/us-east-1_example); crawl level reports: ready
```

| `crawl level reports` | 意味                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ready`               | 段の報告を受けられる —— コンテナから届くアドレスで待ち、JWT を受ける                                                                                         |
| `blocked`             | 受けられない。その上の warn が、足りない行を名指しする（`CAPTURE_LEDGER_API_HOST=0.0.0.0` と `CAPTURE_LEDGER_OIDC_ISSUER`）。クロールは `running` のまま残る |
| `off`                 | クロールのエンドポイントが無い（webhook の 2 行が無い）                                                                                                      |

warn はほかに 3 つあります。名乗りの設定がどちらも無い（全員 `401`）、開発用ヘッダを信じる API を
`127.0.0.1` 以外で待たせている（そのポートに届く誰もが、誰にでもなれる。picker も同じ判定で、
画面の上に赤い注意を出します）、受け取り先が在るのに
`127.0.0.1` で待っている（BrowserHive のコンテナから `PUT` が届かない）。`CAPTURE_LEDGER_DEV_IDENTITY=1`
の警告は、ヘッダが実際に効いているときだけ出ます —— JWT の設定では「無視される」と info で言います。

## トラブルシュート

- **コンテナが上がらない** — `container ls` で起動状況、
  `container logs <svc>.capture-ledger` で理由を見る。Chromium なら
  `curl http://localhost:9222/json/version` で CDP の応答を確認。
- **名前が解決しない** — `container system dns ls` に `capture-ledger` があるか、
  `docker-compose.yml` のどのサービスにも `container_name:` が無いか
  （付けると DNS 命名が抑止される）を確認。
- **BrowserHive が起動直後に落ちる** — 起動時の `HeadBucket` は fatal です。
  サービスに `WAIT_FOR_S3` が設定されているか、SeaweedFS が
  `Bucket browserhive ready.` を出しているか確認してください。
- **`/api/crawls` が誰に対しても 404 を返す** — 呼び出し元に `can_submit` が
  無いか、`CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` が未設定で route がそもそも登録されて
  いないかのどちらかです。どちらかは起動時のログが言います
  （`… is not set — /api/crawls is not served`）。
- **クロールが `running` のまま残る（段の報告が届かない・`401`）** — API の起動ログの最後の行が
  `crawl level reports: blocked` なら、その上の warn が足りない行を名指しします
  （[起動ログで確かめる](#起動ログで確かめる)）。古いトークンは、起動ログが `crawl level reports: ready` でも `401` になります。
- **docs のビルドが BrowserHive のピンを読めない** —
  `git submodule update --init --recursive` を実行。

### 自分の持ち物をクロールする

スタックには取り込み対象のフィクスチャ [capture-fixtures](https://github.com/uraitakahito/capture-fixtures) が
profile 付きで入っている。見知らぬサイトに向けずにクロールを試せる:

```sh
pnpm run stack:up --profile capture-fixtures capture-fixtures
```

サービス名を付ける。無いと `stack:up` はスタックの全部のコンテナを作り直す。

宛先は 2 つある。コンテナ（取り込む BrowserHive）からは名前の `capture-fixtures.capture-ledger:8080` で、起点の
URL もこちらで書く。host からは `127.0.0.1:18085` に publish してある —— macOS 26 は Apple 署名でないバイナリ
（`node` を含む）がコンテナの subnet へ繋ぐのを止めるので、host の道具（e2e・doctor）は名前では届かない
（[スタックで作業する](#スタックで作業する)）。
起点にするのは `/links/hub` —— `/links/*` はどれもそのページを 1 か所だけ変えたもので、
それが「誤った規則を適用しているクローラ」と「単に壊れているクローラ」を分ける。

capture-fixtures はリクエストログも持っていて、**それを使うことがこのフィクスチャの要点**:

```sh
curl -s http://127.0.0.1:18085/__request-counts
```

`crawl_pages` が言うのは capture-ledger が**記録した**こと、ログが言うのはフィクスチャが
**実際に要求された**こと。「robots を尊重した」は後者でしか決着しない —— 記録に無い
ページは、取りに行かなかったのか、取りに行って捨てたのか、記録からは区別できない。

capture-fixtures は `.upstream/browserhive` 経由ではなく `.upstream/capture-fixtures` に**直接** vendor して
いる。2 つの pin は別々の都合で動く —— capture-ledger の試験が要る頁（`/links/*` など）が BrowserHive の pin に入るとは
限らず、経由すると BrowserHive の版上げを待つことになる。どちらももう一方を待つ理由が無い。

### 署名を試す

署名には 2 つのことが同時に要ります —— `wacz-signer` と `tsa` が起きていること、
BrowserHive が署名の宛先を知っていること。**1 行で両方が立ちます。**

```sh
# .env
CAPTURE_LEDGER_CAPTURE_SIGNING=1
```

`pnpm run stack:up` がこの行を読み、`--profile signing`（wacz-signer と tsa を起こす）と
`--env-file signing.env`（BrowserHive に宛先を渡す）を足します。何を足したかを印字するので、
wacz-signer が起きている理由が分からなくなることはありません。

**片方だけを渡す道はありません。**そこが眼目で、以前は設定が互いを知らない 3 か所に
分かれていました —— `.env` の旗、profile、そして `docker-compose.yml` に直書きされた
`BROWSERHIVE_SIGNING_*` の 4 つ。profile を起こさずに署名を on にすると、取り込みが全部
`ENOTFOUND wacz-signer.capture-ledger` で落ちました。**DNS の誤りに見えますが、そうではありません** ——
名前は正しく、サービスが起きていなかっただけです。

署名の設定を `docker-compose.yml` へ戻すことはできません。空にしても駄目です。これは
[空文字の罠](#空文字は値が無いとは別の状態)がもう一段外側で再来したもので、BrowserHive の
分岐は `signing.url === undefined` なのに、commander は `envVar in process.env` で
判定するため `- BROWSERHIVE_SIGNING_URL=` は**設定済み**として通ります。結果は
`fetch("")` と `TypeError: Failed to parse URL from ` —— 上の `DATABASE_URL=` の話と
同じで、**変数の名前を一度も出さない誤り**になります。項目そのものが無ければ
BrowserHive は `no signing service is configured on this server` と言います。

署名は fail-closed です —— 署名を求めて得られなかった取り込みは、署名なしのアーカイブを
出すのではなく失敗します。

**同じ行は、capture-ledger に合本の署名も求めます**（[合本の署名](/capture-ledger/ja/archive-ledger/#合本の署名)）。
`CAPTURE_LEDGER_CAPTURE_SIGNING=1` のとき、API と `pnpm run replay-bundle:rebuild` は、署名の 4 つ組
（`CAPTURE_LEDGER_SIGNER_URL`・`CAPTURE_LEDGER_SIGNER_TOKEN`・`CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR`・
`CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR`）が無ければ起動しません。dev の値は `.env.example` にあります（`.env` に
写すか、シェルから渡す）。host で動く capture-ledger は、wacz-signer に `127.0.0.1:18091` で届きます —— BrowserHive の
スタックの wacz-signer は 18090 に出ていて、同じ dev の CA で署名します。番号を分けないと、取り違えても署名が
通ってしまいます。

署名と時刻印のサービスだけを起こすには、サービス名を付けます（付けないと、全部のコンテナが作り直されます）。
`.env` に `CAPTURE_LEDGER_CAPTURE_SIGNING=1` があれば、`--profile signing` は `stack:up` が足します。

```sh
pnpm run stack:up --profile signing wacz-signer tsa
```

4 つ組を `.env` に書かないなら、シェルから渡して API を起こします。

```sh
CAPTURE_LEDGER_SIGNER_URL=http://127.0.0.1:18091/sign \
CAPTURE_LEDGER_SIGNER_TOKEN=dev-token \
CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR=.upstream/browserhive/dev-stack/signing-ca/insecure-dev-ca.crt \
CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR=.upstream/browserhive/dev-stack/signing-ca/insecure-dev-tsa-ca.crt \
pnpm run api
```

起動のログに `Replay bundles of finished crawls are signed` が出れば、終わったクロールの合本に署名します。
クロールが終われば、`GET /api/crawls/:id` の `replayBundle.signedRev` が `rev` と同じになり、合本の置き場に
`replay-digest.json` が在ります。`pnpm run replay-bundle:verify --crawl <id>` が 0 で終われば、署名と中身が
合っています。起動では openssl が `ts -attime` を持つかを確かめるので、PATH の先頭が macOS の
`/usr/bin/openssl`（LibreSSL）なら、`CAPTURE_LEDGER_OPENSSL_BIN` に homebrew の openssl を書きます。

### 受け取り先を通す

既定では、BrowserHive は成果物を自前の bucket へ書きます。受け取り先（成果物を PUT する先。`artifactSink`）はもう 1 つの経路で、
capture-ledger がクロールごとに 1 回きりの URL とトークンを配り、BrowserHive は成果物を
capture-ledger へ `PUT` します（`src/api/sink.ts`）。BrowserHive が全テナントに書ける鍵を
持たずに済むための仕組みです。2 つの変数で立ち、**2 つ揃ったときだけ**です —— 片方だけだと
API は起動しません。

```sh
CAPTURE_LEDGER_API_HOST=0.0.0.0 \
CAPTURE_LEDGER_SINK_ORIGIN=http://$(container network inspect default | jq -r '.[0].status.ipv4Gateway'):7070 \
CAPTURE_LEDGER_SINK_SECRET=$(openssl rand -hex 32) \
  pnpm run api
```

コマンド行で渡せば `.env` を触らずに済みます —— Node の `--env-file-if-exists` は、shell が
既に持っている変数を上書きしません。

origin は **BrowserHive のコンテナから API に届くアドレス**で、手元から使うアドレスではありません。
dev のスタックでは、コンテナのネットワークから見た host —— default ネットワークの gateway で、
上のコマンドがその場で読みます（この文書を書いた Mac では `192.168.66.1`。network を作り直すと
変わるので、写さないでください）。API は
`0.0.0.0` で待ち受ける必要があります —— loopback に bind すると、コンテナからの接続を断ります。
origin を誤ると、取り込みは受け取り先の URL で始まる誤り（`http://…/api/sink/…: …`）で落ちます。

**そのうえで、成果物がどこに置かれたかを見てください。**この経路は、音も無く素通りされることも
あります。受け取り先を立てて始めたクロールは `crawls.artifact_key_prefix`（`org/<orgId>/<YYYY-MM>/`）
を記録し、そのアーカイブの `object_key` はこれで始まるはずです。平らな
`<taskId>_<crawlId>.wacz` は BrowserHive が自前の bucket へ書いた印で、クロールは成功し、
ほかに何も教えてくれません。受け取り先が足されてから一度も使われなかったのはこのためです ——
`src/crawl/dispatch.ts` の webhook の本文は手で書き並べられていて、`artifact_sink` を一度も
運んでいませんでした。いまは型が網羅を保つ対応表から組み立てます。capture-scheduler の e2e も、
API に受け取り先の有無を訊き（トークン無しの `PUT` が、在れば 401、無ければ 404）、在ればその
クロールのアーカイブが全部接頭辞の下にあることを求めます。

## 画面の絵を撮り直す

[アーカイブを見る](/capture-ledger/ja/picker/)の絵は、`src/tools/docs-shots/docs-shots.ts` が撮った生成物です。
手で撮った絵は 1 枚もありません。絵は画面の書き写しで、書き写しは画面を直した日から古くなるためです。

```sh
./node_modules/.bin/puppeteer browsers install chrome   # 初回だけ (撮影用の Chrome を取得)
pnpm run docs:shots
```

スタックは要りません。script が立てるのは、本物の画面（`src/api/picker.ts`）と、
見本データを返す代役の API（`/api/archives` と `/api/me`）だけです。画面は API の名乗り方で
変わるので、名乗り方ごとに 1 組ずつ立てます（開発用ヘッダ・JWT・名乗りの設定なし・
`0.0.0.0` で待つ開発用ヘッダ）。見た目（ライトモード）・言語・時間帯・見本データの日時を
固定してあるので、誰が撮っても同じ絵になります。何も変えずに撮り直しても、差分は出ません。

**`src/api/picker.ts` を変えたら、撮り直してください。** 撮ったときのソースの sha256 を
`docs-site/src/assets/picker/shots-manifest.json` に控えてあり、いまのソースと違うと
`pnpm run site:check` が落ちます。コメントだけの変更でも同じです。manifest は script が書くので、
手では直さないでください。

## リポジトリの約束

- ソースは `src/`、テストは `test/`、1 モジュール 1 関心。
- `src/rpc/generated/` は生成物でコミット対象。手で編集しない。
- Prettier と ESLint が正。push 前に `pnpm run check`。
- ドキュメントは `docs-site/` に英語と日本語で置く。英語ページだけを追加すると
  `pnpm run site:check` が落ちます。
