---
title: データベース
description: capture-ledger と OpenFGA がそれぞれ持つ Postgres と、その中のテーブル。
---

capture-ledger の開発スタックには **Postgres が 2 つ**あります。別々のものを入れる、
別々のデータベースです。

| コンテナ                    | 中身                                                                       | 誰が SQL で触るか |
| --------------------------- | -------------------------------------------------------------------------- | ----------------- |
| `postgres.capture-ledger`   | `crawls` / `archives` / `fga_outbox` ほか（[下記](#capture-ledger-の-db)） | capture-ledger    |
| `openfga-db.capture-ledger` | `tuple` / `authorization_model` ほか（[下記](#openfga-の-db)）             | OpenFGA だけ      |

重なるテーブルは 1 つもありません。資格情報も相互に通らず、`openfga-db` は
ポートを公開していないので、覗くには `container exec` が要ります。

## なぜ分けたのか

同じインスタンスに同居していると、`tuple` を capture-ledger のトランザクションの中で
書けるかのように錯覚します。**実際には書けません** — OpenFGA へは HTTP API 経由
でしか書かず、SQL では書かないので、両方にまたがるトランザクションは存在しません。

分けておけば、その錯覚が起きる余地が物理的に消えます。そして分けた結果として
[`fga_outbox`](/capture-ledger/ja/databases/fga-outbox/) が必要になります。

## テーブル

### capture-ledger の DB

| テーブル                                                                   | 役割                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`capture_submissions`](/capture-ledger/ja/databases/capture-submissions/) | 投げた記録。組織を知る唯一の出どころ                                                                                                                                                                                                                                                                                                              |
| [`archives`](/capture-ledger/ja/databases/archives/)                       | WACZ の記録。アーカイブを生んだ取り込みだけ                                                                                                                                                                                                                                                                                                       |
| `archive_pages`                                                            | アーカイブの頁の一覧（`pages/pages.jsonl`）の 1 行が 1 行。クロールの合本のために 1 度だけ読む                                                                                                                                                                                                                                                    |
| `archive_screenshots`                                                      | 節目のスクリーンショット（BrowserHive WACZ の中の WARC の resource）の在り処。時点ごとに 1 行で、WACZ の中の位置・残さなかった理由・位置を引けなかった理由のどれか。検める時に書き、絵そのものは写さない（`041`）                                                                                                                                 |
| [`fga_outbox`](/capture-ledger/ja/databases/fga-outbox/)                   | OpenFGA へ送る予定のタプル                                                                                                                                                                                                                                                                                                                        |
| `crawls`                                                                   | クロール 1 本につき 1 行。方針・状態・停止理由と、誰が始めたか（[下記](#crawls-の誰が始めたかの列)）、合本の版・署名（[下記](#crawls-の合本の列)）、robots.txt の例外の資格（`exemption_eligibility`。[`robots_exemptions`](/capture-ledger/ja/databases/robots-exemptions/#クロールの側の列)）、失敗の文の中身（[下記](#crawls-の失敗の文の列)） |
| `crawl_pages`                                                              | クロールが触った URL 1 つにつき 1 行（取る前の pending も）。重複排除の索引でもあり、取り込みのログの数（`log_counts`）と、robots.txt を外した例外の行の番号（`robots_exemption_id`）も持つ                                                                                                                                                       |
| `crawl_decisions`                                                          | クロールの規則が決めたこと。段 × 規則 × ホスト名で 1 行                                                                                                                                                                                                                                                                                           |
| [`crawl_schedules`](/capture-ledger/ja/databases/crawl-schedules/)         | 定期実行の予定。時計の表で、回は `crawls` の行                                                                                                                                                                                                                                                                                                    |
| [`crawl_requests`](/capture-ledger/ja/databases/crawl-requests/)           | クロールを始める要求の鍵（`Idempotency-Key`）。組織と鍵ごとに最初の答えを覚える                                                                                                                                                                                                                                                                   |
| [`crawl_levels`](/capture-ledger/ja/databases/crawl-levels/)               | クロールの段。Windmill の job の id を段の鍵に持ち、送り直しと段の報告の 2 回目を見分ける                                                                                                                                                                                                                                                         |
| [`crawl_links`](/capture-ledger/ja/databases/crawl-links/)                 | 撮ったページにあったリンク 1 本ずつと、どうなったか（次の段に入れた・枚数や深さで切った・規則で落とした）                                                                                                                                                                                                                                         |
| [`robots_exemptions`](/capture-ledger/ja/databases/robots-exemptions/)     | robots.txt の例外。組織の admin が、ホストと path の型ごとに理由・期限・名乗る User-Agent と一緒に登録する（`046`）。クロールは段を起こすたびに効く行を引く（`047`）                                                                                                                                                                              |
| `capture_scripts`                                                          | クロールが名指せる capture scripts                                                                                                                                                                                                                                                                                                                |
| `host_types`                                                               | 受け皿（`__bh`）の型。Capture scripts を読む人に見せる写し                                                                                                                                                                                                                                                                                        |
| `derivations`                                                              | 派生の層。Claude が作った物（直す係の案・前回からの変化の要約）を、証拠と分けて model・prompt の版・費用と一緒に残す。組織ごとの月の上限もこの表で数える                                                                                                                                                                                          |
| `page_changes`                                                             | 前回からの変化の、ページ 1 つの差分。2 本の WACZ から作り直せる物だけ（要約は `derivations`）                                                                                                                                                                                                                                                     |
| `crawl_changes`                                                            | 前回からの変化の、予定の回ごとの状態（比べ中・変化なし・差分あり・要約済み・上限で待つ・失敗）。周回が作り、進める                                                                                                                                                                                                                                |
| `kysely_migration` / `_lock`                                               | Kysely が作る帳簿（下記）                                                                                                                                                                                                                                                                                                                         |

### OpenFGA の DB

| テーブル                                       | 役割                                 |
| ---------------------------------------------- | ------------------------------------ |
| [`tuple`](/capture-ledger/ja/databases/tuple/) | 関係そのもの。OpenFGA の中核         |
| `authorization_model`                          | モデル。版ごとに 1 行、不変（下記）  |
| `changelog`                                    | 書き込みの履歴（下記）               |
| `store`                                        | 名前空間。削除は soft delete（下記） |
| `assertion`                                    | 使っていない（下記）                 |
| `goose_db_version`                             | OpenFGA 自身のスキーマ移行（下記）   |

## crawls の誰が始めたかの列

クロールを誰が・どこから始めたかは、4 つの列が持ちます。認可に使うのは `requested_by` だけで、
残りの 3 つ（`044`）は capture-workbench の一覧が「始めた人」を読める形で出すための写しです。

| 列                  | 要点                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requested_by`      | 始めた主体。JWT ならトークンの `sub`（人は IdP が付けた ID、機械は app client の ID）。定期の回では予定を作った主体。許可も `owner` tuple もこの値で書く                       |
| `requested_by_name` | 始めた時の読める名前。人はトークンの `username`、機械は app client の名前。分からなければ NULL                                                                                 |
| `requested_client`  | どの app client から来たか。`CAPTURE_LEDGER_OIDC_CLIENT_IDS` に `名前=ID` と書いた名前（手元では `workbench`・`cli`・`windmill`）。名前を書いていない client と定期の回は NULL |
| `requested_actor`   | 呼び手が見出し `X-Capture-ledger-Actor` で**申告**した名前（AI の担当の席の名前など）。**確かめていません** —— 誰でも好きな名前を書けるので、画面は「申告」と書いて出します    |

3 つとも、始めた時に行へ写します（後から ID で引き直しません）。手元の IdP は作り直すと app client の ID が
替わるので、ID から引くと古い行の名前が出なくなるためです。`044` より前の行は NULL のままです。

## crawls の合本の列

クロールの[合本](/capture-ledger/ja/archive-ledger/#合本)は版ごとに保管庫へ書き、`crawls` の行は、capture-ledger がそれを指す
ための列（`027`）と、署名したかを言う列（`028`）を持ちます。

```ts file="src/db/migrations/027-replay-bundles.ts#crawls-replay-bundle-columns"

```

```ts file="src/db/migrations/028-replay-bundle-signatures.ts#crawls-replay-bundle-signature-columns"

```

| 列                         | 何を持つか                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `replay_bundle_next_rev`   | 次に払い出す版（1 から）。行の更新で取るので、行の鍵も掛かる                                               |
| `replay_bundle_rev`        | capture-ledger が指す版 —— 書けた版のうち最も大きい物。**前へだけ進む**                                    |
| `replay_bundle_key`        | その版の `replay.json` の鍵（`org/<orgId>/crawls/<crawlId>/r<版>/replay.json`）                            |
| `replay_bundle_pages`      | その版の `pages.json` の行の数                                                                             |
| `replay_bundle_built_at`   | 組んだ時刻（capture-ledger の時計）                                                                        |
| `replay_bundle_error`      | 新しい版を書けなかった理由。次に書けたら消える                                                             |
| `replay_bundle_signed_rev` | **署名した**版のうち最も大きい物。`replay_bundle_rev` とは別に、前へだけ進む                               |
| `replay_bundle_digest_key` | その版の `replay-digest.json` の鍵。`replay_bundle_signed_rev` と一緒に書く（両方 NULL か両方に値。CHECK） |
| `replay_bundle_sign_error` | capture-ledger が指す版に署名しなかった理由。走っているクロールと、署名の設定が無い配備では NULL           |

`replay_bundle_sign_error` は `replay_bundle_rev` を動かすのと同じ更新で書くので、いつも指す版のことを言います。
`replay_bundle_signed_rev = replay_bundle_rev` なら、その版は署名されています。

## crawls の失敗の文の列

`crawls.error` は、1 つの言語（日本語）の字です。capture-ledger が自分で書く文（いまは、1 枚も撮れずに終わった
クロールの文）には、どの文かと、文に埋めた値も行に残し（`048`）、辞書（`src/i18n/`）から文を組み直せるようにします。

```ts file="src/db/migrations/048-add-crawls-error-key.ts#crawls-error-key"

```

| 列             | 何を持つか                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------- |
| `error`        | 文の字。失敗した行はどれも持つ。鍵の無い行は、この字をそのまま返す                            |
| `error_key`    | どの文か（`src/i18n/messages.ts` の `MESSAGE_KEYS` の名前）。その文でない `error` の行は NULL |
| `error_params` | その文に埋めた値（名前 → 字か数。object であることを CHECK が守る）。`error_key` と一緒に書く |

flow が報告した失敗・人が打った理由と、capture-ledger のほかの決まった文（`Windmill did not take level …`・
`could not start: …`）には鍵がありません（行は `error` だけを持ちます）。`048` は、既に
capture-ledger の文を持っていた行にも鍵と値を入れました。入れたのは、組み直した字が保存された字と 1 字も
違わない行だけで、`error` は書き換えていません。

## 子ページを持たないテーブル

以下は**道具が作って道具が使う**もので、capture-ledger 側から意識することがほとんど
ありません。

### Kysely が作る表

`kysely_migration` / `kysely_migration_lock`。

中身は「どの migration をもう流したか」の 2 列（`name` / `timestamp`）だけで、
`_lock` のほうは 1 行だけの鍵です。

### authorization_model

**モデル（スキーマ）。更新も削除もありません。** 書き込むたびに新しい ID が発行され、
古い行はそのまま残ります。モデル全体が `serialized_protobuf` に直列化されて入ります。

Check で ID を指定すればその版で評価され、省略すれば常に最新です。**だから
`CAPTURE_LEDGER_FGA_MODEL_ID` を固定します** — 固定しないと、モデルを書き換えた瞬間に
すべての判断が一斉に変わります。

### changelog

**`tuple` は現在の状態しか持ちません**（消した行は消えます）。その履歴を保つのが
この表です。`operation` は `0` が追加、`1` が削除。

用途は監査（いつ誰の権限が付き、いつ外れたか）と、Watch API による変更の購読です。

### store

1 つの OpenFGA に複数の store を置けます。tuple もモデルも store で仕切られるので、
別プロジェクトが同居できます。

:::caution[store の削除は soft delete です]
API で削除しても `deleted_at` が立つだけで、`tuple` も `changelog` も残ります
（API からは見えなくなります）。ディスクを空けたい場合は SQL で物理削除が要ります。
:::

### assertion

モデルに紐づくテストを OpenFGA 側に保存する場所ですが、**capture-ledger は使っていません**。
テストは `fga/model.fga.yaml` としてリポジトリに置き、`pnpm run fga:test` で
サーバ不要・in-process で走らせています。だから CI ではスタックを立てずに検証できます。

### goose_db_version

OpenFGA 自身のスキーマ移行の記録です。capture-ledger 側の `kysely_migration` と同じ役割で、
`pnpm run fga:migrate` がこれを流します。**2 つの DB がそれぞれ自分の migration 管理を
持っている**ことも、別物であることの傍証です。

## 覗き方

### DB クライアントから繋ぐ

TablePlus や psql などの DB クライアントで繋げるのは、ポートを公開している capture-ledger の Postgres だけです。手元の Mac から `127.0.0.1` で繋ぎます。

| 項目       | 値                                                                              |
| ---------- | ------------------------------------------------------------------------------- |
| host       | `127.0.0.1`                                                                     |
| port       | `5432`                                                                          |
| DB 名      | `capture_ledger`                                                                |
| user       | `capture_ledger`                                                                |
| パスワード | `docker-compose.yml` の `postgres` の `POSTGRES_PASSWORD`（値は下の命令で見る） |

`POSTGRES_PASSWORD` が効くのは、Postgres がデータの置き場（volume）を初めて作る時だけです。置き場を作った後に compose の値を変えても、DB のパスワードは変わりません。2 つが食い違うときは、API が繋げている `.env` の `DATABASE_URL` のほうが今の DB に合っています。

コンテナの名前（`postgres.capture-ledger`）やコンテナの IP では繋がりません。macOS 26 が、Apple の署名の無いアプリからコンテナの subnet への接続を止めるためです（`.env.example` の `DATABASE_URL` の注記）。必ず `127.0.0.1` の公開のポートで繋ぎます。

全文検索の索引（OpenSearch）は SQL の DB ではありませんが、`http://127.0.0.1:9200` で読めます。dev では security plugin を切っているので、認証はありません。

```sh
curl -s 'http://127.0.0.1:9200/_cat/indices?v'
```

Windmill の Postgres（`windmill-db.capture-scheduler`）は capture-scheduler のスタックの物なので、この頁では扱いません。

### コンテナの中の psql で覗く

```sh
# capture-ledger 側 — ホストの psql でも繋がる (5432 を公開している)
container exec postgres.capture-ledger psql -U capture_ledger -d capture_ledger -c "\dt"

# OpenFGA 側 — ポート非公開なので container exec から
container exec openfga-db.capture-ledger psql -U openfga -d openfga -c "\d tuple"
```

**OpenFGA の DB は読んでよいが、書いてはいけません。** 直接 `INSERT` や `UPDATE` を
すると、キャッシュや `changelog` と食い違います。
