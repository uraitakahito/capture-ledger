---
title: データベース
description: capture-ledger と OpenFGA がそれぞれ持つ Postgres と、その中にある 16 のテーブル。
---

capture-ledger の開発スタックには **Postgres が 2 つ**あります。別々のものを入れる、
別々のデータベースです。

| コンテナ                    | 中身                                                         | 誰が SQL で触るか |
| --------------------------- | ------------------------------------------------------------ | ----------------- |
| `postgres.capture-ledger`   | `capture_targets` / `archives` / `fga_outbox` ほか **10 表** | capture-ledger    |
| `openfga-db.capture-ledger` | `tuple` / `authorization_model` ほか **6 表**                | OpenFGA だけ      |

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

| テーブル                                                                   | 役割                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`capture_targets`](/capture-ledger/ja/databases/capture-targets/)         | 撮る対象の一覧                                                   |
| [`capture_submissions`](/capture-ledger/ja/databases/capture-submissions/) | 投げた記録。組織を知る唯一の出どころ                             |
| [`archives`](/capture-ledger/ja/databases/archives/)                       | 台帳。アーカイブを生んだ取り込みだけ                             |
| [`fga_outbox`](/capture-ledger/ja/databases/fga-outbox/)                   | OpenFGA へ送る予定のタプル                                       |
| `crawls`                                                                   | クロール 1 本につき 1 行。方針・状態・停止理由                   |
| `crawl_pages`                                                              | クロールが到達したページ 1 件につき 1 行。重複排除の索引でもある |
| `kysely_migration` / `_lock`<br />`kysely_seed` / `_lock`                  | Kysely が作る帳簿（下記）                                        |

### OpenFGA の DB

| テーブル                                       | 役割                                 |
| ---------------------------------------------- | ------------------------------------ |
| [`tuple`](/capture-ledger/ja/databases/tuple/) | 関係そのもの。OpenFGA の中核         |
| `authorization_model`                          | モデル。版ごとに 1 行、不変（下記）  |
| `changelog`                                    | 書き込みの履歴（下記）               |
| `store`                                        | 名前空間。削除は soft delete（下記） |
| `assertion`                                    | 使っていない（下記）                 |
| `goose_db_version`                             | OpenFGA 自身のスキーマ移行（下記）   |

## 子ページを持たないテーブル

以下は**道具が作って道具が使う**もので、capture-ledger 側から意識することがほとんど
ありません。

### Kysely が作る 4 表

`kysely_migration` / `kysely_migration_lock` / `kysely_seed` / `kysely_seed_lock`。

中身は「どの migration をもう流したか」の 2 列（`name` / `timestamp`）だけで、
`_lock` のほうは 1 行だけの鍵です。同じ runner を、記録用のテーブルだけ変えて
migration と seed に使い回しています。

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
