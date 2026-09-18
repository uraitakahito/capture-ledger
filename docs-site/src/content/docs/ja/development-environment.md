---
title: 開発環境
description: 前提・日々のコマンド・Compose を使わない実行・トラブルシュート。
---

## 前提

- **Node.js 24** (`.nvmrc` のバージョン)。nvm があれば `nvm use`。
- **pnpm 11** — `packageManager` が固定している版。`corepack enable` で入る。
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
pnpm run check       # audit + typecheck + lint + format:check + env + テスト
```

スタックは `container-compose` を直接叩かず、`pnpm run stack:up` で起動してください。
起動の前に、道具と `capture-ledger` DNS ドメイン、すべての build context が指す
`.upstream/` の submodule を確かめ、足りなければ名前を挙げて止まります。

### 環境変数

コードが読む環境変数は、読み取りの仕組みが 3 つに分かれています。
`src/config/` の `required()`/`optional()`、commander の `.env()`（こちらは
`--help` にも出ます）、そして素の `process.env[…]`（これは `scripts/` にもあります）。
数は `pnpm run check-env` が数えて出します。必須は 7 個です。

一覧は `.env.example` の 1 か所だけで、`.env` はその写しです（`cp -n .env.example .env`）。
値を調べて `.env` を作るものはありません
—— 一覧が 2 つあれば必ずずれるからです。OpenFGA の 2 つの ID は
`pnpm run fga:deploy` が出力するまで空のままです
（[アーカイブ台帳](/capture-ledger/ja/archive-ledger/#セットアップ)を参照）。

`scripts/check-env.mjs`（`pnpm run check` に含まれ、CI では独立したステップ）が、
コードの読み取りと `.env.example` の宣言を両方向で突き合わせます。古い雛形は
雛形が無いより悪い —— 信用して使われるので、足りないときに疑う先が残りません。

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

そのため `.env.example` の行は 2 種類しかありません。

```sh
NAME=value     # 値を渡す
#NAME=value    # 既定値を見せるだけ（使うならコメントを外して値を書く）
```

生の `NAME=` を書けるのは**必須の 7 個だけ**です。必須の空は `collectEnv` が
「不足」として報告します。この規則も `check-env.mjs` が検査しています。

## 日々のコマンド

| コマンド                                  | 内容                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm run api`                            | ビルドしてから API を実行 (`tsc` → `node dist/api/server.js`)。         |
| `pnpm run build`                          | `tsconfig.build.json` で `dist/` に JS/d.ts を出力。                    |
| `pnpm run typecheck`                      | `tsc --noEmit`。テストと `*.config.ts` も含む。                         |
| `pnpm run lint` / `lint:fix`              | ESLint flat config (typescript-eslint recommendedTypeChecked)。         |
| `pnpm run format` / `format:check`        | Prettier。`.prettierignore` が `dist/` と `src/rpc/generated/` を除外。 |
| `pnpm test` / `test:watch`                | `test/` 配下の Vitest ユニットテスト。                                  |
| `pnpm run audit`                          | 既知の脆弱性 (`pnpm-lock.yaml`)。CI では毎日も走る。                    |
| `pnpm run check`                          | audit + typecheck + lint + format:check + test。push 前に実行。         |
| `pnpm run db:migrate` / `db:migrate:down` | `DATABASE_URL` に対する Kysely マイグレーション。                       |
| `pnpm run db:seed` / `db:seed:down`       | `src/db/seeds/` の seed。                                               |
| `pnpm run proto:generate`                 | vendored の `.proto` から `src/rpc/generated/` を再生成 (buf)。         |
| `pnpm run proto:check`                    | 生成して `git diff --exit-code` (CI のドリフト検査)。                   |
| `pnpm run proto:sync`                     | 固定した submodule から `.proto` を取り直す。                           |
| `pnpm run site:dev` / `site:build`        | このドキュメントサイト。                                                |
| `pnpm run site:check`                     | サイトをビルドし、参照の整合を検証。                                    |

## スタックで作業する

```sh
pnpm run stack:up
# grpcurl は vendored の契約を読む。準備完了の判定は GetServerStatus。
# browserhive-2 も同じ (localhost:50052)。
until grpcurl -plaintext -import-path proto -proto browserhive/v1/capture.proto \
  localhost:50051 browserhive.v1.CaptureService/GetServerStatus >/dev/null 2>&1; do sleep 1; done
```

**dev コンテナはありません。** container-compose のサブコマンドは
`up` / `down` / `build` / `version` の 4 つだけで、入り込むための `exec` が
そもそもありません。必要もありません — platform DNS は `<service>.capture-ledger` を
コンテナ間からもホストからも解決するので、capture-ledger はホストで動かしたまま
コンテナ側のスタックに繋がります。接続文字列は雛形に入っているので、写した `.env` にそのまま在ります。

```sh
DATABASE_URL=postgres://capture_ledger:capture_ledger@postgres.capture-ledger:5432/capture_ledger
```

BrowserHive の在り処はもうここにありません。スタックが公開している 2 つの gRPC の
口 `localhost:50051` と `localhost:50052`（Chromium 1 台に BrowserHive 1 つ）は、
grpcurl と flow のためのもので、capture-ledger のためではありません。

`pnpm run` 系のコマンドはこの `.env` を自分で読みます
（`node --env-file-if-exists=.env`）。シェルで `export` する必要はありません。
**すでに環境にある変数のほうが優先される**ので、一時的に別の DB を向きたいときは
`DATABASE_URL=... pnpm run db:migrate` と前置きすれば効きます。`node dist/...` を
直接叩く場合は読まれないので、そのときは自分で渡してください。

Postgres は `127.0.0.1:5432` にも公開しているので `localhost` でも繋がります。

Docker Compose から来た場合、日常のコマンドはこう対応します。

| Docker Compose                      | Apple Container                               |
| ----------------------------------- | --------------------------------------------- |
| `docker compose up -d --build`      | `container-compose up -d -b`                  |
| `docker compose down`               | `container-compose down`                      |
| `docker compose ps`                 | `container ls`                                |
| `docker compose logs browserhive-1` | `container logs browserhive-1.capture-ledger` |
| `docker compose exec <svc> sh`      | `container exec -it <svc>.capture-ledger sh`  |
| `docker compose run --rm <svc> …`   | `container run --rm <image> …`                |

Chromium は 2 台とも **headless** です。描画を見たいときは、ローカルの Chrome で
`chrome://inspect` を開き、_Configure…_ に `localhost:9222` と `localhost:9223`
を登録してターゲットを inspect します。

## 本番イメージのスモークテスト

```sh
./scripts/prod-smoke.sh
```

スタックを起動し、BrowserHive が 2 つとも `GetServerStatus` に応答するまでポーリングし、
`capture-ledger:latest` をビルドしてから migrate → seed → API を `container run --rm` で
順に実行し、API に `/healthz` を訊き、`EXIT` トラップでスタックを片付け、
終了コードを自分の終了コードとして返します。

**もう取り込みはしません。** capture-ledger は BrowserHive と gRPC で話さないので、
このスクリプトが示すのは「イメージが起動すること」—— migration が当たり、seed が
入り、API が答えること —— です。取り込みの経路は capture-scheduler の `pnpm run test:e2e` が
端から端まで見ます（あちらは Windmill も要ります）。

一発ジョブが素の `container run` なのは、container-compose に `run` が無いから
です。これにより、以前の `--profile run --exit-code-from capture-ledger` の回避策も
不要になりました — 回避対象だった Docker Compose の挙動（migrator の正当な
exit 0 でスタック全体が停止する）が、こちらには存在しないためです。

## 外部の Postgres に対して動かす

```sh
DATABASE_URL=postgres://user:pass@db.host:5432/capture_ledger \
  pnpm run db:migrate

DATABASE_URL=postgres://user:pass@db.host:5432/capture_ledger \
CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=https://windmill.example/api/w/…/jobs/run/f/f/crawl \
CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=… \
  pnpm run api
```

Postgres の TLS は `DATABASE_URL` にパラメータを書きます (例: `?sslmode=require`)。

**BrowserHive の TLS はもうここで設定しません。** そのチャンネルを持っているのは
flow なので、CA は Windmill 側の変数 `u/admin/browserhive_tls_ca` に置きます
（空文字なら平文）。

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

### 開発用の issuer

`CAPTURE_LEDGER_OIDC_ISSUER` を設定すると、API は **本番と同じ検証コード** を通ります
—— 署名、`iss` / `aud` の照合、有効期限、JWKS の取得。本物の IdP が決まるまでは
同梱の issuer を使います。

```bash
pnpm run oidc:issuer                                   # :9099 に立つ
export CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099
TOKEN=$(pnpm run oidc:token --subject alice --org acme)
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/crawls
```

トークンは `.env` に置きません —— 読むのは受け取る側の API で、投げる側が
`Authorization` ヘッダに載せるものだからです。

`--subject` を変えると **「人が投げた場合」と「サービスが投げた場合」の両方を
作れます**。後者は OpenFGA の owner tuple が `user:<サービス名>` になり、
そのアーカイブを人が消せなくなる状態です —— 認証を入れるより前に、認可の設計を
ここで踏めます。

:::caution[開発用です]
`POST /token` は誰にでもトークンを刷ります。起動時に警告を出すのはそのためです。
鍵は issuer のプロセスの中だけに在り、**起動のたびに作り直されます** ——
再起動すると前のトークンは通らなくなります。それが鍵の更新の再現になります。
:::

### 本物の IdP へ移るとき

変わるのは `CAPTURE_LEDGER_OIDC_ISSUER` と `CAPTURE_LEDGER_OIDC_AUDIENCE` の値だけです。
`jwtIdentityResolver` は 1 行も変わりません。

ただし **JWKS を HTTP で取ってくる経路は単体試験では守れません**。
`createRemoteJWKSet` をローカルの鍵に差し替えても試験は緑のままなので、
この節の手順を実際に通すことがその代わりになります。

組織のクレームの綴りは IdP ごとに違います (`groups` / `roles` / 独自)。
差し替えるのは `src/config/identity.ts` の `ORGANIZATIONS_CLAIM` 1 か所だけです ——
API は `identityFromClaims` を通してそこを読みます。

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
- **docs のビルドが BrowserHive のピンを読めない** —
  `git submodule update --init --recursive` を実行。

### 自分の持ち物をクロールする

スタックには取り込み対象のフィクスチャ [fixtures](https://github.com/uraitakahito/fixtures) が
profile 付きで入っている。見知らぬサイトに向けずにクロールを試せる:

```sh
pnpm run stack:up --profile capture-fixtures
```

port は publish していない。`capture-fixtures.capture-ledger:8080` はコンテナからも host からも引ける。
種にするのは `/links/hub` —— `/links/*` はどれもそのページを 1 か所だけ変えたもので、
それが「誤った規則を適用しているクローラ」と「単に壊れているクローラ」を分ける。

fixtures はリクエストログも持っていて、**それを使うことがこのフィクスチャの要点**:

```sh
curl -s http://capture-fixtures.capture-ledger:8080/__request-counts
```

`crawl_pages` が言うのは capture-ledger が**記録した**こと、ログが言うのはフィクスチャが
**実際に要求された**こと。「robots を尊重した」は後者でしか決着しない —— 台帳に無い
ページは、取りに行かなかったのか、取りに行って捨てたのか、台帳からは区別できない。

fixtures は `.upstream/browserhive` 経由ではなく `.upstream/fixtures` に**直接** vendor して
いる。あちらが抱える fixtures はずっと古く、2 つの pin は別々の都合で動くので、
どちらももう一方を待つ理由が無い。

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

### 受け口を通す

既定では、BrowserHive は成果物を自前の bucket へ書きます。受け口はもう 1 つの経路で、
capture-ledger がクロールごとに 1 回きりの URL とトークンを配り、BrowserHive は成果物を
capture-ledger へ `PUT` します（`src/api/sink.ts`）。BrowserHive が全テナントに書ける鍵を
持たずに済むための口です。2 つの変数で立ち、**2 つ揃ったときだけ**です —— 片方だけだと
API は起動しません。

```sh
CAPTURE_LEDGER_API_HOST=0.0.0.0 \
CAPTURE_LEDGER_SINK_ORIGIN=http://192.168.66.1:7070 \
CAPTURE_LEDGER_SINK_SECRET=$(openssl rand -hex 32) \
  pnpm run api
```

コマンド行で渡せば `.env` を触らずに済みます —— Node の `--env-file-if-exists` は、shell が
既に持っている変数を上書きしません。

起点は **BrowserHive のコンテナから API に届くアドレス**で、手元から使うアドレスではありません。
dev のスタックでは、コンテナのネットワークから見た host の `192.168.66.1` です。API は
`0.0.0.0` で待ち受ける必要があります —— loopback に bind すると、コンテナからの接続を断ります。
起点を誤ると、取り込みは受け口の URL で始まる誤り（`http://…/api/sink/…: …`）で落ちます。

**そのうえで、成果物がどこに置かれたかを見てください。**この経路は、音も無く素通りされることも
あります。受け口を立てて始めたクロールは `crawls.artifact_key_prefix`（`org/<orgId>/<YYYY-MM>/`）
を記録し、そのアーカイブの `object_key` はこれで始まるはずです。平らな
`<taskId>_<crawlId>.wacz` は BrowserHive が自前の bucket へ書いた印で、クロールは成功し、
ほかに何も教えてくれません。受け口が足されてから一度も使われなかったのはこのためです ——
`src/crawl/dispatch.ts` の webhook の本文は手で書き並べられていて、`artifact_sink` を一度も
運んでいませんでした。いまは型が網羅を保つ対応表から組み立てます。capture-scheduler の e2e も、
API に受け口の有無を訊き（トークン無しの `PUT` が、在れば 401、無ければ 404）、在ればその
クロールのアーカイブが全部接頭辞の下にあることを求めます。

## リポジトリの約束

- ソースは `src/`、テストは `test/`、1 モジュール 1 関心。
- `src/rpc/generated/` は生成物でコミット対象。手で編集しない。
- Prettier と ESLint が正。push 前に `pnpm run check`。
- ドキュメントは `docs-site/` に英語と日本語で置く。英語ページだけを追加すると
  `pnpm run site:check` が落ちます。
