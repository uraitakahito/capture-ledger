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

| テーブル                                                                   | 役割                                                                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`capture_submissions`](/capture-ledger/ja/databases/capture-submissions/) | 投げた記録。組織を知る唯一の出どころ                                                                                                                     |
| [`archives`](/capture-ledger/ja/databases/archives/)                       | WACZ の記録。アーカイブを生んだ取り込みだけ                                                                                                              |
| `archive_pages`                                                            | アーカイブの頁の一覧（`pages/pages.jsonl`）の 1 行が 1 行。クロールの合本のために 1 度だけ読む                                                           |
| [`fga_outbox`](/capture-ledger/ja/databases/fga-outbox/)                   | OpenFGA へ送る予定のタプル                                                                                                                               |
| `crawls`                                                                   | クロール 1 本につき 1 行。方針・状態・停止理由と、合本の版・署名（[下記](#crawls-の合本の列)）                                                           |
| `crawl_pages`                                                              | クロールが触った URL 1 つにつき 1 行（取る前の pending も）。重複排除の索引でもあり、取り込みのログの数（`log_counts`）も持つ                            |
| `crawl_decisions`                                                          | クロールの規則が決めたこと。段 × 規則 × ホスト名で 1 行                                                                                                  |
| [`crawl_schedules`](/capture-ledger/ja/databases/crawl-schedules/)         | 定期実行の予定。時計の表で、回は `crawls` の行                                                                                                           |
| [`crawl_requests`](/capture-ledger/ja/databases/crawl-requests/)           | クロールを始める要求の鍵（`Idempotency-Key`）。組織と鍵ごとに最初の答えを覚える                                                                          |
| [`crawl_levels`](/capture-ledger/ja/databases/crawl-levels/)               | クロールの段。Windmill の job の id を段の鍵に持ち、送り直しと段の報告の 2 回目を見分ける                                                                |
| [`crawl_links`](/capture-ledger/ja/databases/crawl-links/)                 | 撮ったページにあったリンク 1 本ずつと、どうなったか（次の段に入れた・枚数や深さで切った・規則で落とした）                                                |
| `scripts`                                                                  | クロールが名指せるスクリプト                                                                                                                             |
| `host_types`                                                               | 受け皿（`__bh`）の型。スクリプトを読む人に見せる写し                                                                                                     |
| `derivations`                                                              | 派生の層。Claude が作った物（直す係の案・前回からの変化の要約）を、証拠と分けて model・prompt の版・費用と一緒に残す。組織ごとの月の上限もこの表で数える |
| `page_changes`                                                             | 前回からの変化の、ページ 1 つの差分。2 本の WACZ から作り直せる物だけ（要約は `derivations`）                                                            |
| `crawl_changes`                                                            | 前回からの変化の、予定の回ごとの状態（比べ中・変化なし・差分あり・要約済み・上限で待つ・失敗）。周回が作り、進める                                       |
| `kysely_migration` / `_lock`                                               | Kysely が作る帳簿（下記）                                                                                                                                |

### OpenFGA の DB

| テーブル                                       | 役割                                 |
| ---------------------------------------------- | ------------------------------------ |
| [`tuple`](/capture-ledger/ja/databases/tuple/) | 関係そのもの。OpenFGA の中核         |
| `authorization_model`                          | モデル。版ごとに 1 行、不変（下記）  |
| `changelog`                                    | 書き込みの履歴（下記）               |
| `store`                                        | 名前空間。削除は soft delete（下記） |
| `assertion`                                    | 使っていない（下記）                 |
| `goose_db_version`                             | OpenFGA 自身のスキーマ移行（下記）   |

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

```sh
# capture-ledger 側 — ホストの psql でも繋がる (5432 を公開している)
container exec postgres.capture-ledger psql -U capture_ledger -d capture_ledger -c "\dt"

# OpenFGA 側 — ポート非公開なので container exec から
container exec openfga-db.capture-ledger psql -U openfga -d openfga -c "\d tuple"
```

**OpenFGA の DB は読んでよいが、書いてはいけません。** 直接 `INSERT` や `UPDATE` を
すると、キャッシュや `changelog` と食い違います。
