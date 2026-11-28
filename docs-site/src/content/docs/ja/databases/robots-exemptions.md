---
title: robots_exemptions
description: robots.txt の例外。組織の admin が、ホストと path の型ごとに「robots.txt が断っていても撮る」を理由・期限・名乗る User-Agent と一緒に登録する。
---

**robots.txt の例外が 1 行です。** 組織の admin が「このホストのこの path の型は、robots.txt が断っていても撮る」を登録します（`046`）。登録・取り消しの手続きと、誰が登録できるかは [robots.txt の例外](/capture-ledger/ja/archive-ledger/#robotstxt-の例外)に書きました。

クロールは、段を起こすたびに、その段に効く行をこの表から引いて flow へ渡します（`047`・`src/exemptions/dispatch.ts`）。どのクロールに・どの行が当たるかは[クロールへの効き方](/capture-ledger/ja/archive-ledger/#クロールへの効き方)に書きました。

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

取り消しは `revoked_at` と `revoked_by` を立てるだけです。ページの記録（`crawl_pages.robots_exemption_id`）と WACZ の申告が行の番号を指すので、行は残します。延ばす時は、新しい行を登録します。

## 効いている行

取り消していなくて（`revoked_at` が NULL）、期限の前（`expires_at` が今より後）の行です。API は行ごとに `state`（`active`・`expired`・`revoked`）を付けて返します。取り消した行は、期限が過ぎても `revoked` です。

## 同じ組織・ホストで守ること

- 同じ path の型で効いている行は 1 つまで。
- 効いている行の `user_agent` は 1 つ（違う名乗りの登録は断る）。

「効いている」は時刻で変わるので、一意の索引では書けません（索引の条件に今の時刻は置けません）。登録のトランザクションが、組織とホストの組で advisory lock（`pg_advisory_xact_lock`）を取ってから、効いている行を見て足します（`src/exemptions/store.ts`）。行を `FOR UPDATE` で掴む形にしないのは、行が 1 つも無い時に何も掴めず、同時の 2 本が両方通るためです。同時の登録が 1 本だけ通ることは、CI が本物の Postgres で確かめます（`src/tools/robots-exemptions-smoke.ts`）。

字の形（ホスト・path の型・User-Agent・理由・期限）は、登録の時に API が検査します（`src/exemptions/validate.ts`）。CHECK が閉じるのは、語彙の決まった列と数の下限だけです。

## クロールの側の列

`047` が、クロールの 2 つの表に列を 1 つずつ足しました。

```ts file="src/db/migrations/047-add-robots-exemption-to-crawls.ts#crawls-exemption-eligibility"

```

`crawls.exemption_eligibility` は、そのクロールにどの行を当ててよいかです。`none`（どの行も当てない）・`machine`（`applies_to` が `all` の行だけ）・`human`（全ての行）のどれかで、クロールを始める時に 1 度だけ決めて残します（`src/exemptions/eligibility.ts`）。後から書き換えません。`047` より前の行は `none` です。

```ts file="src/db/migrations/047-add-robots-exemption-to-crawls.ts#crawl-pages-robots-exemption"

```

`crawl_pages.robots_exemption_id` は、robots.txt が断っていて、例外の行で外したページにだけ入る、その行の番号です。段の報告の `robotsExemptionId` から写します。外して撮りに行き、撮れなかったページ（`failed`）にも入ります。行の名乗りで撮っただけのページ（断られていないページ）と、枚数の上限で見送ったページ（`skip_reason` が `robots-exemption-limit`）には入りません。行は消さない表なので、参照の ON DELETE は既定のままです（ページが指す行は消せません）。

## 枚数を数える

行の上限（`daily_limit`・`link_limit`）は、`crawl_pages.robots_exemption_id` で数えます。段を起こすたびに、次の 2 つを数えて残りを渡します。

- 24 時間の数: その行の番号を持ち、`finished_at` が 24 時間の内のページ。部分 index `crawl_pages_robots_exemption_idx`（`(robots_exemption_id, finished_at)`。番号の入っている行だけ）で引きます。
- 1 クロールのリンクの数: そのクロールの、深さ 1 から先で、その行の番号を持つページ。

どちらも結末を見ません。撮れなかったページも、相手に要求を送った数として数えます。走るクロールは全体で 1 本で、段は前の段の報告の後に起こすので、数える時に「外している途中のページ」はありません。一覧の API の `usedLast24h` は、1 つ目と同じ数え方です。数える SQL が Postgres で通り、数が合うことは、CI が本物の DB で確かめます（`src/tools/robots-exemptions-smoke.ts`）。
