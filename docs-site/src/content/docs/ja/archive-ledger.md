---
title: アーカイブ台帳
description: どの WACZ が存在し誰が読んでよいかを capture-ledger がどう記録し、バケットの資格情報を渡さずに署名付き URL を発行するか
---

capture-ledger は BrowserHive が作った WACZ の**台帳**を持ち、読んでよい相手にだけ
短命な署名付き URL を発行します。

構成要素:

|              | 持つもの                             | 場所                       |
| ------------ | ------------------------------------ | -------------------------- |
| `archives`   | どこに何があるか — bucket・key・由来 | capture-ledger の Postgres |
| OpenFGA      | 誰が何を読んでよいか（関係として）   | 専用の Postgres            |
| `fga_outbox` | OpenFGA へ届ける前のタプル           | capture-ledger の Postgres |

`archives` に所有者の列は意図的にありません。誰が読んでよいかは関係であり、
同じ問いへの答えを 2 か所に持てば、いずれ食い違います。

## なぜ Outbox が要るのか

アーカイブ行の挿入とタプルの書き込みは Postgres と OpenFGA の HTTP API という
別々のシステムに触れ、**両方をまたぐトランザクションは存在しません**。
別々に行えば片方だけ成功しえて、どちらの結果も悪いものです ―
誰も辿り着けないアーカイブか、ロールバックされた行を指す権限か。

そこでタプルの書き込みは、**アーカイブ行と同じトランザクションの中で**
Outbox 行として記録します。両方入るか、どちらも入らないかです。
あとはワーカーが OpenFGA に受理されるまで再送します。

配送は at-least-once で、すでにあるタプルは配送済みとして扱います。

:::caution[OpenFGA の write はバッチ全体がトランザクショナル]
バッチ内に 1 つでも既存のタプルがあると**リクエスト全体が拒否され、新しい
タプルも含めて何も書かれません**。したがってバッチの失敗を単純に
「配送済み」と読むことはできません ― その場合ワーカーはタプルを 1 件ずつ
送り直します。そうしないと新しいタプルが黙って失われます。
:::

## 台帳を埋める 2 つの経路

かつては 3 つでした。CLI が自分の投げた capture を `GetCapture` でポーリングする
経路がありましたが、**CLI も capture-ledger の gRPC クライアントも消えました**。いま投げるのは
Windmill の flow です。

**クロール** ― クロールは、flow が段を報告した時点で自分が取り込んだぶんを
登録します（`src/crawl/admit-level.ts`）。段の報告が運ぶのは各 capture の
`.result.json` の置き場所で、結果そのものは載っていないので、報告された鍵のとおりに
manifest を読み直してから登録します。こちらが速い経路で、
取り込んだページは 1 往復のうちに台帳へ入ります。

**Reconcile** ― `pnpm run fga:reconcile` は、報告は届いたのに台帳に入らなかった
取り込み（manifest の読み取りか、行の書き込みが落ちたもの）を登録します。
`capture_submissions` のうち `manifest_key` を持ち、まだアーカイブの無い行を読み、
**その鍵だけ**を取りに行きます。**bucket は歩きません。** 鍵を組み直すこともありません ——
BrowserHive（または受け口）が `Capture` の応答で manifest を書いた場所を答え、Windmill の
flow がそれを運び、段の報告が書き留めています。

`--since-days <n>` を渡すと、直近 `n` 日に報告された取り込みだけに絞ります:

```sh
pnpm run fga:reconcile --since-days 30
```

結果は `pending`・`registered`・`skipped`（台帳が受け付けない manifest。成果物の無い
cancelled など）・`missing`（報告された鍵に何も無い）で報告します。

**拾えないもの**（仕組み上そうなっています）:

- **段の報告が届かなかった取り込み** —— capture-ledger が止まっていた、または flow が
  報告の前に落ちた。`capture_submissions` の行が無いので、組織も manifest の鍵も分かりません。
  bucket を歩いていた頃も同じで、見つけた manifest は帰属が無く `unattributed` と数える
  だけでした。
- **`manifestError` で報告された取り込み。** 読みに行く鍵がありません。BrowserHive が待つのを
  やめた後に書き込みが終わっていた場合、manifest は在ってもここからは届きません。

:::note[クロールの経路は、以前は抜けていました]
クロールの経路は `crawl_pages` と `capture_submissions` にしか書いておらず、
**台帳には 1 行も入っていませんでした**。クロールしたページは reconcile を
走らせるまで存在せず、picker にも検索にも出ませんでした。取り込んだ本人が
台帳を書けるのに、掃除役の巡回を待っていたことになります。
:::

クロールは遅延のため、reconcile は正しさのためです。
**誰も気づかない穴のある台帳は、台帳が無いより悪い**
― 穴はずっと後で「なぜこのアーカイブが見えないのか」として現れます。

```sh
pnpm run fga:reconcile   # 書き留めた manifest の鍵から抜けを埋める
pnpm run fga:drain       # 溜まったタプルを配送（API も定期的に行う）
```

台帳に入るのは成功した capture だけです。失敗したものは何もアップロード
していないので、記録すると存在しないオブジェクトへの URL を発行できて
しまいます ― 認可は完璧に効いているのに 404、という一番わかりにくい壊れ方です。

**ただし「失敗」は flow の言い分であって、bucket の言い分ではありません。**
報告は flow が BrowserHive の答えをどう受け取ったかで、manifest は BrowserHive
自身が成果物の隣に書いたもの —— 食い違えば manifest を採ります。そこで段の handler は、
`taskId` を持つ**全件**について manifest を引き、成功していたと分かれば
`crawl_pages` の記録を直します。

**その手で拾えない食い違いが 1 つあります —— 切られた取り込み。** flow の deadline が
取り込みの途中で尽きると、BrowserHive は（v9.1.0 以降）ページを壊して
`ERROR_TYPE_CANCELLED` の manifest を書きます。成果物は無いので拾い直す先も無く、
ページは失敗のまま —— それで正しい。bucket にこれが並ぶときは、flow の deadline が
取り込みに要る時間より短いという意味で、直すのは flow の側です。

### 帰属

マニフェストに組織の情報はありません。BrowserHive にその概念が無いからです。
そこで `capture-ledger` は段が報告された時点で `capture_submissions` 行（task id → 組織）を
書き、reconciler がそれを読み戻します。この行は `taskId` を持つ全件に書きます ―
すぐ上の理由で、失敗と報告されたページも含めてです。`correlationId` に組織 ID を
埋め込む案は採りませんでした ― **約束だけで保たれる規約は、最初に手で
capture を投げた人が破ります**。

## URL を発行する

`capture-api` は 2 つのエンドポイントを提供します。どちらも身元が必要です。

```sh
# 1 本のアーカイブ
curl -X POST http://localhost:7070/api/archives/<id>/url
# → { "url": "http://…?X-Amz-Signature=…", "expiresIn": 300 }

# 見てよいものを新しい順に
curl http://localhost:7070/api/archives
```

どちらのリクエストも形は route の JSON Schema で決まっています。説明ではなく
検査そのものが契約です。

|                              |          |                                                     |
| ---------------------------- | -------- | --------------------------------------------------- |
| `POST /api/archives/:id/url` | `id`     | UUID。違えば **400**（認可より前に落ちる）          |
| `GET /api/archives`          | `before` | ISO 8601 の日時。違えば **400**。省略すると最新から |

`before` はカーソルで、直前に受け取った最後の行の `capturedAt` を渡します。
知らないクエリパラメータは拒否ではなく削除されます。

読んではいけない相手には **403 ではなく 404** を返します。403 は
「その ID のアーカイブは実在する」ことを confirm してしまい、これは
OWASP API1:2023 (Broken Object Level Authorization) が警告する列挙の
手がかりそのものです。「見てはいけない」と「存在しない」は
区別できてはいけません。

:::note[署名の直前が唯一の強制点]
S3 は署名しか見ないので、URL を署名した瞬間に判断は確定し、取り消せません。
署名の直前以外のチェックはすべて助言的なものです。有効期限が短いのも
同じ理由で、**署名付き URL は取り消せない**以上、その寿命が
「アクセス権を剥奪してから実際にアクセスが止まるまで」の消せない隙間になります。
:::

単発の Check は `HIGHER_CONSISTENCY` で行います ― ここでキャッシュから
「許可」を返すと、寿命いっぱい有効な URL を渡してしまうからです。
一覧はそうしません。一覧に出ること自体は何の権限も与えず、
実際に取得するには上の強整合な Check を通る必要があるからです。

## クロールを起こす

**いつ**取り込むかを決める仕事は capture-ledger の外 —— スケジューラのもの。**何を**
**どう**投げるかはここに残る。だから境界は、クロールを起こす口と、その様子を返す口の 2 つ。

以前はもう 1 組ありました。`POST /api/runs` と `GET /api/runs/:id` —— 「`capture_targets`
の有効な行を全部 1 回取る」ための口です。**それは今、`fromTargets` で深さ 0 のクロール**
になりました。概念が 1 つ、表が 1 つ、担保が 1 組。

```sh
# 種を明示する形。
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' \
     -d '{"seeds":["https://example.com/"],"maxDepth":2}'
# → 202 { "crawlId": "9072b625-…" }

# 対象一覧から起こす形。以前の run がしていたのはこれ。
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' -d '{"fromTargets":{"limit":5}}'

curl http://localhost:7070/api/crawls/9072b625-…
# → { "state": "succeeded", "stopReason": "max_depth",
#     "seeds": ["https://…"], "pagesCaptured": 5, "pagesDiscovered": 5, … }
```

クロールは段を重ねるので数十分に達しうる。だからこの呼び出しに同期の形は無い。
**202 は受理であって完了ではない。** 結果が住むのは `crawls` の行。

:::note[なぜ `status` ではなく `state` か]
この workspace では両方の語が使われているので、規則を書いておきます。
**進行中の値を取りうる列は `state`。** `crawls.state` と `crawl_pages.state` は
いずれも取りうります（`running`、`pending`）。線の上の `PageReport.status` は
取りえない（`captured` / `failed` / `skipped` だけ）ので、`crawl_pages.state` に
書き込む値であっても `status` のままが正しい。
:::

### 対象一覧から起こす

`fromTargets` は[`capture_targets`](/capture-ledger/ja/databases/capture-targets/)の有効な行を
種にする。`limit` を渡せば先頭 n 件。他とは 2 点だけ違う:

- **`maxDepth` の既定は 0** —— 辿らない。以前の run が意味していたのはこれ。明示した
  値は勝つので、「対象一覧を種にして 2 段辿る」も書ける。
- **`maxPages` は種の数を下回らない。** 既定の 30 のままだと、長い対象一覧が黙って
  切り落とされる。

読む行は呼び出し元の組織で絞る。クロールは `org_id` を 1 つ持つ行なので、別の組織の
対象を混ぜると帰属が言えなくなる。有効な対象が 1 件も無い呼び出し元には、空のクロール
ではなく **400** を返す —— `crawls.seeds` には `CHECK (array_length(seeds, 1) >= 1)` が
あり、種の無いクロールはそもそも始まりようがない。

:::note[`fromTargets` は必ず `max_depth` で終わる]
深さ 0 では 1 段目が最後の段なので、`stopReason` は毎回 `max_depth` になる。
異常ではなく、頼んだことの形がそうだというだけ。
:::

run をクロールに畳んだ帰結が 2 つ。最初の定期実行の前に知っておくとよい:

- **日次の取り込みにも礼儀が効くようになった。** 以前の run は対象を全件同時に投げて
  いたが、クロールは他と同じく `perHostDelayMs` と `hostParallelism` を守る。相手には
  優しく、そのぶん遅い。
- **対象一覧のページが全文検索の索引に乗る。** `crawl_pages` の行になり、索引が
  そこを join するため。

### クロールは同時に 1 本

走行中に 2 本目を起こすと **409**。担保はアプリの旗ではなく、部分 unique index:

```sql
CREATE UNIQUE INDEX crawls_single_active_idx ON crawls ((true)) WHERE state = 'running'
```

理由は礼儀。ホストあたりの間隔は 1 つの flow run の中でしか効かないので、2 本走ると
互いの間隔が見えず、同じホストへの頻度が黙って倍になる。プロセスの中の旗は、プロセスが
2 つになった日まで**しか**保たない。Postgres はどちらでも保つ。route の仕事は、制約違反を
409 に翻訳することだけ。

:::caution[日次と手動のクロールが塞ぎ合うようになった]
以前は制約が 2 つ（run 用とクロール用）あり、手でクロールしている最中でも日次の run は
始められた。いまは 1 つなので始められない。**礼儀の観点では正しい**（どちらも同じホストを
叩く）が、実務上の代償として、**日次が見送られる回数は以前より増える**。

dispatch が途中で死んだクロールの行も `running` のまま残り、次を塞ぐ。判断できるように
`GET` は `startedAt` を返す。片付けは手で行う。
:::

### 呼び出し元が渡せるもの

`seeds`（1 本以上の配列）か `fromTargets` の **どちらか一方**。**両方でも 400、
どちらも無くても 400** で、この 2 つは別の間違いなので言い分を分けてある。ほかに
`scope` / `maxDepth` / `maxPages` / `perHostDelayMs` / `hostParallelism`。
知らない鍵は**黙って落とさず** **400**。

取り込む形式は意図して受けない —— それは「この配備が何をするか」の一部であって、
環境から来る。

```sh
CAPTURE_LEDGER_CAPTURE_FORMATS=wacz   # カンマ区切り: png,webp,html,links,mhtml,wacz
CAPTURE_LEDGER_CAPTURE_SIGNING=1      # wacz-auth 署名を要求する。wacz が要る
```

どちらも**起動時に**読んで検査するので、綴りを間違えるとその値を名指しして起動が止まる。
クロールのたびに解釈すると、打ち間違いは夜中の定期クロールが「形式が 1 つも無い」で
落ちて初めて見つかる —— しかもその文言は、原因になった設定に一言も触れない。
詳しくは[キャプチャオプション](/capture-ledger/ja/capture-options/)。

### 誰がこの口を叩くか

capture-ledger の中には誰も居ない。スケジューラは別の repo —— [capture-scheduler](https://github.com/uraitakahito/capture-scheduler)
—— に住んでいて、そこで動く Windmill が cron でこの endpoint を叩くことだけをしている
（`trigger_crawl.ts`）。取り込みを回す flow も同じ Windmill に居て、capture-ledger は
`CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` でそこへ届く。

分けてあるのは意図的で、**capture-scheduler が「いつ」を決め、capture-ledger が「何を」決める**。
body が取り込む形式を受けないのも、`fromTargets` の対象が呼び出し元の渡す一覧ではなく
`capture_targets` なのも、同じ線の上にある。

呼ぶ側が外してはならないことが 2 つあり、capture-scheduler のスクリプトはそれを形にしたもの:

- **409 は失敗ではない。** 既に走っているという意味で、再試行しても答えは変わらない
  —— その 1 本が終わるまで同じ 409 が返る。
- **202 は終わりではない。** 失敗したクロールも 202 を返している。202 で止める実装は、
  失敗した取り込みを成功として報告する。

クロールを動かすということは JWT で動かすということ —— flow は段ごとの報告を Bearer で
持ってくるので、手で起こしたクロールでも同じ。`CAPTURE_LEDGER_OIDC_ISSUER` を立てると
JWT の resolver が優先され、dev ヘッダは効かなくなる。JWT が dev ヘッダより強いのは狙いどおり
（両方設定された配備で弱いほうへ落ちないため）。ブラウザの picker もそれに合わせ、
JWT の設定ではトークンを貼る欄を出す（[アーカイブを見る](/capture-ledger/ja/picker/)）。

### 誰が起こしてよいか

組織に対する `can_submit`。取り消しが即座に効くよう `HIGHER_CONSISTENCY` で訊く。
許されていない呼び出し元には **404** —— アーカイブの route と同じ理由。

この権限は**保存する**。そこが肝:

```sh
pnpm run fga:grant submitter alice acme
# alice は acme のクロールを起こせます (書いた: user:alice submitter organization:acme)
pnpm run fga:revoke submitter alice acme
# alice は acme のクロールを起こせません (消した: user:alice submitter organization:acme)
```

最後の 1 文は、書いた・消した後に API と同じ問い（`can_submit`）で訊き直した答え。書いた内容から
推した答えではない —— `submitter` を消しても `admin` が残っていれば「起こせます」と言い、括弧の中に
「ほかの関係で許されています」と添える。

呼び出し元の側から確かめるには `GET /api/me` を訊く。答えるのは呼び出し元自身のことだけで、名前と
組織はトークン（かヘッダ）から解いたもの、`canSubmit` はクロールの口が訊くのと同じ問いの答え:

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/me
# → {"subject":"alice","organizations":["acme"],"canSubmit":true}
```

クロールの口の 404 からは「許可が無い」のか「口が無い」のかが読めない。こちらは許可が無くても
404 にせず、`canSubmit: false` と答える。

所属で代用してはならない。組織は呼び出し元自身のトークンから組んだ contextual tuple として
届くので、`can_submit: member` のような規則は「member だと言った者に member か訊く」形に
なり、必ず true になる。最初そう書いて、往復がそれを捕まえた —— 何の関係も無い組織を名乗った
subject に 202 が出た。

分かれ目は権威の在処。**誰であるか**（どの組織に属するか）を言うのは IdP なので保存しない。
**何をしてよいか**を言うのは OpenFGA なので保存する。`grant` が `member` を書くことを拒む
のは、まさにこのため —— 1 つの事実に住処が 2 つあると、食い違ったとき答えが無くなる。

許可が 1 つあればクロールは起こせる。クロールは呼び出し元の身元の**先頭の**組織に
帰属し、`fromTargets` が読むのもその組織の行だけ —— `submitter` が他のテナントの
対象を自分のクロールに引き込むことはできない。

## リンクを辿る

同じ口に深さを 1 以上で渡すと、種からリンクを辿る。辿る作業は Windmill が回し、
**範囲・既読・打ち切り**を決めるのは capture-ledger。

```sh
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' \
     -d '{"seeds":["https://example.com/"],"maxDepth":2,"perHostDelayMs":2000}'
# → 202 { "crawlId": "9072b625-…" }

curl http://localhost:7070/api/crawls/9072b625-…
# → { "state": "succeeded", "stopReason": "max_pages",
#     "pagesCaptured": 6, "pagesDiscovered": 76, … }
```

`CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` と `_TOKEN` の両方が無ければ、この口は出さない。片方だけだと
**起動時に落とす** —— 半端な設定は、頼まれた後にしか気づけない失敗になり、そのときには
行が既に立っている。

### 相手に負荷をかけないために

クロールごとの設定が 3 つ:

|                   | 既定 |                                                            |
| ----------------- | ---- | ---------------------------------------------------------- |
| `perHostDelayMs`  | 2000 | 同じホストで、**前が終わってから**次を**投げる**までの間隔 |
| `hostParallelism` | 4    | 同時に触るホストの数                                       |
| `maxPages`        | 30   | 種を含む総ページ数                                         |

間隔を「投入から」ではなく「**完了から**」測るのが肝。取り込みにかかる時間は前もって
分からない —— 2 秒で終わるページも 2 分かかるページもある —— ので、投入から測った
間隔は相手が感じる間隔と無関係。前が終わった直後に次が届きうる。
相手が間隔を感じるのは、取り込みが終わった後に空けたときだけ。

そして 1 回の取り込みは 1 リクエストではない。ブラウザはサブリソースまで取るので、
1 ページが相手には数十本のバーストに見える。2000ms はそれを踏まえた値で、robots.txt の
`Crawl-delay` が長ければそちらが勝つ —— 相手が言っている値をこちらの都合で縮めない。

:::note[間隔は信じるものではなく、測るもの]
`crawl_pages` がページごとに `submitted_at` と `finished_at` を持つのは、まさに後から
確かめるため:

```sql
SELECT lag(finished_at) OVER w AS prev, submitted_at
FROM crawl_pages WHERE crawl_id = $1
WINDOW w AS (PARTITION BY host ORDER BY submitted_at);
```

差はすべて `per_host_delay_ms` 以上で、**負であってはならない**。負の差は、同じホストへの
取り込みが重なったという意味。どちらの失敗も、時刻が無ければ「速く動いた」と見分けが付かない。
:::

### どこで、なぜ止まったか

`stopReason` は `completed` / `max_depth` / `max_pages` / `failed` のいずれか。これが無いと、
終わったクロールが「全部辿った」のか「切られた」のかを言えない。既定の 30 ページでは
**`max_pages` で止まるのが普通** —— 上限が日常的に見えているほうがよいので、そう選んである。

`pagesDiscovered` と `pagesCaptured` は別々に持つ。差が「範囲・robots・上限で落としたぶん」。

### 何を辿るか

既定は種と同じ origin（`scope: "same-host"` にするとホスト単位に緩む）。判定は
リダイレクト後の **最終 URL** に対して行う。`rel="nofollow"` は尊重し、`http(s)` 以外は
辿らない。フラグメントは落とす —— `#section` はページの中の位置であって別のページではない
—— が、それ以外は正規化しない。クエリを並べ替えると別のページを返すサーバは実在するので、
取りこぼしより取り違えのほうが悪い。

重複排除は `(crawl_id, url_hash)` の unique index 1 本。`url_hash` は `capture_targets` と
同じ `digest(url, 'sha256')` の生成列。見つけたリンクは `ON CONFLICT DO NOTHING` で入れ、
**実際に入った行がそのまま次の段になる** —— 記録と決定がずれようがない。BrowserHive の
`rejectDuplicateUrls` は代わりにならない: pending と processing しか見ておらず、完了した
URL を忘れる。

## 全文検索

既定では立ちません。索引を持たない配備がありうるので、`CAPTURE_LEDGER_OPENSEARCH_URL` を
設定しない限り **口ごと出しません**（404 が返ります ― その配備にこの能力は本当に
無いので、正しい答えです）。

```sh
pnpm run stack:up --profile search
# .env に CAPTURE_LEDGER_OPENSEARCH_URL=http://127.0.0.1:9200
```

```sh
# クロール 1 本ぶんを索引に載せる（クロールの flow が最後に自動で叩きます）
curl -X POST .../api/crawls/<id>/index
# → 202 { "indexed": 6, "pages": 6 }

# 引く
curl ".../api/search?q=responsive"
# → { "hits": [ { "archiveId": "…", "url": "…", "title": "responsive", … } ], "total": 3 }
```

### 本文はアーカイブから採ります

BrowserHive が WACZ の `pages/pages.jsonl` に `title` と `text` を書いています。
`text` の出どころは `document.body.innerText` ― **描画後の本文**であって HTML では
ありません。capture-ledger はそれをそのまま索引に載せます。HTML から起こし直すと、
アーカイブが署名して主張している内容と索引が食い違いえます。

`textWithheld`（`url-policy` / `content-type`）も一緒に運びます。捨てると
**取り込みが空だった**のと**方針が保存を禁じた**のが同じ見た目になります。
前者は調べるべき異常で、後者は正常な運用です。

### 索引は誰に見せてよいかを知りません

検索は OpenSearch に問い合わせてから、返ってきたぶんについて OpenFGA に
`can_view` を訊いて絞ります。`GET /api/archives` と同じ形です。

索引に組織や権限を写せば問い合わせ 1 回で絞れて速いのですが、そうすると
**索引が認可の権威になり、1 つの事実に住処が 2 つできます**。片方を直しても
両方とも動いているように見えるので、認可の素通りが静かに残ります。

:::caution[件数とページングは正確ではありません]
`total` は索引が数えた生の件数で、**認可で落ちたぶんを含みます**。50 件求めて
30 件返ることがあります。見てよいものだけを数えるには数える前に認可を掛ける
しかなく、それは上の「索引に権限を持たせる」に戻ります。数の正確さより、
権威が 1 つであることを採っています。
:::

### 作り直すのは 1 文です

```sql
UPDATE archives SET indexed_at = NULL;
```

索引の状態は `archives.indexed_at` の列 1 つで、本文は保存していません
（必要なものは台帳の行と S3 から全部導けます）。そのため解析器や mapping を
変える判断が安く済みます。

いまの解析器は組み込みの `cjk`（bigram）です。kuromoji はプラグインの導入が要り、
既製イメージでは動きません ― 必要になったら自前イメージに替えて、上の 1 文で
作り直してください。

## ブラウザからアーカイブを選ぶ

`capture-api` は `/` に picker も出す —— 上の一覧を画面にしたもので、行をクリックすると
[replay](https://github.com/uraitakahito/replay) で開く。
**画面の使い方（名乗り方ごとに何を入れるか、画面に出る文の意味）は、
[アーカイブを見る](/capture-ledger/ja/picker/)にあります。**
ここに書くのは、その裏の設計だけです。

画面は、API が起動したときの名乗り方（`selectIdentity`）に合わせて組む —— 開発用ヘッダなら
名乗りの 2 欄、JWT ならトークンの欄、どちらも無ければ注意だけ。ブラウザの側では「名乗りが空」と
「JWT の設定」を見分けられない（どちらも `401` の `{"error":"unauthenticated"}`）ので、
名乗り方を知っている API が HTML を出す時点で決める（`src/api/picker.ts` の `pickerView`）。
picker はトークンを刷らない。刷る issuer は頼まれれば誰の名前でも刷るので `127.0.0.1` にしか
居らず、`0.0.0.0` で開ける画面が刷れば、同じネットワークの誰もが刷れてしまう。

picker が replay に渡すのは `objectKey` だけ:

```
http://127.0.0.1:8899/?source=/wacz/<objectKey>
```

署名付き URL は使わない。あれは S3 を直接指すので viewer から見て別 origin になり、
bucket に CORS が要る。object key なら読みは replay 自身の上流を通るので、
**replay は一切変えなくてよい**。

:::caution[絞っているのは一覧だけで、読みではない]
`can_view` が決めるのは picker に出るかどうか。`/wacz/<key>` を**守ってはいない** ——
その経路は bucket の匿名 read で配られるので、鍵を知っていれば誰でも読める。
絞り込みが決めるのは「何を見せるか」であって「何を取れるか」ではない。

ここを閉じるなら署名付き URL を渡し、bucket に CORS を設定することになる。
それは別の変更。
:::

## 身元

呼び出し元の**認証**は認可とは別の問題で、まだ IdP が決まっていません。
認可層が必要とするものは小さく安定している（subject と所属組織）ので、
その形だけ固定し、裏の検証は差し替え可能にしてあります。

**既定では誰も認証されず、すべて 401 です。**
ローカル開発では `CAPTURE_LEDGER_DEV_IDENTITY=1` で、2 つのヘッダを信用する
リゾルバが有効になります:

```sh
curl -X POST http://localhost:7070/api/archives/<id>/url \
  -H 'X-Capture-ledger-Subject: bob' \
  -H 'X-Capture-ledger-Organizations: acme'
```

ポートに到達できる人は誰にでもなりすませます。明示的に有効化しない限り
動かず、起動時に警告を出します。

**入口はいま API だけです。** 以前は CLI 用の経路がもう 1 本あり、ヘッダの代わりに
`.env` の `CAPTURE_LEDGER_DEV_SUBJECT` と `CAPTURE_LEDGER_DEV_ORGANIZATIONS` を読んでいました。
その 2 つは、読む側の CLI ごと畳んだときに `.env.example` からも
消えています。

身元が**何のためにあるか**は変わりません。これが `capture_submissions.submitted_by` と
`capture_job` の `owner` tuple になり、空のままだと**投げた本人ですら
アーカイブを削除できません**（`can_delete` は `owner from parent` だけを見ます）。

どの経路も最後は 1 か所に行き着きます —— `src/api/identity.ts` が resolver を選び、
`src/config/identity.ts` が検証済みのクレームを `Identity` にする。IdP が決まったとき
差し替えるのはそこだけで、呼ぶ側は `Identity` 型しか見ていません。

所属は OpenFGA に**保存していません**。リクエストごとに呼び出し元の身元から
contextual tuple として渡すので、入退社や組織変更を認可ストアへ同期する
必要がそもそも生じません。代償は**剥奪がトークンの失効待ちになる**ことで、
だからトークンは短命であるべきです。

## 認可モデル

型は 4 つで、所有は**組織 → ジョブ → アーカイブ**と上から流れます。

| 型             | 関係                                                     |
| -------------- | -------------------------------------------------------- |
| `user`         | —                                                        |
| `organization` | `member` / `admin`                                       |
| `capture_job`  | `owner` / `parent`（組織）/ `member`                     |
| `archive`      | `parent`（ジョブ）/ `viewer` / `can_view` / `can_delete` |

署名エンドポイントが聞くのは `can_view` ただ 1 つで、そこに至る道は 3 本です。

```
define can_view: viewer or owner from parent or member from parent
```

| 道                   | 誰が                       | どこから来るか                       |
| -------------------- | -------------------------- | ------------------------------------ |
| `viewer`             | 組織の外へ直接共有された人 | タプル（**必ず期限つき**）           |
| `owner from parent`  | そのジョブを頼んだ本人     | タプル                               |
| `member from parent` | 所有組織の一員             | **contextual tuple**（トークン由来） |

削除は所有者だけです（`can_delete: owner from parent`）。
**組織のメンバーは見られますが、消せません。**

:::note[`capture_job.member` は中継のために在る]
`archive` から `organization#member` へ直接届きそうに見えますが、届きません。
**`from` は辺をちょうど 1 本しか辿らない**ためです。`archive#parent` が指すのは
`capture_job` なので、そこから見た「組織のメンバー」は 2 段先にあります。

```
type capture_job
  relations
    define parent: [organization]
    define member: member from parent   # ← その足りない 1 段
```

:::

### 共有は自分で期限切れになる

組織の外へ渡すとき、期限なしでは渡せません。`viewer` の型が条件付きだからです。

```
define viewer: [user with non_expired_grant, organization#member]

condition non_expired_grant(current_time: timestamp, grant_time: timestamp, grant_duration: duration) {
  current_time < grant_time + grant_duration
}
```

`current_time` は Check のたびに渡されるので、**期限切れのタプルを掃除する仕組みが
要りません**。タプルは残ったまま条件が偽になるだけで、掃除役が止まっていても
穴は開きません。

### アサーションが守っているもの

`fga/model.fga.yaml` の 7 本は、どれも「誰かが不当に見られる」形の壊れ方を
指しています。

| #   | 問い                                           |
| --- | ---------------------------------------------- |
| 1   | ジョブの所有者は、それが生んだものを見られる   |
| 2   | 所有組織のメンバーは**見られるが、消せない**   |
| 3   | 無関係な人には何も見えない                     |
| 4   | **別の組織のメンバーであることは何も与えない** |
| 5   | 直接の共有は、その窓の中では見える             |
| 6   | **同じ共有が、窓を過ぎると見えない**           |
| 7   | 共有された相手でも、削除はできない             |

5 と 6 は**タプルが完全に同一で、`current_time` だけが違います**。

### 検証と投入

`fga/model.fga` が真実で、`fga/model.fga.yaml` のアサーションが CI で走ります:

```sh
pnpm run fga:test    # サーバ不要でモデルを検証
pnpm run fga:deploy  # モデルを投入し、固定すべき ID を .env.local に書く
```

`fga:deploy` は `CAPTURE_LEDGER_FGA_STORE_ID` と `CAPTURE_LEDGER_FGA_MODEL_ID` を出力し、
あわせて `.env.local` に書き込みます（`.env` は触りません）。
**モデル ID は固定してください。** モデルはイミュータブルで書き込むたびに
新しい ID が発行されるため、ID を省略すると常に最新で評価され、
**モデルを書き換えた瞬間にすべての判断が一斉に変わります**。
環境変数を上げる操作が、その切り替えを意図的な行為にします。

## セットアップ

```sh
git submodule update --init --recursive
cp -n .env.example .env       # 設定の雛形をそのまま写す
pnpm run stack:up
pnpm run fga:migrate          # OpenFGA のスキーマ（下記参照）
pnpm run db:migrate
pnpm run fga:deploy           # → 2 つの ID を .env.local に書く（貼る作業は無い）
pnpm run api
```

どれも `.env` と `.env.local` をこの順で読みます（`pnpm run` の各スクリプトが
`--env-file-if-exists` を 2 つ渡しています。**後が勝ちます**）。必須は 7 個で、うち 2 個
（`CAPTURE_LEDGER_FGA_STORE_ID` と `CAPTURE_LEDGER_FGA_MODEL_ID`）は `fga:deploy` を走らせるまで
存在しません。この手順が `api` より前にあるのはそのためです。`.env.example` が
実際の読み取りとずれていないかは `scripts/check-env.mjs` が見ています。

:::caution[`fga:migrate` が独立した手順である理由]
`openfga` イメージは distroless なので、seaweedfs のように entrypoint で
シェルのリトライループを回せず、container-compose にワンショットの
サービスもありません。サーバは未マイグレートの DB に対しても普通に起動し、
これを実行するまで **`/healthz` を含むすべてに 500 を返します**。

またデータストアの指定は環境変数ではなくコマンドラインフラグで行っています。
container-compose が注入する Docker link 風の変数を OpenFGA の設定ローダーが
拾って誤読し、環境変数で渡すと
`storage engine '192.168.64.202' is unsupported`（DB コンテナの IP アドレス）
で panic しました。
:::
