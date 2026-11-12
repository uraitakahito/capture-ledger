---
title: crawl_levels
description: クロールの段。Windmill の job の id を段の鍵として持ち、投入・段の報告・fail_crawl の鍵を兼ねる。
---

**クロールの段が 1 行です。** 主キーはクロールの id と深さ。段を決めたときに Windmill の job の id を乱数で決めて持ち、この id（段の鍵）が Windmill への投入（`?job_id=`）・段の報告の `Idempotency-Key`・fail_crawl の本文の `levelKey` を兼ねます。動きは[段の鍵](/capture-ledger/ja/archive-ledger/#段の鍵)に書きました。

```ts file="src/db/migrations/038-crawl-levels.ts#crawl-levels"

```

## 状態

| 状態        | 意味                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | 投げる前。最初の段はクロールの行と、次の段は前の段の報告済みと同じトランザクションで作る                                                           |
| `sent`      | 投げたが、受け取ったかは分からない（時間切れ・繋がらない・5xx・408・429）。同じ段の鍵で送り直す。4xx（path・トークン・引数）はその場で `abandoned` |
| `accepted`  | Windmill が受け取った（2xx か、`already exists` の 400）                                                                                           |
| `reporting` | 段の報告を処理している。`report_token` が試みの印、`lease_until` が期限（2 分）                                                                    |
| `reported`  | 報告を記録した。`answer` に最初の答えを持ち、同じ鍵の 2 回目に返す                                                                                 |
| `abandoned` | 諦めた・締めた（10 分経っても受け取られない、一番新しい段の fail_crawl、人の「締める」）                                                           |

## 引数を持つ

`args` は webhook に送る段そのもの（この段で撮る URL `frontier`・スクリプト・変数・シークレットの名前と Windmill の変数の path・User-Agent など）です。送り直しと、API を起こし直した後に投げる前の段を送るのに要ります。シークレットの値は持ちません。受け取り先の印（`artifactSink` の bearer）も残さず、送り直すときに作り直します（期限も新しくなる）。

## 数は段ごとに書く

`pages_captured`・`pages_discovered` は段ごとに**書き**、`crawls` の合計は段の行の和で書き直します。足し算をしないので、同じ段の報告が 2 回届いても数は重なりません。段の行を入れる前に始めたクロールは段の行を持たず、`crawls` の合計の列はそのまま残ります。

## 投げる係の時計

API の中の周回が 30 秒ごとに、`pending` と `sent` の行（`next_attempt_at` の部分 index）を読んで送り直し、行を作ってから 10 分経った段は諦めてクロールを `failed` で締めます。締めたクロールの段は送らずに `abandoned` にします。期限の切れた始める要求の鍵（[crawl_requests](/capture-ledger/ja/databases/crawl-requests/)）もここで消します。
