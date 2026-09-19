---
title: capture_targets
description: 撮る対象の一覧。capture-ledger が答える唯一の問いの答えが入るテーブル。
---

**撮る対象の一覧。** capture-ledger が答える唯一の問い「どの URL を撮るか」の答えがここに
あります。`POST /api/crawls` に `fromTargets` を渡すと、この表の有効な行
（呼び出し元の組織のぶんだけ）がクロールの種になります。

```ts file="src/db/migrations/001-create-capture-targets.ts#capture-targets-columns"

```

## 列の要点

| 列                          | 要点                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `BIGSERIAL`。投入順で、ローダの `ORDER BY` がそれを保つ                                                                                |
| `url`                       | `CHECK (url <> '' AND url = btrim(url))` と `CHECK (url ~* '^https?://')` — 空文字・前後空白・http(s) でない値をデータベースが拒否する |
| `url_hash`                  | **生成列**。`digest(url, 'sha256')` を stored 保存。ユニーク索引の土台で、直接読むことはない                                           |
| `labels`                    | `TEXT[]`。**もう読んでいない** —— 種にするのは `url` だけなので、BrowserHive にも成果物のファイル名にも届かない                        |
| `enabled`                   | 部分索引 `capture_targets_enabled_id_idx` が覆う。無効行はコストにならない                                                             |
| `org_id`                    | この URL がどの組織のものか。**既定値は無い** —— `INSERT` では必ず書く。`fromTargets` はこれで絞るので、他テナントの対象は種にならない |
| `created_at` / `updated_at` | `now()` 既定。自動更新トリガは今のところ無い                                                                                           |

:::note[なぜ `url` に直接 UNIQUE を張らないのか]
長い URL は索引のサイズ上限に当たりえます。**32 バイト固定の SHA-256 に張る**ことで
その心配が消え、しかも生成列なのでアプリがハッシュを計算する必要もありません。
:::

## 索引

```sql
capture_targets_pkey              PRIMARY KEY (id)
capture_targets_org_url_hash_key  UNIQUE (org_id, url_hash)  -- 同じ組織に、同じ URL は 2 度入らない
capture_targets_enabled_id_idx    (id) WHERE enabled         -- 部分索引
```

`capture_targets_enabled_id_idx` が**部分索引**なのは、読み取りが必ず `WHERE enabled` を
伴うためです。無効な行まで索引に入れても場所の無駄になります。

## 行を足す

```sh
pnpm run targets add https://example.com/ --org acme
```

この表に直接書く、開発用の CLI です。
DB の側では、同じ組織に同じ URL の行を 2 本目に入れようとすると、`capture_targets_org_url_hash_key` で弾かれます。
別の組織なら、同じ URL を入れられます。
CLI のほかの使い方と、手で足す SQL は、[URL ソース](/capture-ledger/ja/url-source/#url-を追加する)にあります。
