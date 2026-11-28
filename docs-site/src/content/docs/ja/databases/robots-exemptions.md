---
title: robots_exemptions
description: robots.txt の例外。組織の admin が、ホストと path の型ごとに「robots.txt が断っていても撮る」を理由・期限・名乗る User-Agent と一緒に登録する。
---

**robots.txt の例外が 1 行です。** 組織の admin が「このホストのこの path の型は、robots.txt が断っていても撮る」を登録します（`046`）。登録・取り消しの手続きと、誰が登録できるかは [robots.txt の例外](/capture-ledger/ja/archive-ledger/#robotstxt-の例外)に書きました。

:::caution[この版では、クロールにはまだ効きません]
この版が入れるのは表と API だけです。行を登録しても、クロールは今までどおり robots.txt に従います。クロールが行を読むのは次の版です。
:::

```ts file="src/db/migrations/046-create-robots-exemptions.ts#robots-exemptions-columns"

```

| 列                                            | 中身                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                                          | 連番（bigserial）。API は字で返す                                                                                      |
| `org_id`                                      | 登録の本文で名指した組織。その組織の admin だけが登録できる                                                            |
| `host`                                        | `url.host` の形（小文字・punycode・既定でないポートは残る）。`crawl_pages.host` と同じ語彙。wildcard は持たない        |
| `path_pattern`                                | robots.txt と同じ書き方の path の型（`*` と末尾の `$`）。既定は `/`（ホストの全て）                                    |
| `scope`                                       | `seeds`（起点だけ）か `links`（辿ったリンクも）。CHECK                                                                 |
| `applies_to`                                  | `all`（どのクロールにも）か `human`（人が始めたクロールにだけ）。既定は `all`。CHECK                                   |
| `user_agent`                                  | このホストで名乗る名。`BrowserHive/<版>` と、任意の括弧の注 1 つ。browser の名に見せかける字は登録の時に断る           |
| `reason`                                      | 理由。1〜500 字                                                                                                        |
| `daily_limit`・`link_limit`                   | この行で外して撮る枚数の上限。24 時間で（既定 100）と、1 クロールの辿ったリンクで（既定 20）。どちらも 1 以上（CHECK） |
| `created_by`・`created_by_name`・`created_at` | 登録した主体（トークンの `sub`）・その時の読める名前（分からなければ NULL）・時刻                                      |
| `expires_at`                                  | 期限。登録から 90 日まで                                                                                               |
| `revoked_at`・`revoked_by`・`revoked_by_name` | 取り消した時刻・主体・名前。`revoked_at` と `revoked_by` は、一緒に在るか一緒に無い（CHECK）                           |

index は `(org_id, host)` です。組織の一覧と、登録の時に同じ組織・ホストの行を見るのに使います。

## 行は消さない

取り消しは `revoked_at` と `revoked_by` を立てるだけです。次の版で、ページの記録と WACZ が行の番号を指すので、行は残します。延ばす時は、新しい行を登録します。

## 効いている行

取り消していなくて（`revoked_at` が NULL）、期限の前（`expires_at` が今より後）の行です。API は行ごとに `state`（`active`・`expired`・`revoked`）を付けて返します。取り消した行は、期限が過ぎても `revoked` です。

## 同じ組織・ホストで守ること

- 同じ path の型で効いている行は 1 つまで。
- 効いている行の `user_agent` は 1 つ（違う名乗りの登録は断る）。

「効いている」は時刻で変わるので、一意の索引では書けません（索引の条件に今の時刻は置けません）。登録のトランザクションが、組織とホストの組で advisory lock（`pg_advisory_xact_lock`）を取ってから、効いている行を見て足します（`src/exemptions/store.ts`）。行を `FOR UPDATE` で掴む形にしないのは、行が 1 つも無い時に何も掴めず、同時の 2 本が両方通るためです。同時の登録が 1 本だけ通ることは、CI が本物の Postgres で確かめます（`src/tools/robots-exemptions-smoke.ts`）。

字の形（ホスト・path の型・User-Agent・理由・期限）は、登録の時に API が検査します（`src/exemptions/validate.ts`）。CHECK が閉じるのは、語彙の決まった列と数の下限だけです。
