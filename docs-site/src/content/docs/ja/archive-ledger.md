---
title: アーカイブの記録
description: どの WACZ が存在し誰が読んでよいかを capture-ledger がどう記録し、バケットの資格情報を渡さずに署名付き URL を発行するか
---

capture-ledger は BrowserHive が作った WACZ の**記録**を持ち、読んでよい相手にだけ
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

## 記録を埋める 2 つの経路

かつては 3 つでした。CLI が自分の投げた capture を `GetCapture` でポーリングする
経路がありましたが、**CLI も capture-ledger の gRPC クライアントも消えました**。いま投げるのは
Windmill の flow です。

**クロール** ― クロールは、flow が段を報告した時点で自分が取り込んだぶんを
登録します（`src/crawl/admit-level.ts`）。段の報告が運ぶのは各 capture の
`.result.json` の置き場所で、結果そのものは載っていないので、報告された鍵のとおりに
manifest を読み直してから登録します。こちらが速い経路で、
取り込んだページは 1 往復のうちに記録へ入ります。

**Reconcile** ― `pnpm run fga:reconcile` は、報告は届いたのに記録に入らなかった
取り込み（manifest の読み取りか、行の書き込みが落ちたもの）を登録します。
`capture_submissions` のうち `manifest_key` を持ち、まだアーカイブの無い行を読み、
**その鍵だけ**を取りに行きます。**bucket は歩きません。** 鍵を組み直すこともありません ——
BrowserHive（または成果物の受け取り先）が `Capture` の応答で manifest を書いた場所を答え、Windmill の
flow がそれを運び、段の報告が書き留めています。

`--since-days <n>` を渡すと、直近 `n` 日に報告された取り込みだけに絞ります:

```sh
pnpm run fga:reconcile --since-days 30
```

結果は `pending`・`registered`・`skipped`（capture-ledger が受け付けない manifest。成果物の無い
時間切れ・失敗など）・`missing`（報告された鍵に何も無い）・`counted`（取り込みのログの数を、
まだ読んでいなかったページの行に埋めた数。[ページと取り込みのログ](#ページと取り込みのログ)）で報告します。

**拾えないもの**（仕組み上そうなっています）:

- **段の報告が届かなかった取り込み** —— capture-ledger が止まっていた、または flow が
  報告の前に落ちた。`capture_submissions` の行が無いので、組織も manifest の鍵も分かりません。
  bucket を歩いていた頃も同じで、見つけた manifest は帰属が無く `unattributed` と数える
  だけでした。
- **`manifestError` で報告された取り込み。** 読みに行く鍵がありません。BrowserHive が待つのを
  やめた後に書き込みが終わっていた場合、manifest は在ってもここからは届きません。

:::note[クロールの経路は、以前は抜けていました]
クロールの経路は `crawl_pages` と `capture_submissions` にしか書いておらず、
**`archives` には 1 行も入っていませんでした**。クロールしたページは reconcile を
走らせるまで存在せず、picker にも検索にも出ませんでした。取り込んだ本人が
記録を書けるのに、掃除役の巡回を待っていたことになります。
:::

クロールは遅延のため、reconcile は正しさのためです。
**誰も気づかない穴のある記録は、記録が無いより悪い**
― 穴はずっと後で「なぜこのアーカイブが見えないのか」として現れます。

```sh
pnpm run fga:reconcile   # 書き留めた manifest の鍵から抜けを埋める
pnpm run fga:drain       # 溜まったタプルを配送（API も定期的に行う）
```

記録に入るのは成功した capture だけです。失敗したものは何もアップロード
していないので、記録すると存在しないオブジェクトへの URL を発行できて
しまいます ― 認可は完璧に効いているのに 404、という一番わかりにくい壊れ方です。

**ただし「失敗」は flow の言い分であって、bucket の言い分ではありません。**
報告は flow が BrowserHive の答えをどう受け取ったかで、manifest は BrowserHive
自身が成果物の隣に書いたもの —— 食い違えば manifest を採ります。そこで段の handler は、
`taskId` を持つ**全件**について manifest を引き、成功していたと分かれば
`crawl_pages` の記録を直します。

**その手で拾えない取り込みが 1 つあります —— flow が切った取り込み。** flow の
deadline（クロールを回す Windmill の flow を持つ
[capture-scheduler](https://github.com/uraitakahito/capture-scheduler) の
`crawl_host`）が取り込みの途中で尽きると、BrowserHive はページを壊して `errorDetails.type` が
`cancelled` の manifest を書きます。ところが flow は答えを受け取っていないので、報告に `taskId` も
manifest の場所も載りません。`capture_submissions` の行が無く、段の登録も reconcile もその manifest
を読みに行けないので、ページは失敗のまま（理由は deadline を過ぎたこと）で、
そのページの取り込みのログも引けません（`not-captured`）。bucket にこれが並ぶときは、flow の
deadline が取り込みに要る時間より短いという意味で、直すのは flow の側です。

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

|                                       |          |                                                                         |
| ------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `POST /api/archives/:id/url`          | `id`     | UUID。違えば **400**（認可より前に落ちる）                              |
| `GET /api/archives`                   | `before` | ISO 8601 の日時。違えば **400**。省略すると最新から                     |
| `GET /api/crawls`                     | `state`  | `running` / `succeeded` / `failed`。違えば **400**                      |
|                                       | `before` | ISO 8601 の日時。違えば **400**。省略すると最新から                     |
| `GET /api/crawls/:id/pages`           | `after`  | 前の答えの `next`。数字だけで 18 桁まで。違えば **400**                 |
|                                       | `limit`  | 1〜500。既定 100。外れは **400**                                        |
| `GET /api/crawls/:id/pages/:page/log` | `page`   | ページの id。数字だけで 18 桁まで。違えば **400**（認可より前に落ちる） |

`before` はカーソルで、直前に受け取った最後の行の `capturedAt`（クロールなら
`startedAt`）を渡します。
知らないクエリパラメータは、拒否も削除もされず、そのまま残って無視されます（全文検索の `GET /api/search`
だけは 400 で断ります）。

クロールの一覧は `maySubmit` で絞ります —— アーカイブのように 1 行ずつ `can_view` を
訊く形ではありません。認可モデルに `crawl` という型が無いためです。`maySubmit` は、呼び出し元の組織のどれか 1 つで
`can_submit` が通れば許し（`src/api/authorization.ts`）、許された呼び出し元には組織を問わず全部の行を返します。
だから `submitter` を与えることは**組織を跨ぐ信頼**です。権限が無い呼び出し元には 403 でも 404 でもなく**空の配列**を返し、代わりに各行へ
`orgId` を載せます —— 見えている範囲を、呼ぶ側が言えるようにするためです。
行が持つのは状態と `stopReason` の両方です。`succeeded` は「1 枚以上撮れた」なので、状態だけでは
「全部辿った」（`completed`）と「切った」（`max_depth`・`max_pages`）と「辿るリンクが無かった」（`no_links`）の区別が付きません。
`maxDepth` も載るので、辿らないクロール（深さ 0）かどうかも言えます。

**`succeeded` は 1 枚以上撮れたクロールです。** 1 枚も撮れずに終わると（全部のページが取れないか、robots で
見送り）、`failed` で締め、`stopReason` は `failed`、`error` に「1 枚も撮れませんでした（取れず 1・見送り 0）。
最初の理由: …」と書きます。一部だけ取れなかったクロールは `succeeded` のままで、取れなかった数は `pagesFailed`
で言います。理由は `GET /api/crawls/:id` の `failures` です（新しい 5 件）。

`waczCount` は、そのクロールから出た WACZ の数です。`archives` に `crawl_id` は無く、
`crawl_pages` の `task_id` を挟んで数えています（列を足さずに今日のまま届きます）。

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

## クロールを始める

クロールの起点は頼みと一緒に来るので、何を撮るかは頼む側が決める。頼むのは [capture-workbench](https://github.com/uraitakahito/capture-workbench) の画面の人か、
頼みを持っている予定（`crawl_schedules`）で、予定の期限は capture-ledger の時計が見る（[定期実行](/capture-ledger/ja/schedules/)）。
境界は、クロールを始めるエンドポイント（HTTP の method と path の組）と、その様子を返すエンドポイントの 2 つ。

```sh
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
     -d '{"seeds":["https://example.com/"],"maxDepth":2}'
# → 202 { "crawlId": "9072b625-…" }

curl http://localhost:7070/api/crawls/9072b625-…
# → { "state": "succeeded", "stopReason": "max_depth",
#     "seeds": ["https://…"], "pagesCaptured": 5, "pagesDiscovered": 5, "pagesFailed": 0, … }
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

### クロールは同時に 1 本

走行中に 2 本目を始めようとすると **409**。担保はアプリの旗ではなく、部分 unique index:

```sql
CREATE UNIQUE INDEX crawls_single_active_idx ON crawls ((true)) WHERE state = 'running'
```

理由は礼儀。ホストあたりの間隔は 1 つの flow run の中でしか効かないので、2 本走ると
互いの間隔が見えず、同じホストへの頻度が黙って倍になる。プロセスの中の旗は、プロセスが
2 つになった日まで**しか**保たない。Postgres はどちらでも保つ。route の仕事は、制約違反を
409 に翻訳することだけ。

:::caution[予定と手で始めたクロールは塞ぎ合う]
制約は 1 つなので、手でクロールしている最中に期限の来た予定は待つ。期限は動かず、走っている 1 本が
終わってから始まる（[定期実行](/capture-ledger/ja/schedules/)）。**礼儀の観点では正しい**（どちらも同じホストを
叩く）。

:::

### 同じ要求を 2 回送っても 1 本

**`POST /api/crawls` は `Idempotency-Key` の見出しを必ず求めます**（無い・形が違えば 400。見える ASCII の 1〜255 字）。
capture-ledger は組織と鍵の組ごとに、最初に始めたクロールの答えを覚え（`crawl_requests`）、同じ鍵の送り直しには
同じ `crawlId` の 202 を返して 2 本目を始めません。応答が切れた後に送り直す呼び出し元は、**同じ鍵**で送ります。

| 来た物                 | 答え                                                 |
| ---------------------- | ---------------------------------------------------- |
| 新しい鍵               | いつもどおり（202・400・409 …）                      |
| 覚えている鍵・同じ本文 | 最初の 202（同じ `crawlId`）。段は投げ直さない       |
| 覚えている鍵・違う本文 | 422。1 つの鍵が 2 つの要求を指すと、どちらも嘘になる |
| 鍵が無い               | 400                                                  |

- **覚えるのは始めた答え（202）だけ。** 走行中の 409 も中身の 400 も覚えないので、走っている 1 本が終わってから（または直してから）同じ鍵で送れば始まります。
- 本文は鍵の並びを揃えて比べます（JSON の鍵の順が違っても同じ要求）。
- 鍵の期限は 24 時間。古い鍵は次に始める要求と投げる係の時計が消し、同じ字で新しく始められます。
- 鍵の行は `crawls` の行・起点のページと同じトランザクションで入ります。同じ鍵が同時に 2 本届いたら、後ろは鍵の主キーの待ちで前の commit を待ち、前の答えを返します。
- **鍵は名乗りの後に見ます。** 名乗らずに叩けば、鍵が無くても 401 です（capture-scheduler の doctor は、名乗らずに `{}` を送って 401 を見ることで、このエンドポイントが在るかを確かめます）。

capture-workbench の「始める」と capture-scheduler の smoke・e2e は鍵を付けます。定期実行の回は API を通らないので鍵を使いません（重ならないのは時計の `skip locked` の仕事。[定期実行](/capture-ledger/ja/schedules/)）。
表の形は [crawl_requests](/capture-ledger/ja/databases/crawl-requests/)。

### クロールの行の終わり方

`running` の行を締める道は次の 3 つだけで、どれも `state` がまだ `running` の行にしか効きません。

- **段の報告が「次の段は無い」と言ったとき。** 次の段が 0 本になる報告で行を締めます。1 枚も撮れていなければ
  `failed` で締めます。
- **`POST /api/crawls/:id/failed`。** 段が落ちたとき flow の締める段が叩きます（落ちた段の `depth` と `levelKey` を付けて。
  一番新しい段の鍵のときだけ締め、古い段の flow の失敗は `{"closed": false}`）。人も同じエンドポイントを叩けます（鍵なしで、いまどおり締まる）。
- **段を Windmill に受け取らせられないまま 10 分経ったとき。** capture-ledger は段を、その場で 3 回（初回と 2 秒・4 秒の後）、
  それでも受け取りを確かめられなければ投げる係の時計（30 秒ごと）が、同じ段の鍵で送り直します。段の行を作ってから
  10 分経っても受け取られなければ、行をメッセージ付きの `failed` で締めます（[段の鍵](#段の鍵)）。

受け取られた段の後で、時間で締める仕組みは **ありません**。締める段は段の報告と同じトークン・同じ宛先を使うので、**古いトークン（401）**・
`can_submit` が無い呼び出し元（**404**）・API に届かない、のどれでも両方が落ち、行は `running` のまま残ります。
Windmill で run を取り消すと、締める段は走りません。行を足してから webhook を投げ終えるまでに capture-ledger が落ちたときは、
段の行が残るので、起こし直した後に投げる係の時計が送ります。

塞いでいる行は **409** の本文が名指しし（`crawlId`・`startedAt`）、`lastJobId` から Windmill の run に辿れます。
閉じるのは `POST /api/crawls/:id/failed` です。予定の状態が `stuck` か `overdue` なら、capture-workbench の
定期実行タブの「締める」でも閉じられます。

締めても、生きている flow は止まりません。その段は撮り終えて報告しますが、**capture-ledger はページを記録するだけで、次の段を作りません**
（CAPTURE-77）。締めた行が `succeeded` に戻ることも、数が重なることもありません（数は段の行の和で書き直す）。

### 段の鍵

段を決めたとき（最初の段はクロールの行と、次の段は前の段の報告と同じトランザクション）、capture-ledger は段の行（[`crawl_levels`](/capture-ledger/ja/databases/crawl-levels/)）を作り、
Windmill の job の id を乱数で決めて持ちます。この id が **段の鍵** です。

- **投げる:** webhook に `?job_id=<段の鍵>` を付け、flow には `level_key` の引数で渡します。Windmill は在る id の 2 本目を
  `400 Bad request: Job with id … already exists` で断るので、時間切れの後に送り直しても flow は 1 本です（その 400 は受け取り扱い）。
- **報告する:** flow は段の報告（`POST /api/crawls/:id/pages`）の `Idempotency-Key` に段の鍵を付けます。

| 届いた段の報告                                   | 答え                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| 鍵が無い                                         | 400                                                                 |
| 段の行が無い（段の行を入れる前に始めたクロール） | 409                                                                 |
| 段の鍵と違う                                     | 409                                                                 |
| 報告済みの段                                     | **最初の答え（200）**。記録もクロールの行も書かず、次の段も投げない |
| 報告中の段（期限 2 分の内）                      | 409（flow の再試行に任せる）                                        |
| 締めた段・締めたクロール                         | 200。ページは記録し、次の段は作らない                               |

同じ段の報告が 2 回届くのは、応答が切れた後の report_level の再試行・同じ引数で流し直した flow・worker が止まった後の Windmill の
やり直しです。Windmill の「この段からやり直す」（`jobs/restart`）は Community Edition では使えません（enterprise version だけ。2026-11-12 に確かめた）。

報告の処理は 1 つのトランザクションにしません（途中で保管庫を読むので）。段を「報告中」にして試みの印と 2 分の期限を持たせ、
終わりの commit（次の段のページ・報告済み・合計の書き直し・次の段の行）は印が同じときだけ通します。期限切れで取り直した 2 本目と、
遅れた 1 本目が並んでも、片方しか書けません（遅れた方は 409）。次の段は「今回入った行」でなく、深さ n+1 の `pending` の行から作るので、
取り直した 2 回目でも途中で完了と読みません。

### 呼び出し元が渡せるもの

`seeds`（1 本以上の配列）は必須で、無ければ **400**。ほかに
`rules` / `maxDepth` / `maxPages` / `perHostDelayMs` / `hostParallelism` / `scripts`（ページで
走らせるもの）/ `variables`（スクリプトが宣言した、クロールごとの値。
[キャプチャオプション](/capture-ledger/ja/capture-options/#クロールごとの値)を参照）/ `userAgent`（同じ頁を参照）。
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

### 誰がこのエンドポイントを叩くか

capture-workbench の画面と、トークンを持つほかの道具。予定はこのエンドポイントを叩かない —— 回を始めるのは capture-ledger の時計で、
作ったときに同じ確かめを通して固定した撮り方で始める（[定期実行](/capture-ledger/ja/schedules/)）。

分けてあるのは意図的で、**何を撮るかは予定（`crawl_schedules`）か、画面から始めるクロールが持ち、
予定の期限が来たかは capture-ledger が決める**。[capture-scheduler](https://github.com/uraitakahito/capture-scheduler) の
Windmill は撮るだけで、capture-ledger は `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` でその flow へ 1 段ずつ渡す。

呼ぶ側が外してはならないことが 2 つある:

- **409 は失敗ではない。** 既に走っているという意味で、再試行しても答えは変わらない
  —— その 1 本が終わるまで同じ 409 が返る。
- **202 は終わりではない。** 失敗したクロールも 202 を返している。202 で止める実装は、
  失敗した取り込みを成功として報告する。

クロールを動かすということは JWT で動かすということ —— flow は段ごとの報告を Bearer で
持ってくるので、手で始めたクロールでも同じ。`CAPTURE_LEDGER_OIDC_ISSUER` を立てると
JWT の resolver が優先され、dev ヘッダは効かなくなる。JWT が dev ヘッダより強いのは狙いどおり
（両方設定された配備で弱いほうへ落ちないため）。ブラウザの picker もそれに合わせ、
JWT の設定ではトークンを貼る欄を出す（[アーカイブを見る](/capture-ledger/ja/picker/)）。

### 誰が始めてよいか

組織に対する `can_submit`。取り消しが即座に効くよう `HIGHER_CONSISTENCY` で訊く。
許されていない呼び出し元には **404** —— アーカイブの route と同じ理由。

この権限は**保存する**。そこが肝:

```sh
pnpm run fga:grant submitter alice acme
# alice は acme のクロールを始められます (書いた: user:alice submitter organization:acme)
pnpm run fga:revoke submitter alice acme
# alice は acme のクロールを始められません (消した: user:alice submitter organization:acme)
```

最後の 1 文は、書いた・消した後に API と同じ問い（`can_submit`）で訊き直した答え。書いた内容から
推した答えではない —— `submitter` を消しても `admin` が残っていれば「始められます」と言い、括弧の中に
「ほかの関係で許されています」と添える。

利用者は呼び出し元の身元が言うもの。開発用ヘッダなら名乗った名前、JWT ならトークンの `sub` で、
利用者の名前ではない。手元では `pnpm run idp:grant` が、[Floci](https://github.com/floci-io/floci) の自分の利用者の `sub` と、
Windmill の flow が使う app client の ID に、`acme` の `submitter` を与える。

呼び出し元の側から確かめるには `GET /api/me` を訊く。答えるのは呼び出し元自身のことだけで、名前と
組織はトークン（かヘッダ）から解いたもの、`canSubmit` はクロールのエンドポイントが訊くのと同じ問いの答え:

```sh
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/me
# → {"subject":"<sub>","organizations":["acme"],"canSubmit":true}
```

クロールのエンドポイントの 404 からは「許可が無い」のか「エンドポイントが無い」のかが読めない。こちらは許可が無くても
404 にせず、`canSubmit: false` と答える。

所属で代用してはならない。組織は呼び出し元自身のトークンから組んだ contextual tuple として
届くので、`can_submit: member` のような規則は「member だと言った者に member か訊く」形に
なり、必ず true になる。最初そう書いて、往復がそれを捕まえた —— 何の関係も無い組織を名乗った
subject に 202 が出た。

分かれ目は権威の在処。**誰であるか**（どの組織に属するか）を言うのは IdP（Identity Provider —— 身元を証明する外部のサービス）なので保存しない。
**何をしてよいか**を言うのは OpenFGA なので保存する。`grant` が `member` を書くことを拒む
のは、まさにこのため —— 1 つの事実に住処が 2 つあると、食い違ったとき答えが無くなる。

許可が 1 つあればクロールは始められる。クロールは呼び出し元の身元の**先頭の**組織に
帰属し、許しをくれた組織とは限らない。

## リンクを辿る

同じエンドポイントに深さを 1 以上で渡すと、起点からリンクを辿る。辿る作業は Windmill が回し、
**どのリンクを取るか・既読・打ち切り**を決めるのは capture-ledger。リンクは BrowserHive の `.links.json` から読む。
中身は、一番上の文書と、その script から読める枠（同じ origin の `frame`・`iframe` の文書。BrowserHive v29.1.0 から）の
`<a href>`。別 origin の枠の中のリンクは読まない。

```sh
curl -X POST http://localhost:7070/api/crawls \
     -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
     -d '{"seeds":["https://example.com/"],"maxDepth":2,"perHostDelayMs":2000}'
# → 202 { "crawlId": "9072b625-…" }

curl http://localhost:7070/api/crawls/9072b625-…
# → { "state": "succeeded", "stopReason": "max_pages",
#     "pagesCaptured": 6, "pagesDiscovered": 76, … }
```

`CAPTURE_LEDGER_CRAWL_WEBHOOK_URL` と `_TOKEN` の両方が無ければ、このエンドポイントは出さない。片方だけだと
**起動時に落とす** —— 半端な設定は、頼まれた後にしか気づけない失敗になり、そのときには
行が既に立っている。

### 相手に負荷をかけないために

クロールごとの設定が 3 つ:

|                   | 既定 |                                                            |
| ----------------- | ---- | ---------------------------------------------------------- |
| `perHostDelayMs`  | 2000 | 同じホストで、**前が終わってから**次を**投げる**までの間隔 |
| `hostParallelism` | 4    | 同時に触るホストの数                                       |
| `maxPages`        | 30   | 起点を含む総ページ数                                       |

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

`stopReason` は `completed` / `no_links` / `max_depth` / `max_pages` / `failed` のいずれか。これが無いと、
終わったクロールが「全部辿った」のか「切られた」のかを言えない。`no_links` は、辿るよう頼んだ（深さ 1 以上）のに、
規則が通したリンクが 1 本も無いまま締まったクロール —— 起点から 1 歩も進めなかった。深さ 0 でリンクが無いのは
`completed`（辿らないと頼んだので）。`max_depth` と `max_pages` は、
まだ撮っていないリンクが残っていたときだけ立つ（上限に当たっても、残りが無ければ `completed`）。
既定の 30 ページでは **`max_pages` で止まるのが普通** —— 上限が日常的に見えているほうがよいので、そう選んである。

`pagesCaptured` は撮れたページの数で、起点も数える。`pagesDiscovered` は撮ったページのリンクのうち規則が通した数で、
深さ 0 のクロールでも数える。撮らなかった物（robots で見送った物・上限で切った物）も、既に撮った URL
（起点へ戻るリンクなど）も入り、段ごとに足すので、別の段で同じ URL が出ると 2 度数える。`pagesFailed` は
取れなかったページの数。数え方が違うので、差は落とした数にならない。規則と robots が落とした物は
`GET /api/crawls/:id/decisions` で見る。

### 何を辿るか

クロールは**規則の並び**を受ける。規則は鍵が 1 つの object で、鍵が動き、値が当てる物。

```json
"rules": [
  { "skip": "ads.example.com" },
  { "skip": "https://www.example.com/search" },
  { "follow": "same-site" },
  { "capture": "any" }
]
```

| 動き      | 当たったリンクは                         |
| --------- | ---------------------------------------- |
| `follow`  | 撮って辿る（そのページのリンクも読む）   |
| `capture` | 撮るだけ（そのページのリンクは読まない） |
| `skip`    | 落とす（撮らない）                       |

| 当てる物                                       | 当たる URL                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same-origin`・`same-host`・`same-site`・`any` | 起点と比べて、同じ origin・同じホスト（ポートまで）・同じ登録ドメイン・全部                                                                                    |
| 小文字のホスト名（`ads.example.com`）          | そのホストと、その下のサブドメイン。ラベルの境目で照らす（`badads.example.com` には当たらない）                                                                |
| `http(s)` の URL                               | 正規化（ホストは小文字、既定の port は外す）した URL がそれで始まる物。文字列の前方一致なので `/search` は `/searching` にも当たる（境目が要るなら末尾に `/`） |

**上から当て、最初に当たった規則が決める。どれにも当たらないリンクは落とす。** 規則の番号は
画面の行と同じく 1 から数える。`rules` を省くと `[{ "follow": "same-origin" }]` ——
起点と同じ origin を辿り、外は落とす。規則は読んだ形でクロールの行に固定する（URL の前方一致は
正規化した形）。

`same-site` は lockfile が固定する `tldts` の版の Public Suffix List で決まり、**私的な区画も
見る** —— `foo.github.io` と `bar.github.io` は別のサイト。IP アドレスと `localhost` は、
それ自身が 1 つのサイト。

書いたとおりに動かない並びは、クロールを始める前に **400** で、どこが悪いかを名指して断る。

| `error`                         | とき                                                    | 名指す物                       |
| ------------------------------- | ------------------------------------------------------- | ------------------------------ |
| `invalid rule patterns`         | 当てる物が 3 種類のどれにも読めない                     | `rules: [{ rule, pattern }]`   |
| `rules that can never match`    | 前の規則が、後ろの規則の当たる URL を全部含む           | `rules: [{ rule, coveredBy }]` |
| `seeds the rules do not follow` | 起点が `capture`・`skip` に当たるか、どれにも当たらない | `seeds: [url]`                 |

形（1〜32 本・鍵が 1 つ・当てる物は 2048 字まで）は schema の 400。「二度と当たらない」は
言い切れるときだけ言う: `any` は全部を含む。`same-site` は `same-host` を、`same-host` は
`same-origin` を含む。ドメインはその下のドメインを含み、`same-site` は起点のサイトにある
ドメインを含む。URL の前方一致は、それより短い前方一致と、その URL 自身が当たる範囲や
ドメインに含まれる。正しい並びを断るほうが、死んだ規則を通すより悪い。

`GET /api/crawl-rules/check` は、何も始めずに同じ検査をする。書かないエンドポイントなので `GET`。

```sh
curl 'http://localhost:7070/api/crawl-rules/check?seed=https://www.example.com/&rule=follow:same-site&rule=skip:ads.example.com'
# → { "seeds": [{ "url": "https://www.example.com/", "valid": true, "site": "example.com", "followed": true }],
#     "rules": [{ "rule": 1, "action": "follow", "kind": "scope", "pattern": "same-site" },
#               { "rule": 2, "action": "skip", "kind": "domain", "pattern": "ads.example.com", "coveredBy": 1 }],
#     "ok": false }
```

規則を当てる前に、`rel="nofollow"` は尊重し、`http(s)` 以外は見ない。`follow` でない
ページのリンクは読みもしない。ページは頼んだ URL と、リダイレクトの後に居た **最終 URL** の
両方で決める —— 外へ跳ぶリンクから範囲が広がらないように。
フラグメントは落とす —— `#section` はページの中の位置であって別のページではない
—— が、それ以外は正規化しない。クエリを並べ替えると別のページを返すサーバは実在するので、
取りこぼしより取り違えのほうが悪い。

重複排除は `(crawl_id, url_hash)` の unique index 1 本。`url_hash` は
`digest(url, 'sha256')` の生成列。見つけたリンクは `ON CONFLICT DO NOTHING` で入れ、
**実際に入った行がそのまま次の段になる** —— 記録と決定がずれようがない。BrowserHive の
`rejectDuplicateUrls` は代わりにならない: pending と processing しか見ておらず、完了した
URL を忘れる。

### 規則が何を決めたか

段の報告のたびに、規則ごと・ホストごとに、別々の URL を何本決めたかを残す ——
`crawl_decisions`。段 × 規則 × ホスト名で 1 行。同じ段の報告をやり直したら、足さずに
置き換える。`follow` でないページのリンクは読まないので、数にも入らない。

```sh
curl http://localhost:7070/api/crawls/9072b625-…/decisions
# → { "rules": [ …クロールに固定した規則… ],
#     "decisions": [{ "depth": 1, "rule": 1, "action": "skip", "hostname": "ads.example.com",
#                     "links": 12, "samples": ["https://ads.example.com/…", …] }, …],
#     "robots": [{ "hostname": "www.example.com", "pages": 1, "samples": ["https://www.example.com/private"] }] }

curl 'http://localhost:7070/api/decisions?domain=ads.example.com&days=90&action=skip'
# → { "decisions": [{ "crawlId": "…", "startedAt": "…", "seeds": [ … ], "rule": 1, "action": "skip",
#                     "pattern": "ads.example.com", "hostname": "ads.example.com", "links": 12 }, …],
#     "truncated": false }
```

規則 `0` は、どの規則にも当たらなかったリンク。`robots` は robots.txt のために取らなかった
ページで、「なぜ撮らなかったか」を 1 か所で読める。ホスト名はポートを外す。ドメインで引くエンドポイントは、
そのホストとその下をラベルの境目で照らし、新しいクロールから並べる。`days` の既定は 90、
`action` の既定は `skip` で、500 行で切ったときは `truncated` が言う。Windmill は run の中身を
最長 30 日で消すが、この行はクロールの行がある限り残る。

### ページと取り込みのログ

クロールが触った URL は、取る前の pending も含めて 1 つずつ `crawl_pages` の行です。それを読むエンドポイントが
2 本あります。どちらも認可は `GET /api/crawls/:id` と同じ `maySubmit` で、許可の無い呼び出し元にも、
無いクロールやページにも 404 を返します。

```sh
curl 'http://localhost:7070/api/crawls/9072b625-…/pages?limit=100'
# → { "pages": [{ "id": "1234", "url": "https://…", "depth": 0, "state": "captured", "reason": null,
#                 "taskId": "6f1c…", "archiveId": "a1b2…",
#                 "logCounts": { "debug": 0, "info": 12, "warn": 1, "error": 0, "dropped": 0 } }, …],
#     "next": "1300" }

curl http://localhost:7070/api/crawls/9072b625-…/pages/1234/log
# → { "page": { …一覧と同じ形… },
#     "log": { "lines": [{ "at": "2026-11-04T05:12:04.551Z", "ms": 4522, "dpr": 1, "source": "script",
#                          "script": "egov-law-search", "level": "info", "msg": "…", "data": { … } }, …],
#              "counts": { "debug": 0, "info": 12, "warn": 1, "error": 0 }, "dropped": 0 },
#     "reason": null }
```

一覧は、ページがクロールに入った順に `limit` 本ずつ返ります。続きは、前の答えの `next` を `after`
に渡して引きます（終わりなら `next` は `null`）。続きをヘッダでなく本文で言うのは、[capture-workbench](https://github.com/uraitakahito/capture-workbench)
の中継が状態・content-type・本文のほかを落とすからです。`id` は `bigserial` を文字列にした物で、
`reason` は `skip_reason` —— 取らなかった理由も、取れなかった理由も入ります。

**capture-ledger は行を持ちません。** 行は取り込みのログ ——
ページで走ったスクリプトが書いた物（`__bh.log`・`__bh.report`・投げた例外）、取り込みのページ自身の
console、BrowserHive の出来事 —— で、BrowserHive（v24.0.0 から）が答えと、成果物の隣の
`.result.json` に載せます。シークレットの値は、長さに依らず `***` に替えてあります。
ログのエンドポイントはそのたびに保管庫からこの file を読み、`log` を書かれたまま、届いた順で返します。
capture-ledger が写すのは数だけで、段の登録が（読めなかったときは reconcile
が）`crawl_pages.log_counts` に書くので、一覧は file を読みません。数を写すのは `archives` に入れる前です ——
時間切れや失敗の取り込みは WACZ が無く `archives` に入りませんが、行と数は在り、
行を読みたいのはむしろそのページです。`logCounts` が `null` なのは、その取り込みの `.result.json`
から数を読んでいないときだけです。鍵の順は決まっていない（`jsonb` が並べ替える）ので、
名前で引いてください。

読めないときも 200 で、`"log": null` と理由（`reason`）を返します:

| `reason`           | 理由                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `not-captured`     | 取り込みの答えが無い。`taskId` が無い（pending・skipped・flow の deadline で切った・断られた） |
| `no-manifest`      | 答えはあるが、`.result.json` の場所が記録されていない（`manifestError`）                       |
| `manifest-missing` | 記録した場所に何も無い                                                                         |
| `manifest-invalid` | JSON でない、または契約に合わない（`readManifest` が断った）                                   |
| `no-log`           | `log` が無い —— BrowserHive v24.0.0 より前が書いた                                             |

保管庫に届かなければ 502 です。`GET /api/crawls/:id` の `failures` の各要素はページの
id（`page`）を持つので、取れなかったページからそのまま行へ辿れます。

穴が 2 つ残っています。`timeout`・`connection`・`internal` で落ちた取り込みは 1 度だけ撮り直され、
capture-ledger が持つのは 2 回目の `taskId` だけなので、1 回目のログは保管庫に在っても、ここからは辿れません。
またエンドポイントの認可は組織を見ない `maySubmit` で、クロールを始められる者は、どのクロールの行も ——
スクリプトが報告した値も、取り込みのページが出した文も —— 読めます。`GET /api/crawls/:id`
と同じ性質です。

## 全文検索

**必須です。** API は `CAPTURE_LEDGER_OPENSEARCH_URL` をほかの必須の設定と一緒に読み、
起動の時に OpenSearch に索引を訊きます（無ければ mapping ごと作ります）。URL が無いか、
OpenSearch が答えなければ、API は起動しません。以前は任意で、URL が無ければエンドポイントを出さず、
クロールの flow の索引の段は 404 を「飛ばした」として受け、検索が無いまま全部が緑でした。

開発では `pnpm run dev:up` が起こします。段 `search` が compose の profile `search` の
`opensearch` だけを名指しで起こし（名前を付け忘れると全部のコンテナが作り直されます）、
段 `search-connect` が cluster の health が yellow になるのを待って、URL を `.env.local` に
書きます。答えるかと索引の件数は `pnpm run dev:status` が言い、`pnpm run dev:down` が止めます。

```sh
# OpenSearch だけ（段 search が起こす物。段は 9200 が答えていれば飛ばす）
pnpm run stack:up --profile search opensearch
pnpm run search:connect
# dev:up を段 search から続ける（後ろの段も走る）
pnpm run dev:up --from search
```

```sh
# クロール 1 本ぶんを索引に載せる（クロールの flow の最後の段が叩きます）
curl -X POST .../api/crawls/<id>/index
# → 202 { "pending": 6, "indexed": 6, "failed": 0, "pages": 12 }
# → 503 { "error": "search unavailable", … } OpenSearch が答えないとき

# 引く
curl ".../api/search?q=responsive"
# → { "hits": [ { "archiveId": "…", "stage": "after-load", "url": "…", "title": "responsive", … } ], "total": 2 }
```

`pending` はこのクロールのまだ載せていないアーカイブの数、`failed` は入らなかった数です。
入らなかったアーカイブは `indexed_at` が空のまま残るので、もう一度このエンドポイントを叩くか
`pnpm run search:reindex` で拾い直します（自分で拾い直す係はありません）。クロールの flow は、
`failed` が 1 以上・404・503 を誤りにします。

### 本文はアーカイブから採ります

BrowserHive が WACZ の `pages/pages.jsonl` に `title` と `text` を書いています。
`text` の出どころは `document.body.innerText` ― **描画後の本文**であって HTML では
ありません。capture-ledger はそれをそのまま索引に載せます。HTML から起こし直すと、
アーカイブが署名して主張している内容と索引が食い違いえます。

`textWithheld`（BrowserHive の `DocumentWithheld`。`url-policy`・`content-type`・`no-archive`・`deny`・`unattributed`）も一緒に運びます。捨てると
**取り込みが空だった**のと**方針が保存を禁じた**のが同じ見た目になります。
前者は調べるべき異常で、後者は正常な運用です。

BrowserHive は、頁を写した時点ごとにページ一覧の行を書きます（読み込みの後が
`after-load`、スクリプトの後が `after-behaviors`）。行の `url` は写しの urn
（`urn:browserhive:snapshot:after-load:https://…` の形で、文書の URL はその後ろ）です。
capture-ledger は行ごとに 1 件として載せ、時点を `stage` に入れます。同じアーカイブの
検索前と検索後が両方当たれば 2 件返ります。認可はアーカイブで決まるので、2 件の答えは
同じです。

WACZ Profile 1.18.0 から、1 行目はいつでも取り込んだ文書の行です。`stage` が無く、`url` は
要求の URL で、題と本文はスクリプトの後に読んだ物 —— `after-behaviors` の行とほぼ同じ文です。
両方を載せると同じ語が 1 アーカイブで 2 回当たるので、写しの行があるアーカイブでは、文書の行を
載せません。写しが 1 つも無い取り込み（本文を伏せた文書など）は文書の行だけで、その行を載せ、
`stage` は `null` です。

### 索引は誰に見せてよいかを知りません

検索は OpenSearch に問い合わせてから、返ってきたぶんについて OpenFGA に
`can_view` を訊いて絞ります。`GET /api/archives` と同じ形です。

索引に組織や権限を写せば問い合わせ 1 回で絞れて速いのですが、そうすると
**索引が認可の権威になり、1 つの事実に住処が 2 つできます**。片方を直しても
両方とも動いているように見えるので、認可の素通りが静かに残ります。

:::caution[ページングはありません]
50 件求めて 30 件返ることがあります。見てはいけない当たりは、問い合わせの後で落とすからです。
`total` は返した当たりの数で、索引が数えた生の件数ではありません ― 生の件数は、見てはいけない
アーカイブに何件当たったかを教えてしまいます（CAPTURE-53 の前は生の件数を返していました）。
索引の側で見てよいものだけを数えるには、数える前に認可を掛けるしかなく、それは上の
「索引に権限を持たせる」に戻ります。
:::

### 索引を作り直す

```sh
pnpm run search:reindex                # 全部のアーカイブ
pnpm run search:reindex --crawl <id>   # 1 本のクロールぶん
```

`archives.indexed_at` を空にして、アーカイブを入れ直します。capture-ledger の DB・保管庫・OpenSearch を直に
読み書きし、アクセストークンは使いません。打つのは、OpenSearch を作り直したとき（compose の
サービスは volume を持たないので、capture-ledger は「載せた」と言ったまま索引だけが空になります）と、
索引を消したときです。

```sh
# mapping か解析器を変えたときだけ、先に索引を消す
curl -X DELETE http://127.0.0.1:9200/capture-pages
```

索引の状態は `archives.indexed_at` の列 1 つで、本文は保存していません
（必要なものは capture-ledger の行と S3 から全部導けます）。そのため解析器や mapping を
変える判断が安く済みます。

capture-ledger は mapping を**索引を作るときにしか置きません**。mapping か解析器を
変えたのに索引を消さずに載せ直すと、古い mapping のまま載り、新しい欄の型は
OpenSearch が推測します（エラーは出ません）。

いまの解析器は組み込みの `cjk`（bigram）です。kuromoji はプラグインの導入が要り、
既製イメージでは動きません ― 必要になったら自前イメージに替えて、上の手順で
作り直してください。

## 合本

クロールは、撮った頁ごとに WACZ を 1 本残します。**合本は、それを 1 つに綴じ直した物です**:
段の後に、そのクロールの WACZ を全部並べた `replay.json` と、それらの頁の一覧の行を全部持つ
`pages.json` を、capture-ledger が保管庫に書きます。[replay](https://github.com/uraitakahito/replayweb-server) は
それを 1 つのアーカイブとして開き、ある WACZ の頁から別の WACZ の頁へリンクで行けます。
形（v1）は replayweb-server の `docs/replay-bundle.md` にあります。

```sh
# クロールの flow のためのエンドポイント。段を報告した後・その段を索引に載せる前に叩く
curl -X POST .../api/crawls/<id>/replay-bundle -H 'content-type: application/json' -d '{"depth":1}'
# → 200 { "rev": 3, "pages": 18, "members": 6, "skipped": 0, "failed": 0, "error": null,
#         "signed": false, "signError": null, "digestKey": null }
```

叩くたびに**新しい版**（`rev`）を書きます。版の番号はクロールの行が払い出し
（`crawls.replay_bundle_next_rev`。1 回に 1 つ、1 から）、2 つの物は設定の bucket
（WACZ と同じ bucket）の `org/<orgId>/crawls/<crawlId>/r<版>/` に `application/json` で置きます。
一度書いた版は書き換えません。クロールが指すのは書けた版のうち最も新しい物
（`crawls.replay_bundle_rev`）で、**前へだけ進みます**。次の段は前の段の報告の中で出されるので、
段 N の合本が段 N+1 の合本より後に書き終わることがあり、それでクロールを戻してはいけないからです。
本文の `depth` は記録するだけです（`replay.json` の `replayBundle.depth`）。版ではありません ――
作り直しで同じ深さを 2 度書くためです。

| 欄          | 意味                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `rev`       | 書いた（書こうとした）版。入れる WACZ が無く、何も書かなかったときは `null`                                             |
| `pages`     | `pages.json` の行の数（`totalPages`）                                                                                   |
| `members`   | `resources` に入れた WACZ の数                                                                                          |
| `skipped`   | 記録が 0 で外した WACZ の数（下）                                                                                       |
| `failed`    | 読めなかった WACZ の数（保管庫に無い・zip でない・保管庫に届かない）。次の合本が読み直す                                |
| `error`     | 書けなかった理由。書けたら `null`                                                                                       |
| `signed`    | 署名して `replay-digest.json` を書いたか（[合本の署名](#合本の署名)）                                                   |
| `signError` | 終わったクロールの合本に署名しなかった（できなかった）理由。署名した・走っているクロール・署名の設定が無いときは `null` |
| `digestKey` | 書いた `replay-digest.json` の鍵。署名しなかったら `null`                                                               |

**書けなくても 200 です。** 理由を `error` と `crawls.replay_bundle_error` に残します（後の版が
書けたら消えます）。合本は撮った物から作る派生物で、flow の段を誤りにすると、次の段が既に走って
いるのにクロールが failed になります。401・404（`can_submit` が無い・クロールが無い）・400（id が
UUID でない・本文が `{depth}` でない）は索引のエンドポイントと同じです。

### 何が入るか

クロールのアーカイブを `archives.crawl_id` で引きます。取り込みを受けるときに入ります（reconcile は
`crawl_pages.task_id` からクロールを引きます）。まだ検めていないアーカイブ（`inspected_at` が空）は
1 度だけ読みます: sha256 と大きさ（`resources[].hash` が sha256 を運びます）、`indexes/index.cdxj`
が空か、`pages/pages.jsonl` の行。行は `archive_pages` に入れ、後の版は WACZ を読み直しません。
文書の行には `keys` も付けます ―― 頼んだ URL と、BrowserHive の答え（その取り込みの `.result.json`）の
`document.url`（リダイレクトの後）を `parseHttpUrl` と同じ形に正規化した物で、replayweb-server が
頁を引く鍵です。写しの行には付けません。

各行には、文字（`text`）の sha256 と長さ、伏せた理由（`textWithheld`）も入れ、`datapackage.json` から
撮った BrowserHive と Chrome の版を `archives` に入れます（`035`）。前回からの変化（[定期実行](/capture-ledger/ja/schedules/)）は、
digest が同じページの WACZ を開かずに「同じ」と言えます。文字そのものは capture-ledger の DB に持ちません。
`035` より前の行は `pnpm run changes:backfill` が埋めます。

記録が 0 の WACZ（索引が空か、`waczStats.totalRecorded` が 0）は外します（`skipped`。名前と sha256 は
`replayBundle.skippedResources` に残ります）。replay が
長さ 0 の Range を求め、保管庫の 416 で JSON を読み直し続けるからです。`resources` は起点の WACZ を
先頭に、続けて深さ・撮った時刻の順です（決まった順にするためです。replay が、頁が持たない物を探す
3 本は、この並びではなく WACZ の名前の順で選ばれます）。
`initialPages`（replay が最初に見せる一覧）は文書の行で、起点が先頭です。
行に `id` が無ければ（契約の外の WACZ）、`<filename>#<何番目の行か>` を振ります。replayweb-server は
`id` が文字列でない行を読めないからです。

### 読み返す

`GET /api/crawls` と `GET /api/crawls/:id` は `replayBundle` を持ちます: クロールが指す版の
`{ key, rev, pages, builtAt, error, signedRev, digestKey, signError }`（`key` はその `replay.json` の鍵）で、
書けた版も失敗も無ければ `null` です。最初の版が書ける前の失敗は、`error` だけが値を持ちます。
`signedRev` と `digestKey` は署名した版のうち最も大きい物と、その `replay-digest.json` の鍵で、**指す版とは別に
前へだけ進みます**。`signedRev === rev` なら、クロールが指す合本は署名されています。`signError` は指す版に署名
しなかった理由です（走っているクロールの版と、署名の設定が無い配備では `null`）。
`GET /api/crawls/:id/pages` の頁は `capturedAt` と `bundledRev`（その WACZ が最初に入った版）を持ち、
`bundledRev ≤ replayBundle.rev` なら、その頁はクロールが指す合本の中にあります。

```
http://127.0.0.1:8899/?source=/wacz/<replayBundle.key>
```

### 合本を作り直す

```sh
pnpm run replay-bundle:rebuild --crawl <id>
```

同じ形で新しい版を書きます。capture-ledger の DB と保管庫を直に読み書きし、アクセストークンは使いません。打つのは、
合本に入らなかった物があるときです: 最後の段の後に reconcile が受けた取り込み、合本を書けなかった段、
migration `027` より前のクロール（先に、そのクロールのアーカイブを `crawl_pages.task_id` で
クロールに繋ぎます）。署名も API と同じに判定するので、**署名の付かなかった終わったクロールに署名し直すのも
これ**です（新しい版を書いて署名します）。書けなかった・読めなかった WACZ が在る・署名が付かなかった、の
どれでも終了コード 1 です。

:::caution[1 つの物が、クロールの鍵を全部並べる]
bucket は replayweb-server の `/wacz/` を通して匿名で読めるので、合本はクロールの WACZ の鍵を全部、
1 か所に並べます。WACZ 1 本ずつが既に持っている露出が、1 か所に集まった形です。
`pnpm run store:wipe` の後は、`replay_bundle_key` は何も無い所を指します。
:::

### 合本の署名

終わったクロールの合本には、署名を付けます（CAPTURE-61）。capture-ledger は `replay.json` のバイト列の sha256 を
[wacz-signer](https://github.com/uraitakahito/wacz-signer) の `/sign` に送って署名を貰い、**置く前に自分で検め**、
同じ置き場に `replay-digest.json` を書きます。形は WACZ の `datapackage-digest.json` と同じ
`{ "path": "replay.json", "hash": "sha256:…", "signedData": { … } }` で、`hash` は capture-ledger が計った値、`signedData` は
wacz-signer の答えの 9 つの欄（`hash`・`created`・`software`・`version`・`signature`・`domain`・`domainCert`・
`timeSignature`・`timestampCert`）そのものです。

署名するのは、次の 3 つが揃ったときだけです:

- 署名の設定が在る（下の[署名の設定](#署名の設定)）
- クロールが終わっている（`succeeded`・`failed`）。状態は、版を払い出す更新の returning で、クロールの行の鍵の
  下で読みます —— その版の中身を読んだ時の状態です
- まだ検めていない WACZ が 0 本。検められなかった WACZ は合本に入らないので、署名すると「このクロールの WACZ は
  これで全部」と言ってしまいます

走っているクロールの段の合本には署名しません。`POST /api/crawls/:id/failed` で締めたときと、次の段を投げられずに
締めたときは、**capture-ledger が締めた後に合本を 1 本書きます**（締めても段の報告は増えないので、ほかに書く者が居ません。
生きている flow が報告を送ってくることはあります: [クロールの行の終わり方](#クロールの行の終わり方)）。
段の報告は、締めたクロールを `succeeded` に戻しません（条件は行の更新の中で見ます）。

書く順は `pages.json` → `replay-digest.json` → `replay.json` です。入口の `replay.json` が現れた時点で、それを覆う
digest も在ります。署名を頼むのは版の払い出しのトランザクションの外で、TSA との往復を待つ間、クロールの行の鍵を
持ちません。

**署名が付かなくても合本は書きます**（replay は開けます）。wacz-signer が答えない・TSA に届かない（`502`）・返って
きた署名が検めを通らない・まだ検めていない WACZ が残る、のどれでも、理由を `signError` と
`crawls.replay_bundle_sign_error` に残します。署名し直すのは[作り直しの道具](#合本を作り直す)で、新しい版を書いて
署名します（前の置き場に digest を足すことはしません —— 版ごとの置き場は書いたら変えません）。

#### 何を証すか

署名が覆うのは `replay.json` のバイト列です。クロールについて証したい事は、どれもその中に書きます:

| 欄                                                    | 何か                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `resources[].hash`                                    | WACZ ごとの sha256（capture-ledger が WACZ を 1 度読んで計った物） |
| `replayBundle.pagesHash`                              | `pages.json` のバイト列の sha256                                   |
| `replayBundle.skippedResources`                       | 記録が 0 で外した WACZ の名前と sha256                             |
| `replayBundle.crawlState`・`stopReason`・`finishedAt` | 版を払い出した時のクロールの状態                                   |
| `replayBundle.crawlId`・`rev`・`pagesQueryUrl`        | どのクロールの何版で、どこに置いたか                               |

だから署名 1 つで、このクロールに**どの WACZ がどの中身で属すか**と、クロールが**どの状態で終わったか**を、
第三者が確かめられます。形の `version` は 1 のままです（欄を足しただけで、replay は `replayBundle` を読みません）。

#### 何を証さないか

- **`builtAt` は capture-ledger の時計の主張にすぎません。** 時刻として確かなのは、時刻印の genTime（TSA が押した時刻）だけ
  です。`finishedAt` も capture-ledger の時計です
- 「このクロールの WACZ はこれで全部」は、capture-ledger がその時に知っていた範囲です。報告の届かなかった取り込み（落ちた段の
  途中までに撮れた物）は入りません。後から reconcile が受けた物は、作り直せば次の版に入ります
- WACZ の中の署名（各 WACZ の `datapackage-digest.json`）は照らしません。合本の署名が言うのは、WACZ のバイト列が
  合本の言う物と同じことまでです
- `skippedResources` は名前と sha256 だけで、在り処を持ちません
- dev の CA と TSA は、信じる者の居ない開発用です。誰を信じるかは、検める人が錨（根）で決めます
- `genTime` が真であることの立証はしません。漏れた TSA の鍵は、自分の有効期間の内に遡った時刻印をなお作れます
  （RFC 3161 に残る制約で、塞ぐには独立した時刻源が要ります）

#### 署名の設定

| 変数                                     | 意味                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| `CAPTURE_LEDGER_SIGNER_URL`              | wacz-signer の `/sign`                                          |
| `CAPTURE_LEDGER_SIGNER_TOKEN`            | その Bearer                                                     |
| `CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR`     | 署名の鎖を照らす根（PEM のファイル）                            |
| `CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR` | 時刻印の局の鎖を照らす根（PEM のファイル）                      |
| `CAPTURE_LEDGER_SIGNER_TIMEOUT_MS`       | 署名を待つ時間（既定 10 秒。wacz-signer は TSA との往復を待つ） |
| `CAPTURE_LEDGER_OPENSSL_BIN`             | 時刻印を検める openssl（既定は `PATH` の `openssl`）            |

**上の 4 つで 1 組です。** 揃えば署名し、どれも無ければ署名しません。**一部だけなら起動で止まります** —— 錨が無い
と返ってきた署名を置く前に検められず、宛先が無いと錨は何にも効きません。`CAPTURE_LEDGER_CAPTURE_SIGNING=1`（WACZ に
署名を求める）なのに 4 つが無いときも止まります。起動では錨を読み（読めない・証明書が入っていないなら止まる）、
openssl が `ts -attime` を持つかを確かめます（macOS の `/usr/bin/openssl` は LibreSSL で持ちません）。作り直しの
道具も同じ判定です。dev の値は `.env.example` にあります。

置く前の検めは BrowserHive の検めを写した物（`src/replay-bundle/verify-signed-data.ts`）で、4 つの段（署名・鎖・
domain・時刻印）が**全部 ok のときだけ**署名ありと記録します。元と違い、錨の無い段や時刻印の無い署名を `skipped`
として通しません。答えの `signedData.hash` が capture-ledger の計った hash と同じかも見ます。時刻印は設定の TSA の根で検め、
**時刻印の中に入っている証明書を根に使いません**。鎖の有効期間は「いま」ではなく時刻印の genTime で見ます
（署名用の証明書は短命で、検める頃には切れているのが普通です）。

#### 合本を確かめる

```sh
pnpm run replay-bundle:verify --crawl <id>
pnpm run replay-bundle:verify --crawl <id> --rev 5
pnpm run replay-bundle:verify --crawl <id> --rev 5 --dir ./r5
```

上から、capture-ledger が指す版（保管庫から）・版を名指す・手元の写し。

| 名前        | 照らす物                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `place`     | `replay.json` の `crawlId`・`rev`・`pagesQueryUrl`・`resources[].crawlId` が、名指した置き場と同じ   |
| `digest`    | `replay-digest.json` の `path` が `replay.json` で、sha256(replay.json) = `hash` = `signedData.hash` |
| `signature` | 署名の 4 段（置く前の検めと同じ物。hash は自分で計った物）                                           |
| `pages`     | sha256(pages.json) = `replayBundle.pagesHash`                                                        |
| `wacz`      | 各 WACZ を流して計った sha256 = `resources[].hash`（1 本に 1 行）                                    |

**全部 ok のときだけ終了コード 0 です。** 1 つが落ちても残りを照らし、落ちた物を全部名指します。保管庫から読む
ときは capture-ledger の DB でクロールの組織と版を引き（`--rev` を省けば capture-ledger が指す版。署名した版が別なら、それも言います）、
設定の bucket から読みます。手元の写し（`--dir`）は、置き場の 3 つと、`resources[].name` の名前の WACZ が並ぶ
フォルダで、どの置き場の写しかを `--crawl` と `--rev` で言います（r3 の中身を r5 と言えば `place` が落ちます）。
錨は `CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR`・`CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR` を読み、`--trust-anchor`・
`--timestamp-anchor` で差し替えられます。

#### 第三者の手順

capture-ledger を使わずに確かめる手です。読むのは replayweb-server の `/wacz/`（bucket の匿名の read）からで、錨は検める人が選びます
（dev なら BrowserHive の `dev-stack/signing-ca/` の `insecure-dev-ca.crt` と `insecure-dev-tsa-ca.crt`）。

塊は手順ごとに分け、塊の中に `#` の注を書いていません。そのまま bash にも zsh にも貼れます —— zsh は既定で、
貼った行の `#` を注として読みません（`setopt interactivecomments` が無いと、注は `command not found: #` になり、
注の中の `'` から先は引用に呑まれて崩れます）。

**1. 置き場の 3 つを取る**（`<org>`・`<crawl>`・`<rev>` は確かめる置き場）

```sh
B=http://127.0.0.1:8899/wacz/org/<org>/crawls/<crawl>/r<rev>
curl -fsSO "$B/replay.json"; curl -fsSO "$B/pages.json"; curl -fsSO "$B/replay-digest.json"
```

**2. replay.json の sha256 = digest の `hash` = `signedData.hash`**（`path` は `replay.json`）

```sh
echo "sha256:$(shasum -a 256 replay.json | cut -d' ' -f1)"
jq -r '.path, .hash, .signedData.hash' replay-digest.json
```

**3. 置き場とクロールの状態**（署名の中）

```sh
jq '.replayBundle | {crawlId, rev, crawlState, stopReason, finishedAt, pagesHash}' replay.json
```

**4. pages.json の sha256 = `pagesHash`**

```sh
echo "sha256:$(shasum -a 256 pages.json | cut -d' ' -f1)"
```

**5. 各 WACZ の sha256 = `resources[].hash`**（左右が同じ行になる）。変数は `src` です —— `path` は zsh では
`PATH` と結び付いていて、読んだ途端に `curl` も `shasum` も見つからなくなります。

```sh
jq -r '.resources[] | "\(.hash) \(.path)"' replay.json | while read -r hash src; do
  echo "$hash sha256:$(curl -fsS "http://127.0.0.1:8899$src" | shasum -a 256 | cut -d' ' -f1)"
done
```

**6. 署名・鎖・domain**（署名の根は自分で選ぶ）

```sh
wacz-signer verify --file replay-digest.json --root insecure-dev-ca.crt
```

**7. 時刻印を、自分で選んだ TSA の根で**

```sh
jq -r .signedData.timeSignature replay-digest.json | base64 -d > token.tsr
jq -j .signedData.signature replay-digest.json > signature.b64
openssl ts -verify -data signature.b64 -in token.tsr -CAfile insecure-dev-tsa-ca.crt
```

**6 だけでは足りません。** `wacz-signer verify` は署名を `signedData.hash` の欄に対して検めるので、その欄が
`replay.json` の hash かは見ません（2 が要ります）。時刻印は時刻印の中の最後の証明書を根として扱うので、自作の
TSA の時刻印も通ります（7 が要ります）。根を渡さなかった段は `skipped` で、それでも `valid` と言います。
TSA の証明書が切れた後に 7 を打つなら、時刻印の時刻（`openssl ts -reply -in token.tsr -text` の `Time stamp`）を
epoch の秒にして `-attime` に渡します。`-attime` は LibreSSL（macOS の `/usr/bin/openssl`）に無いので、OpenSSL で
打ちます。

## ブラウザからアーカイブを選ぶ

`capture-api` は `/` に picker も出す —— 上の一覧を画面にしたもので、行をクリックすると
[replay](https://github.com/uraitakahito/replayweb-server) で開く。
**画面の使い方（名乗り方ごとに何を入れるか、画面に出る文の意味）は、
[アーカイブを見る](/capture-ledger/ja/picker/)にあります。**
ここに書くのは、その裏の設計だけです。

画面は、API が起動したときの名乗り方（`selectIdentity`）に合わせて組む —— 開発用ヘッダなら
名乗りの 2 欄、JWT ならトークンの欄、どちらも無ければ注意だけ。ブラウザの側では「名乗りが空」と
「JWT の設定」を見分けられない（どちらも `401` の `{"error":"unauthenticated"}`）ので、
名乗り方を知っている API が HTML を出す時点で決める（`src/api/picker.ts` の `pickerView`）。
picker はトークンを取らない。手元でトークンを出すのは Floci で、
その管理の API は届けば誰でも利用者を作れるので、`127.0.0.1` にしか出していない。`0.0.0.0` で開ける
画面が代わりに取れば、同じネットワークの誰もが誰にでもなれてしまう。

picker が replayweb-server に渡すのは `objectKey` だけ:

```
http://127.0.0.1:8899/?source=/wacz/<objectKey>
```

（符号にする前の形。link は鍵を区切りごとに符号にし、その path 全体を query の値としてもう 1 度符号にする ——
[アーカイブを見る（picker）](/capture-ledger/ja/picker/#行をクリックした後)。）

署名付き URL は使わない。あれは S3 を直接指すので viewer から見て別 origin になり、
bucket に CORS が要る。object key なら読みは replayweb-server 自身の上流（`/wacz/`）を通るので、
picker が replayweb-server に求める物はほかに無い。

:::caution[絞っているのは一覧だけで、読みではない]
`can_view` が決めるのは picker に出るかどうか。`/wacz/<key>` を**守ってはいない** ——
その経路は bucket の匿名 read で配られるので、鍵を知っていれば誰でも読める。
絞り込みが決めるのは「何を見せるか」であって「何を取れるか」ではない。
replayweb-server の `/q/<置き場>/pages`（クロールの[合本](#合本)の頁の問い）も同じ匿名の read から答える。

ここを閉じるなら署名付き URL を渡し、bucket に CORS を設定することになる。
それは別の変更。
:::

## 身元

呼び出し元の**認証**は認可とは別の問題です。本番の IdP は
Amazon Cognito に決まりました（2026-11-11）。手元の開発では、Cognito を真似る Floci を使います
（[開発用の IdP](/capture-ledger/ja/development-environment/#開発用の-idpfloci)）。
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
`src/config/identity.ts` が検証済みのクレームを `Identity` にする。JWT の主体はトークンの `sub`
（人なら IdP が付けた ID、機械ならその app client の ID）、組織は `cognito:groups` です。
呼ぶ側は `Identity` 型しか見ていません。

所属は OpenFGA に**保存していません**。リクエストごとに呼び出し元の身元から
contextual tuple として渡すので、入退社や組織変更を認可ストアへ同期する
必要がそもそも生じません。代償は**剥奪がトークンの失効待ちになる**ことで、
だからトークンは短命であるべきです。例外は機械のトークン（client credentials で取り、`sub` が
`client_id` と同じもの）です。群が載らないので、OpenFGA でその主体に `can_submit` がある組織を
API が引きます（`src/api/authorization.ts` の `submitterOrganizations`）。

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

`fga/model.fga.yaml` のアサーションは、どれも「通してはいけない人が通る」形の壊れ方を指しています。
見る側の問いは次のとおりです。始める側の問い（取り込みを始められるのは、その組織の submitter と admin だけ）も、
同じ file に並んでいます。

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
`--env-file-if-exists` を 2 つ渡しています。**後が勝ちます**）。必須のもの（`REQUIRED_ENV`）のうち、
`CAPTURE_LEDGER_FGA_STORE_ID` と `CAPTURE_LEDGER_FGA_MODEL_ID` は `fga:deploy` を走らせるまで
存在しません。この手順が `api` より前にあるのはそのためです。`.env.example` が
実際の読み取りとずれていないかは `src/tools/check-env.ts` が見ています。

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
