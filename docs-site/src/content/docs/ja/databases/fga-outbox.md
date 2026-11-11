---
title: fga_outbox
description: OpenFGA へ送る予定のタプルを溜める箱。2 つのストアに跨がるトランザクションが無いことへの答え。
---

**OpenFGA へ「送る予定」の tuple を溜める箱**です。名前に `fga` と付きますが
**capture-ledger 側のテーブル**で、OpenFGA のものではありません。

```ts file="src/db/migrations/003-create-fga-outbox.ts#fga-outbox-columns"

```

## なぜ要るのか

アーカイブの登録では 2 つのことを書きます。

| 書くもの       | 行き先                  |
| -------------- | ----------------------- |
| アーカイブの行 | Postgres（SQL）         |
| 関係のタプル   | OpenFGA（**HTTP API**） |

**両方にまたがるトランザクションは存在しません。** 独立に書くと片方だけ入りえて、
どちらの結果も悪いものです。

- 誰も辿り着けないアーカイブ
- 巻き戻された行を指す権限

そこで **tuple の書き込みを「予定」としてアーカイブと同じトランザクションに記録**
します。両方入るか、どちらも入らないかです。

```ts
return db.transaction().execute(async (trx) => {
  const inserted = await trx.insertInto("archives").values({ … }).executeTakeFirst();
  if (!inserted) return { reason: "already-known" };

  await trx.insertInto("fgaOutbox").values({ payload: JSON.stringify({ writes: [ … ] }) }).execute();
});
```

## payload の中身

```json
{
  "writes": [
    { "user": "capture_job:7f170ae4-…", "object": "archive:3a4cb75c-…", "relation": "parent" },
    { "user": "organization:acme", "object": "capture_job:7f170ae4-…", "relation": "parent" }
  ]
}
```

2 本を 1 度に積みます。アーカイブをジョブに繋ぎ、そのジョブを組織に繋ぐ ——
この 2 本があって初めて、組織のメンバーがアーカイブに辿り着けます。

## 配送

`pnpm run fga:drain` か、API プロセスのタイマーが掃き出します。

```sql
SELECT … FROM fga_outbox WHERE processed_at IS NULL
ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100
```

**`FOR UPDATE SKIP LOCKED` のおかげで、掃き出しは同時に何本走ってもよい**です
（タイマーで動く API と、手で叩く `pnpm run fga:drain`）。同じ行を 2 度処理する
ことも、互いを待たせることもありません。

配送は **at-least-once** です。行は OpenFGA が受け入れるまで残ります。もう一方の
道 —— 送信時に消す —— では、書き込みと更新の間にプロセスが死ぬたびに tuple を
落とすことになり、**欠けた tuple は誰かが不当に拒まれるまで目に見えません**。

:::caution[OpenFGA の write はバッチ全体がトランザクショナル]
バッチ内に 1 つでも既存のタプルがあると**リクエスト全体が拒否され、新しいタプルも
含めて何も書かれません**。

これは机上の話ではありません。**再登録されたアーカイブが毎回この形を作ります** ——
新しい `archive → capture_job` の隣に、以前の行から来た `organization → capture_job`
が並ぶためです。

だからバッチの失敗を単純に「配送済み」と読むことはできません。ワーカーはまず
バッチを試し、**既に在ることが原因で**失敗したときに限って 1 件ずつ送り直します。
:::

## 処理済みの行を消さない理由

```
processed_at IS NULL   → まだ配送していない
processed_at IS NOT NULL → 配送済み。行は残る
```

**worker は行を消しません。** 処理済みの行は「tuple が書かれた」という証拠で、
capture-ledger と OpenFGA を突き合わせるときに残っている価値があります。

## 索引

```sql
fga_outbox_pkey         PRIMARY KEY (id)
fga_outbox_pending_idx  (id) WHERE processed_at IS NULL   -- 未配送だけを速く引く
```

`fga_outbox_pending_idx` が**部分索引**なのは、掃き出しが必ず
`WHERE processed_at IS NULL` を伴うためです。配送済みの行がいくら積もっても、
未配送を引く速さは変わりません。
