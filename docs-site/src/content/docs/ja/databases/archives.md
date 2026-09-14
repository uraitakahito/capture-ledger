---
title: archives
description: 台帳。成功した取り込みが 1 本につき 1 行。所有者の列が無いことに意味がある。
---

**台帳。成功した取り込みが 1 本につき 1 行**です。「どの WACZ がどこに在るか」の
記録で、署名付き URL を発行するときの参照先になります。

```ts file="src/db/migrations/002-create-archives.ts#archives-columns"

```

## 所有者の列が無いことに意味がある

`owner_id` も `org_id` もありません。**誰が読んでよいかは「関係」であり、
OpenFGA が持ちます。**

同じ問いへの答えを 2 か所に置けば、いずれ食い違います。ここに `org_id` を置くと、
「テーブルではこの組織だが、OpenFGA では別の組織に紐づいている」という状態が
作れてしまいます。

代わりに、登録と同時に [`fga_outbox`](/capture-ledger/ja/databases/fga-outbox/) へ tuple を
積み、OpenFGA 側で関係として表します。

## 失敗した取り込みは入らない

```ts
if (report.status !== CaptureStatus.CAPTURE_STATUS_SUCCESS ||
    report.artifacts?.wacz === undefined) {
  log.warn(…, "capture produced no archive; not adding to the ledger");
  return { reason: "no-archive" };
}
```

**失敗した取り込みは何もアップロードしていません。** それを記録すると、署名の
エンドポイントが**存在しないオブジェクトの URL を配る**ことになります ——
404 に対して認可が完璧に働いている状態で、最も気づきにくい壊れ方です。

だから[`capture_submissions`](/capture-ledger/ja/databases/capture-submissions/)の件数と
この表の行数は一致しません。**差が出るのが正常です。**

## 二重登録が起きない仕組み

台帳を埋める道は 2 本あります。

- **クロール** — flow が段を報告した時点で、取り込めたぶんを登録する（速い）
- **reconciler** — `capture_submissions` に書き留めた manifest の鍵を読み、台帳に無いものを登録する（穴を埋める）

**両方が同じ取り込みに辿り着けますし、どちらも再実行されえます。**

```ts
.onConflict((oc) => oc.columns(["bucket", "objectKey"]).doNothing())
```

`(bucket, object_key)` が UNIQUE なので、それは重複ではなく**無操作**になります。
そして挿入されなかった場合は tuple も積みません —— 既に台帳に在るなら、tuple は
最初のときに積まれているからです。

## 列の要点

| 列                      | 要点                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `id`                    | `gen_random_uuid()`。OpenFGA の `archive:<id>` になる                        |
| `task_id`               | BrowserHive のタスク id                                                      |
| `correlation_id`        | capture-ledger のログ行と成果物のファイル名を結ぶ糸（送信ごとの 16 進 8 桁） |
| `bucket` / `object_key` | **server 自身の報告から取る。** ファイル名を組み直したものではない           |
| `wacz_complete`         | `false` は本文が 1 つ以上欠けているという意味。詳細は下記                    |
| `captured_at`           | 取り込みの時刻。一覧はこれの降順                                             |

### `wacz_complete` が `false` になるとき

`CaptureResultReport.completeness.complete` をそのまま入れています。`false` は
**そのアーカイブに本文が 1 つ以上欠けている**という意味です。

- 304 としてしか見なかった URL
- 容量の上限を超えて BrowserHive が落としたもの

後者は BrowserHive v1.11.0 で加わりました。**それ以前、上限に当たった取り込みは
`true` と報告していました。** この field より前の取り込みや、記録しなかった
取り込みでは `NULL` です。

アーカイブを wacz-validator に渡す前に知っておく価値があります。

## 索引

```sql
archives_pkey                    PRIMARY KEY (id)
archives_bucket_object_key_key   UNIQUE (bucket, object_key)   -- 二重登録の防止
archives_captured_at_idx         (captured_at DESC)            -- 一覧は新しい順
archives_task_id_idx             (task_id)                     -- 報告から引く
```
