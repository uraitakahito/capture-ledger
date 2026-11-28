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

`capture-api` が提供するアーカイブのエンドポイントは、下のとおりです。どれも身元が必要です。

```sh
# 1 本のアーカイブ
curl -X POST http://localhost:7070/api/archives/<id>/url
# → { "url": "http://…?X-Amz-Signature=…", "expiresIn": 300 }

# 見てよいものを新しい順に（行ごとに、読み込みの後の絵の手がかり screenshot）
curl http://localhost:7070/api/archives

# 1 本のアーカイブの、節目のスクリーンショット（WebP。下の「節目のスクリーンショット」）
curl -o after-load.webp http://localhost:7070/api/archives/<id>/screenshots/after-load

# 同じ URL の取り込みを新しい順に（下の「URL の履歴と 2 本の差分」）
curl 'http://localhost:7070/api/history?url=https://www.apple.com/'

# 同じ URL の 2 本の、文字の差分（<id> が今、since が前）
curl 'http://localhost:7070/api/archives/<id>/changes?since=<前の id>'

# その差分を Claude に要約させる（鍵が在る配備だけ）
curl -X POST http://localhost:7070/api/archives/<id>/changes/summary \
  -H 'content-type: application/json' -d '{"since":"<前の id>"}'
```

どのリクエストも形は route の JSON Schema で決まっています。説明ではなく
検査そのものが契約です。

|                                                            |                      |                                                                                        |
| ---------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `POST /api/archives/:id/url`                               | `id`                 | UUID。違えば **400**（認可より前に落ちる）                                             |
| `GET /api/archives`                                        | `before`             | ISO 8601 の日時。違えば **400**。省略すると最新から                                    |
| `GET /api/archives/:id/screenshots/:stage`                 | `id`・`stage`        | UUID と、`after-load` か `after-capture-scripts`。違えば **400**（認可より前に落ちる） |
| `GET /api/history`                                         | `url`                | 1 字以上。http(s) の URL として読めなければ **400**                                    |
|                                                            | `before`             | ISO 8601 の日時。違えば **400**。省略すると最新から                                    |
| `GET /api/archives/:id/changes`                            | `id`・`since`        | どちらも UUID で、`since` は必須。違えば **400**（認可より前に落ちる）                 |
| `POST /api/archives/:id/changes/summary`                   | `id`・本文の `since` | 同じ                                                                                   |
| `GET /api/crawls`                                          | `state`              | `running` / `succeeded` / `failed`。違えば **400**                                     |
|                                                            | `before`             | ISO 8601 の日時。違えば **400**。省略すると最新から                                    |
| `GET /api/crawls/:id/pages`                                | `after`              | 前の答えの `next`。数字だけで 18 桁まで。違えば **400**                                |
|                                                            | `limit`              | 1〜500。既定 100。外れは **400**                                                       |
| `GET /api/crawls/:id/pages/:page/log`                      | `page`               | ページの id。数字だけで 18 桁まで。違えば **400**（認可より前に落ちる）                |
| `GET /api/crawls/:id/pages/:page/trace`                    | `page`               | 同じ                                                                                   |
| `GET /api/crawls/:id/pages/:page/trace/failure-screenshot` | `page`               | 同じ                                                                                   |

`before` はカーソルで、直前に受け取った最後の行の `capturedAt`（クロールなら
`startedAt`）を渡します。`GET /api/history` だけは、答えの `next` を渡します。
知らないクエリパラメータは、拒否も削除もされず、そのまま残って無視されます。400 で断るのは、全文検索の
`GET /api/search`・`GET /api/changes`・`GET /api/history`・`GET /api/archives/:id/changes` です
（`POST /api/archives/:id/changes/summary` は、本文の知らない鍵を 400 で断ります）。

クロールの一覧は `maySubmit` で絞ります —— アーカイブのように 1 行ずつ `can_view` を
訊く形ではありません。認可モデルに `crawl` という型が無いためです。`maySubmit` は、呼び出し元の組織のどれか 1 つで
`can_submit` が通れば許し（`src/api/authorization.ts`）、許された呼び出し元には組織を問わず全部の行を返します。
だから `submitter` を与えることは**組織を跨ぐ信頼**です。権限が無い呼び出し元には 403 でも 404 でもなく**空の配列**を返し、代わりに各行へ
`orgId` を載せます —— 見えている範囲を、呼ぶ側が言えるようにするためです。
行が持つのは状態と `stopReason` の両方です。`succeeded` は「1 枚以上撮れた」なので、状態だけでは
「全部辿った」（`completed`）と「切った」（`max_depth`・`max_pages`）と「辿るリンクが無かった」（`no_links`）の区別が付きません。
`maxDepth` も載るので、辿らないクロール（深さ 0）かどうかも言えます。

**`succeeded` は 1 枚以上撮れたクロールです。** 1 枚も撮れずに終わると（全部のページが取れないか、robots で
見送り）、`failed` で締め、`stopReason` は `failed`、`error` に、取れなかった数・見送った数と最初の理由を書きます（日本語を
頼めば「1 枚も撮れませんでした（取れず 1・見送り 0）。最初の理由: …」）。機械で読む呼び手のために、行はその文の中身も持ちます: `errorKey` が文の鍵
（`crawl.nothingCaptured`・`crawl.nothingCapturedBecause`。古い migration が締めた行は
`crawl.nothingCapturedBackfilled`）、`errorParams` が文に埋めた値（`failed`・`skipped` と、在れば `reason`）です。
**いま鍵が付くのは、この文だけです。**ほかの `error`（flow が報告した失敗・人が打った理由と、capture-ledger の
ほかの決まった文 `Windmill did not take level …`・`could not start: …`）は、どちらも null です。
鍵と値の名前は、一度出したら変えません。一部だけ取れなかったクロールは `succeeded` のままで、取れなかった数は `pagesFailed`
で言います。理由は `GET /api/crawls/:id` の `failures` です（新しい 5 件）。

**capture-ledger は、自分で書いた文を、頼みの言語で返します。**`Accept-Language` を読み、英語（`en`）と
日本語（`ja`）の辞書を持ちます。`errorKey` の在る行の `error` は、鍵と値からその言語で組みます。
`GET /api/crawls`・`GET /api/crawls/:id` と、予定を返すどの答え（読む・作る・止める・戻す・いま撮る・
寄せ直す）の `recentRuns` でも同じです。

| 頼み                                                      | 鍵の在る行の `error`                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Accept-Language` が無い・`*` だけ                        | 英語                                                                      |
| `Accept-Language: ja`（`ja-JP`・`ja` の重みが一番大きい） | 日本語（「1 枚も撮れませんでした（取れず 1・見送り 0）。最初の理由: …」） |
| `Accept-Language: en`                                     | 英語（"No pages were captured (1 failed, 0 skipped). First reason: …"）   |
| 辞書の無い言語（`fr`）                                    | 英語                                                                      |

言語の名前は頭の subtag で読み、重み（`q`）の大きい順に見ます。`q=0` の物は外します。言語を訳に、頼みを
断ることはありません。答えは、返した言語を `Content-Language` に書き、`Vary: Accept-Language` を付けます。

**鍵の無い行は、どの言語を頼んでも、保存された字のまま返します。**flow が報告した失敗・人が打った理由・
ほかの道具の文です。英語を頼んでも、日本語の字のことがあります。`errorKey` と `errorParams` は言語で
変わらないので、失敗を機械で読む呼び手は、字ではなくこちらを読みます。

頼みを断るときの文は、別の扱いです。文（`hint`）は日本語のままで、答えに鍵と値（`hints`）を添え、読む側が
自分の言語に組みます（[取り込みの設定](/capture-ledger/ja/capture-options/)）。断りの文は読む側が訳し、
クロールの失敗の文は capture-ledger が訳します。

`waczCount` は、そのクロールから出た WACZ の数です。`archives.crawl_id` は、列を足すより前の行で
空なので、`crawl_pages` の `task_id` を挟んで数えています。

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

### 節目のスクリーンショット

アーカイブ 1 本の、節目のスクリーンショット（取り込みのページの viewport の絵。WebP）を返すエンドポイントです
（CAPTURE-8）。絵は BrowserHive WACZ の中の WARC の `resource` レコードで、BrowserHive v30.2.0 から、絵を撮る設定の
配備が入れます。時点は `after-load`（読み込みの後）と `after-capture-scripts`（capture scripts の後）です。BrowserHive WACZ Profile 1.30.0 より前の
WACZ は後の方を `after-behaviors` と書きます。capture-ledger は読む時に `after-capture-scripts` に寄せるので、答えはいつも新しい名です。

```sh
curl -o after-load.webp http://localhost:7070/api/archives/<id>/screenshots/after-load
# → 200 image/webp（本文が絵そのもの）
```

**capture-ledger は絵を持ちません。** WACZ を検める時（[合本](#何が入るか)）に、`datapackage.json` の
`browserhive:capture.screenshots[]` と索引の行から、絵のレコード（gzip の member 1 つ）の WACZ の中の位置を求めて
`archive_screenshots`（`041`）に書きます。求めた位置はその場で解いて、名指しの絵かを確かめます。このエンドポイントは、
その位置を**保管庫への Range の読み 1 本**で取り、gzip を解き、もう 1 度確かめて（Record-ID・時点・`image/webp`・
大きさ・WebP の頭）から返します。返すバイト列は、BrowserHive が撮ったときのままです。

アーカイブの一覧（`GET /api/archives`）と、クロールのページの行（`GET /api/crawls/:id/pages` ほか）には、読み込みの
後の 1 枚の手がかり `screenshot` が載ります。

| `screenshot`                                | 意味                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `{ "stage": "after-load", "bytes": 47692 }` | 絵が在る。このエンドポイントで読める                                                                                  |
| `{ "stage": "after-load", "skipped": "…" }` | BrowserHive が残さなかった。理由は WACZ のまま（`secret`・`withheld`・`disabled`・`task-budget`・`failed`）           |
| `{ "stage": "after-load", "problem": "…" }` | 欄は在るのに、位置を引けなかった（`no-index-line`・`warc-not-stored`・`record-mismatch` など）                        |
| `null`                                      | 記録が無い: 絵の欄の無い WACZ（v30.2.0 より前など）・まだ検めていない WACZ・クロールの外の取り込み・WACZ の無いページ |

認可は WACZ と同じ `can_view`（強整合）です。断る理由は分けません。

| 答え                                              | いつ                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 200 `image/webp`                                  | 絵を返せた。`x-content-type-options: nosniff`・`content-security-policy: sandbox`・`cache-control: private, max-age=300, immutable` を付ける |
| 400                                               | `id` が UUID でない・知らない時点（認可より前に落ちる）                                                                                      |
| 401 `{ "error": "unauthenticated" }`              | 身元が無い                                                                                                                                   |
| 404 `{ "error": "not found" }`                    | 見てよくない・行が無い・残さなかった時点・位置を引けなかった時点・WACZ が保管庫に無い。前の 4 つは保管庫を読みません                         |
| 502 `{ "error": "storage unreachable" }`          | 保管庫に届かない・返った長さが頼んだ長さと違う                                                                                               |
| 502 `{ "error": "screenshot too large" }`         | 記録した長さが上限（絵 1 MiB）を超える。保管庫を読みません                                                                                   |
| 502 `{ "error": "screenshot record unreadable" }` | 読んだ物が名指しの絵でない                                                                                                                   |

`max-age=300` は署名付き URL の寿命と同じです —— 見る許可を外した後も、この秒数だけはブラウザに残ります。WACZ は
書き換わらないので、同じ URL の絵は変わりません（`immutable`）。**絵は WACZ の中の記録で、署名した WACZ では署名の下に在ります。**

### URL の履歴と 2 本の差分

同じ URL の取り込みを一覧し、そのうちの好きな 2 本の文字を、その場で比べるエンドポイントです（CAPTURE-462）。
capture-workbench のタブ「変化」の「URL の履歴」が読みます。予定の回を自動で比べる仕組み
（[前回からの変化](/capture-ledger/ja/schedules/#前回からの変化)）は、同じ予定・同じ撮り方の 1 つ前の回だけを
比べます。こちらは、撮った日も撮り方も違う 2 本を、人が選んで比べます。結果は保存しません（2 本の WACZ から
いつでも作り直せます）。

**名乗りは `can_submit` で通し、取り込みは 1 本ずつ `can_view` で絞ります。** 一覧は弱い一貫性のまとめ訊き
（アーカイブの一覧と同じ）、差分と要約は 2 本それぞれを強整合で訊きます。WACZ の文字を返す読みなので、取り消した
直後の許しでは返しません。見てよいと分かるまで、取り込みの行も保管庫も読みません。

#### `GET /api/history?url=<URL>&before=<時刻>`

渡した URL は、クロールの起点と同じ関数（`parseHttpUrl`）で正規化してから引きます。`https://www.apple.com` は
`https://www.apple.com/` の取り込みに当たります。`#` より後ろは落とし、path の末尾の `/` の有無とクエリの並びは
揃えません。答えの `url` が、正規化した URL です。

```jsonc
{
  "url": "https://www.apple.com/",
  "archives": [
    {
      "id": "<uuid>",
      "capturedAt": "2026-11-20T19:00:32.000Z",
      "objectKey": "….browserhive.wacz",
      "crawlId": "<uuid>", // クロールに繋がらない古い行は null
      "origin": { "kind": "schedule", "scheduleId": "<uuid>", "scheduleName": "毎朝の 5 サイト" },
      "recipeSha256": "<64 hex>", // 分からなければ null
      "browserhiveVersion": "32.0.0", // 分からなければ null
      "text": { "stage": "after-capture-scripts", "sha256": "<64 hex>", "chars": 6543 },
      "notComparable": null,
    },
  ],
  "next": null, // 続きを引くときに before に渡す値。無ければ null
}
```

- 行は撮った時刻の新しい順で、1 回に `HISTORY_PAGE_SIZE`（`src/changes/history.ts`）行までです。見てよい行だけに
  絞るので、返る行はそれより少ないことがあります。**続きが在るかは `next` で見ます**（見てよい行が 0 でも、
  続きが在れば `next` は時刻です）。
- `origin.kind` は、予定の回なら `schedule`、手で始めたクロールなら `manual`、クロールに繋がらなければ `unknown` です。
- `text` は比べる行です。選び方は自動の比べと同じで、after-capture-scripts の写し、無ければ文書の行（`stage` は `null`）です。
  「1 つ前から変わったか」は、隣どうしの `text.sha256` を見比べれば分かります。capture-ledger は数えません
  （見てよくない取り込みと同じ文字かどうかを漏らさないためです）。
- 比べられない行は `text` が `null` で、`notComparable` に訳が入ります。上から順に見ます。

| `notComparable` | 意味                                                |
| --------------- | --------------------------------------------------- |
| `not_inspected` | まだ検めていない（`archives.inspected_at` が NULL） |
| `withheld`      | 比べる行の文字を、方針で伏せた                      |
| `no_text`       | 比べる行が無いか、その行に文字の記録が無い          |

クロールを頼めない名乗りには、200 で空の `archives` を返します。http(s) の URL として読めない `url` は
400 `{ "error": "invalid url" }` です。

引くのは `archives.source_url_hash`（`042` の生成列）の索引です
（[archives](/capture-ledger/ja/databases/archives/)）。

#### `GET /api/archives/:id/changes?since=<前の取り込みの id>`

`:id` が「今」、`since` が「前」です。

```jsonc
{
  "url": "https://www.apple.com/",
  "state": "diffed", // "same" | "diffed" | "not_comparable"
  "reason": null, // not_comparable のときだけ
  "sameBy": null, // same のときだけ: "digest" | "lines"
  "added": 33,
  "removed": 39,
  "hunks": [[" 文脈の行", "-消した行", "+足した行"]],
  "recipeDiffers": true, // どちらかの撮り方が分からなければ null
  "stageDiffers": false,
  "before": {
    "archiveId": "<uuid>",
    "objectKey": "…",
    "sourceUrl": "…",
    "capturedAt": "…",
    "browserhiveVersion": "28.0.1",
    "stage": "after-capture-scripts",
  },
  "after": {
    "archiveId": "<uuid>",
    "objectKey": "…",
    "sourceUrl": "…",
    "capturedAt": "…",
    "browserhiveVersion": "32.0.0",
    "stage": "after-capture-scripts",
  },
  "summary": null, // 要約が在れば { "evidence": false, "model": "…", "promptVersion": "change-pair-v1", "usd": 0.0123 }
  "significance": null,
  "headline": null,
  "quotes": [],
}
```

比べ方は自動の比べと同じです（行に割り、両端の空白と空行を落とし、前後 2 行の文脈つきの差分を作ります）。

| `state`          | 意味                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `same`           | 差分が無い。`sameBy` が `digest` なら文字の digest が同じ（**保管庫を読みません**）、`lines` なら空行と字下げだけの違い |
| `diffed`         | 差分が在る。`hunks` の形は `GET /api/crawls/:id/changes` のページと同じ                                                 |
| `not_comparable` | 比べられない。`reason` に訳。2 本のうち「今」を先に見て、最初に当たった訳を言う                                         |

| `reason`        | 意味                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_inspected` | 一覧の `notComparable` と同じ                                                                                                                                       |
| `withheld`      | 同じ                                                                                                                                                                |
| `no_text`       | 同じ                                                                                                                                                                |
| `wacz_missing`  | WACZ が保管庫に無い                                                                                                                                                 |
| `too_large`     | 2 本の行数の掛け算が `MAX_LINE_PRODUCT`（`src/changes/compare.ts`）を超えるか、解いた後の `pages.jsonl` が `ENTRY_MAX_BYTES`（`src/archive/wacz-range.ts`）を超える |

- `recipeDiffers` は、2 本のクロールの撮り方の digest（`crawls.recipe_sha256`）が違えば `true` です。自動の比べは
  撮り方が同じ回どうしだけを比べますが、こちらは違う 2 本も比べ、印を付けます。
- `stageDiffers` は、比べた行の種類が違えば `true` です（片方が after-capture-scripts の写し、片方が文書の行）。
  `before.stage`・`after.stage` が、それぞれの比べた行です（文書の行は `null`）。
- `summary`・`significance`・`headline`・`quotes` は、同じ差分の要約が派生の層（`derivations`）に在るときだけ
  載ります。この GET は Claude を呼びません。**要約は証拠ではありません**（`evidence: false`）。

**WACZ は丸ごと読みません。** 文字の digest が違う 2 本だけ、WACZ の末尾（`TAIL_BYTES`。同じ file）を 1 度に取り、
その中から zip の目次と `pages/pages.jsonl` を読みます。収まらなかった分だけ、Range で追加で取ります。WACZ 全体の
大きさは `archives.wacz_bytes` を使い、保管庫には訊きません。差分を 1 回作るたびに、保管庫への要求の回数と取った量を
ログに 1 行出します（`Archive pair compared`）。

| 答え                                     | いつ                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| 200                                      | 比べた（比べられない 2 本も 200 で、訳を返す）                                   |
| 400                                      | `id`・`since` が UUID でない・`since` が無い・知らない引数（認可より前に落ちる） |
| 401 `{ "error": "unauthenticated" }`     | 身元が無い                                                                       |
| 404 `{ "error": "not found" }`           | クロールを頼めない・どちらかを見てよくない・どちらかが無い。断る理由は分けません |
| 422 `{ "error": "different url" }`       | 2 本の `source_url` が違う                                                       |
| 502 `{ "error": "storage unreachable" }` | 保管庫に届かない・返った長さが頼んだ長さと違う                                   |

#### `POST /api/archives/:id/changes/summary`

本文は `{ "since": "<前の取り込みの id>" }` です。上の GET と同じ 2 本の差分を、Claude に要約させます。**鍵
（`CAPTURE_LEDGER_ANTHROPIC_API_KEY`）が無い配備には、このエンドポイントがありません**（404）。

自動の要約と同じ関数・同じ置き場（派生の層の `kind = 'change'`）を使います。決まりの文は別です（版 `change-pair-v1`）。
自動の要約の文は「同じ予定・同じ撮り方の前の回と今回」が前提ですが、人が選んだ 2 本は、予定も撮り方も比べた行の種類も
違いうるからです。Claude が読むのは、差分の行と前後 2 行と、2 本の撮り方の違い（答えと同じ `recipeDiffers`・`stageDiffers`）
だけです。どちらかが真のとき、決まりの文は「サイトの変化か撮り方の違いかを決めつけない」と言います。

- **同じ差分に 2 度払いません。** 差分から作る入力の digest と、決まりの文の版が同じ要約が在れば、Claude を呼ばずに
  それを返します（`reused: true`）。自動の比べが残した要約でも、同じ差分なら当たります。
- 費用は、「今」の取り込みを撮ったクロールの組織に数えます。月の上限（`CAPTURE_LEDGER_CLAUDE_BUDGET_USD`）は、
  自動の要約・capture scripts の直し方を訊く機能と分け合います。
- 残す行は、`archive_id` が「今」の取り込み、`target` が `{ archiveId, prevArchiveId }`、`created_by` が頼んだ人です。
- Claude が答えない・断るときも、自動のやり直しはしません（頼み直します）。払った試みは、月の上限に数えます。

答えは、上の GET と同じ形に `reused`（`true` か `false`）を足した物で、`summary` が必ず入ります。

| 答え                                                                  | いつ                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| 200                                                                   | 要約を返せた                                                  |
| 400・401・404・502 `storage unreachable`                              | 上の GET と同じ                                               |
| 422 `{ "error": "different url" }`                                    | 上の GET と同じ                                               |
| 422 `{ "error": "nothing to summarize" }`                             | 差分が無い（`state` が `diffed` でない）。Claude は呼びません |
| 422 `{ "error": "no organization" }`                                  | 「今」の取り込みがクロールに繋がらず、費用を数える組織が無い  |
| 429 `{ "error": "claude budget exhausted", "spentUsd", "budgetUsd" }` | 組織の月の上限に届いた。Claude は呼びません                   |
| 422 `{ "error": "claude refused" }`                                   | Claude が断った                                               |
| 502 `{ "error": "claude failed" }`                                    | Claude が答えなかったか、答えが決めた形で読めなかった         |

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
- **段を Windmill に受け取らせられなかったとき。** webhook の 4xx（flow の path・トークン・引数の誤り。408・429 を除く）は、
  送り直しても同じ答えなので、その場で行をメッセージ付きの `failed` で締めます。繋がらない・時間切れ（既定 10 秒）・5xx は、
  Windmill が受け取っていたかもしれないので締めません。その場で 3 回（初回と 2 秒・4 秒の後）、それでも受け取りを確かめられなければ
  投げる係の時計（30 秒ごと）が同じ段の鍵で送り直し、段の行を作ってから 10 分経っても受け取られなければ締めます（[段の鍵](#段の鍵)）。

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
| 段の行が無い（段の行を入れる前に始めたクロール） | 422                                                                 |
| 段の鍵と違う                                     | 422                                                                 |
| 報告済みの段                                     | **最初の答え（200）**。記録もクロールの行も書かず、次の段も投げない |
| 報告中の段（期限 2 分の内）                      | 409（flow の再試行に任せる）                                        |
| 締めた段・締めたクロール                         | 200。ページは記録し、次の段は作らない                               |

同じ段の報告が 2 回届くのは、応答が切れた後の report_level の再試行・同じ引数で流し直した flow・worker が止まった後の Windmill の
やり直しです。Windmill の「この段からやり直す」（`jobs/restart`）は Community Edition では使えません（enterprise version だけ。2026-11-12 に確かめた）。

報告の処理は 1 つのトランザクションにしません（途中で保管庫を読むので）。段を「報告中」にして試みの印と 2 分の期限を持たせ、
終わりの commit（次の段のページ・報告済み・合計の書き直し・次の段の行）は印が同じときだけ通します。期限切れで取り直した 2 本目と、
遅れた 1 本目が並んでも、片方しか書けません（遅れた方は 409）。次の段は「今回入った行」でなく、深さ n+1 の `pending` の行から作るので、
取り直した 2 回目でも途中で完了と読みません。保管庫を読む前の、報告されたページを閉じる書き込みと
[帰属](/capture-ledger/ja/databases/capture-submissions/)の書き込みは、それだけで 1 つのトランザクションにします。`reconcile` が読む行の無いまま、ページだけが閉じることはありません。

### 呼び出し元が渡せるもの

`seeds`（1 本以上の配列）は必須で、無ければ **400**。ほかに
`rules` / `maxDepth` / `maxPages` / `perHostDelayMs` / `hostParallelism` / `scripts`（ページで
走らせるもの）/ `variables`（capture scripts が宣言した、クロールごとの値。
[キャプチャオプション](/capture-ledger/ja/capture-options/#クロールごとの値)を参照）/ `userAgent` / `recordRandom`（同じ頁を参照）。
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
# → {"subject":"<sub>","organizations":["acme"],"canSubmit":true,"name":"alice","client":"cli","machine":false}
```

クロールのエンドポイントの 404 からは「許可が無い」のか「エンドポイントが無い」のかが読めない。こちらは許可が無くても
404 にせず、`canSubmit: false` と答える。`name`・`client`・`machine` は、クロールの行に残るのと同じ物
（[誰が・どこから始めたかを残す](#誰がどこから始めたかを残す)）。

### 誰が・どこから始めたかを残す

`POST /api/crawls` は、始めた主体（`requested_by`。認可に使う ID）のほかに、読むための写しを 3 つ行に残す。
`GET /api/crawls`（一覧）と `GET /api/crawls/:id`（1 本）が、同じ欄で返す。

| 欄                | 出どころ                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `requestedByName` | 人はトークンの `username`、機械（client credentials）は app client の名前                                                 |
| `requestedClient` | どの app client のトークンか。名前は `CAPTURE_LEDGER_OIDC_CLIENT_IDS` に `名前=ID` と書いた物（トークンは名前を運ばない） |
| `requestedActor`  | 呼び手が見出し `X-Capture-ledger-Actor` に書いた名前。**申告で、確かめていない**                                          |

分からない物は `null`（名前を書いていない app client・この欄より前の行）。定期の回は、名前が予定を作った者の名前で
（その名前を残す前に作った予定は `null`）、app client と申告の名前は `null`（[誰の回か](/capture-ledger/ja/schedules/#誰の回か)）。
開発用ヘッダの経路では、名前と app client が `null` で、申告の名前は見出しを送れば残る。
**3 つとも認可には使わない。** 同じ app client をいくつもの呼び手（AI の担当の席など）が使うとき、どの席かはトークンから
分からない。そこで呼び手が自分の名前を見出しで添えられるようにしてある。誰でも好きな名前を書けるので、capture-workbench は
「申告」と書いて出す。

```sh
curl -X POST http://127.0.0.1:7070/api/crawls \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" -H 'x-capture-ledger-actor: swe-seat-1' \
  -d '{"seeds":["https://example.com/"],"maxDepth":0}'
```

見出しの字は、英数字で始まる、英数字と `.`・`_`・`-` の 64 字まで。形が違えば **400** で、行は作らない。
空の見出しは、送らないのと同じ（申告なし）。
見出しは `Idempotency-Key` の照合（本文の digest）に入らない。

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

robots.txt が断ったページは見送る。組織の admin が登録した[例外の行](#robotstxt-の例外)に当たるページだけは
撮るが、そのときも robots.txt は読み、`Crawl-delay` は効き、外したページの在るホストの間隔は 2000ms より
詰めない。行ごとに、24 時間と 1 クロールの枚数の上限がある。

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

`pagesCaptured` は撮れたページの数で、起点も数える。`pagesDiscovered` は、撮ったページのリンクのうち規則が通した
**別々の URL の数**で、深さ 0 のクロールでも数える。撮らなかった物（robots で見送った物・上限で切った物）も入る。
起点は数えない（起点へ戻るリンクは「見つけた」ではない）。`linksRecorded` が `false` のクロール（リンクを 1 本ずつ
残す前のクロール）だけは、段ごとに足した延べのままで、別の段で同じ URL が出ると 2 度数えている。`pagesFailed` は
取れなかったページの数。内訳（撮った・枚数で切った・深さで切った・規則で落とした）は `GET /api/crawls/:id/links`、
規則と robots が落とした物は `GET /api/crawls/:id/decisions` で見る。

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
#     "robots": [{ "hostname": "www.example.com", "pages": 1, "limited": 0,
#                  "samples": ["https://www.example.com/private"] }],
#     "robotsOverridden": [{ "exemptionId": "7", "hostname": "www.example.com", "pages": 2, "failed": 0,
#                            "samples": ["https://www.example.com/status/1", …] }] }

curl 'http://localhost:7070/api/decisions?domain=ads.example.com&days=90&action=skip'
# → { "decisions": [{ "crawlId": "…", "startedAt": "…", "seeds": [ … ], "rule": 1, "action": "skip",
#                     "pattern": "ads.example.com", "hostname": "ads.example.com", "links": 12 }, …],
#     "truncated": false }
```

規則 `0` は、どの規則にも当たらなかったリンク。`robots` は robots.txt のために取らなかった
ページで、「なぜ撮らなかったか」を 1 か所で読める。`limited` は、そのうち[例外の行](#robotstxt-の例外)の型に
当たったが残りの枚数が尽きて見送った数（ページの理由は `robots-exemption-limit`）。`robotsOverridden` は、
robots.txt が断ったが例外の行で外したページを、行とホスト名で束ねた物。`pages` は撮れた数、`failed` は外して
撮りに行き撮れなかった数で、行の枚数の上限は両方を数える。ホスト名はポートを外す。ドメインで引くエンドポイントは、
そのホストとその下をラベルの境目で照らし、新しいクロールから並べる。`days` の既定は 90、
`action` の既定は `skip` で、500 行で切ったときは `truncated` が言う。Windmill は run の中身を
最長 30 日で消すが、この行はクロールの行がある限り残る。

### リンクを 1 本ずつ残す

段の報告は、撮ったページにあったリンクを 1 本ずつ、どうなったかと一緒に
[`crawl_links`](/capture-ledger/ja/databases/crawl-links/) に残す。次の段のページを入れるのと同じ
トランザクションで、この段のページの行を置き換える。

```sh
curl http://localhost:7070/api/crawls/9072b625-…/links
# → { "crawlId": "…", "recorded": true,
#     "summary": { "captured": 29, "failed": 0, "skipped": 0, "pending": 0,
#                  "maxPages": 28, "maxDepth": 3, "closed": 0, "skip": 69, "nofollow": 0, "hosts": 17 },
#     "pages": [{ "id": "754", "parent": null, "depth": 0, "url": "https://…/", "title": "…", "state": "captured",
#                 "reason": null, "out": { "followed": 9, "known": 0, "maxPages": 0, "maxDepth": 0,
#                                          "closed": 0, "skip": 5, "nofollow": 0 }, "in": 0 }, …],
#     "bundles": [{ "from": "757", "outcome": "max_pages", "urls": 14 }, …],
#     "hosts": [{ "hostname": "jfdb.jp", "urls": 45 }, …],
#     "cross": [["755", "763"], …], "crossTruncated": false }

curl http://localhost:7070/api/crawls/9072b625-…/links/757
# → { "out": [{ "seq": 0, "url": "https://…/tv/trick3.htm", "text": "「TRICK3」", "rule": 1,
#               "outcome": "followed", "to": "781" }, …],
#     "in":  [{ "from": "754", "text": "ドラマ出演" }] }
```

`summary` は**見つけた別々の URL（起点を除く）がどうなったか**。`captured`・`failed`・`skipped`・`pending` は
行ができた URL の結末、`maxPages`・`maxDepth`・`closed` は規則が通したのに入らなかった理由、`skip` は規則で
落とした物（`hosts` はそのホスト名の数）。同じ URL を何ページが指していても 1 つで、行の無い URL は、
最初に見つけたリンク（浅い段 → ページの id → ページの中の順）の `outcome` で数える。`pages[].out` と `in` は
そのページの出入りのリンクの数、`bundles` は行の無い URL を最初に見つけたページと理由で束ねた数、
`cross` は木に無い辺（もう行があるページへのリンク。2,000 本で切り、切ったら `crossTruncated`）。

リンクの記録が無いクロール（この表を足す前のクロール）は `recorded: false` で、ページと親（木）だけを返す。
`pnpm run links:backfill --write` が、保管庫に `.links.json` が残るクロールを埋める。

### ページと取り込みのログ

クロールが触った URL は、取る前の pending も含めて 1 つずつ `crawl_pages` の行です。それを読むエンドポイントが
2 本あります。どちらも認可は `GET /api/crawls/:id` と同じ `maySubmit` で、許可の無い呼び出し元にも、
無いクロールやページにも 404 を返します。

```sh
curl 'http://localhost:7070/api/crawls/9072b625-…/pages?limit=100'
# → { "pages": [{ "id": "1234", "url": "https://…", "depth": 0, "state": "captured", "reason": null,
#                 "taskId": "6f1c…", "archiveId": "a1b2…",
#                 "capturedAt": "2026-11-04T05:12:09.812Z", "bundledRev": 1,
#                 "logCounts": { "debug": 0, "info": 12, "warn": 1, "error": 0, "dropped": 0 },
#                 "robotsExemptionId": null,
#                 "screenshot": { "stage": "after-load", "bytes": 47692 } }, …],
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
`robotsExemptionId` は、robots.txt が断っていて[例外の行](#robotstxt-の例外)で外したページの、行の番号（字）です。
外して撮りに行き、撮れなかったページにも入ります。外していないページは `null` です。行の型に当たったが残りの
枚数が尽きたページは、`state` が `skipped`、`reason` が `robots-exemption-limit` で、番号は持ちません。

**capture-ledger は行を持ちません。** 行は取り込みのログ ——
ページで走った capture scripts が書いた物（`__bh.log`・`__bh.report`・投げた例外）、取り込みのページ自身の
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
capture scripts が報告した値も、取り込みのページが出した文も —— 読めます。`GET /api/crawls/:id`
と同じ性質です。

### 取り込みの経緯

1 回の取り込みで何がいつ起きたかを、1 本で読むエンドポイントです。[capture-workbench](https://github.com/uraitakahito/capture-workbench)
の「経緯」の画面が読みます。

```sh
curl http://localhost:7070/api/crawls/9072b625-…/pages/1234/trace
# → { "page": { …一覧と同じ形…, "submittedAt": "2026-11-04T05:12:00.012Z", "finishedAt": "2026-11-04T05:12:15.201Z" },
#     "archive": { "id": "a1b2…", "objectKey": "…/….browserhive.wacz" },
#     "capture": { "status": "success", "timestamp": "2026-11-04T05:12:15.108Z", "captureProcessingTimeMs": 14873,
#                  "httpStatusCode": 200, "settle": { "endedBy": "deadline", "waitedMs": 3105, … }, "waczStats": { … },
#                  "screenshots": [ { "stage": "after-load", "url": "urn:browserhive:screenshot:after-load:https://…/",
#                                     "date": "2026-11-04T05:12:09.120Z", "record": "urn:uuid:5b0c…", "bytes": 48213 },
#                                   { "stage": "after-capture-scripts", "skipped": "task-budget" } ],
#                  "failureScreenshot": false },
#     "log": { …ログのエンドポイントと同じ物… },
#     "trace": { "lines": [ { "kind": "request", "id": "3246.2", "hop": 0, "url": "https://…/app.js", "ms": 670,
#                              "durationMs": 97, "outcome": "finished", … }, … ],
#                "counts": { "finished": 12, "pending": 1, … }, "dropped": 0 },
#     "reason": null }
```

**capture-ledger は経緯を持ちません。** ログと同じく、そのたびに保管庫の `.result.json` を読んで返します。

- `page` は一覧と同じ形に、flow が測った投入と完了（`crawl_pages` の `submitted_at`・`finished_at`）を足した物です。
- `capture` は `.result.json` から、時間軸を組むのに要る欄を選んだ物です: `status`・`timestamp`・
  `captureProcessingTimeMs`・`httpStatusCode`・`errorDetails`・`settle`・`waczStats`・`completeness`・`document`・
  `windowsNotOpened`・`screenshots`・`random`。下位の object は書かれたままで、取り込みに無い欄は鍵ごとありません（`failureScreenshot`
  だけは別で、下に書きます）。`timestamp` は取り込みが
  終わった時刻で、`timestamp − captureProcessingTimeMs` が始まりです。ログの行の `ms` の起点（最初の行の
  `at − ms`）とは、数十 ms ずれることがあります。
- `archive` は WACZ の id と保管庫の鍵です。**鍵は、その WACZ を見てよいとき（`can_view`）だけ**で、見てよくなければ
  `objectKey` は `null` です。WACZ の無い取り込み（時間切れ・失敗）では `archive` ごと `null` です。
- `log` を持たない `.result.json`（BrowserHive v24.0.0 より前）は、`log` が `null` になるだけで、`capture` は返ります。
- `trace` は、取り込みの間の要求の出来事です（1 行 = 1 つの交信。始まり・応答・内訳・長さ・結末）。BrowserHive v30.0.0 から、
  WACZ を求めた取り込みの `.result.json` に載ります。時間切れ・失敗の取り込みにも在ります（そのときは WACZ が無いので、
  行はレコードを名指しません）。capture-ledger は行の欄を選び直さず、書かれたまま返します —— 行の形は BrowserHive の契約
  （写しの `src/rpc/generated/browserhive/openapi.json` の `CaptureTraceLine`）が決めます。それより前の取り込みと、
  WACZ を求めなかった取り込みでは `null` です。BrowserHive v30.1.0 からは、同じ行が BrowserHive WACZ の中の `trace/events.jsonl` にも
  在ります（各行の頭に `profile` が付くだけ。[BrowserHive WACZ Profile](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/ja/) 1.23.0）。**署名の下に在るのは BrowserHive WACZ の中の行で、この答えの行は
  その写しです。**
- `capture.screenshots` は、節目のスクリーンショット（取り込みのページの viewport の絵。WebP）の、時点ごとの成り行きです。
  BrowserHive v30.2.0 から、成功して WACZ を作った取り込みの `.result.json` に載ります（WACZ Profile 1.24.0）。絵を残した
  時点は BrowserHive WACZ の中のレコードを名指し（`url`・`date`・`record`・`bytes`）、残さなかった時点は理由（`skipped`）だけを
  持ちます。capture-ledger は項目を選び直さず、書かれたまま返します —— 形は BrowserHive の契約（写しの `StageScreenshot`）が
  決めます。**絵そのものは、この答えには入りません。** BrowserHive WACZ の中に在り、WACZ を見てよい者（`can_view`）が
  [節目のスクリーンショットのエンドポイント](#節目のスクリーンショット)で読みます。
  それより前の取り込みと、成功しなかった取り込みでは、鍵ごとありません。
- `capture.random` は、BrowserHive が頁の JS の乱数を記録したか（クロールの
  [`recordRandom`](/capture-ledger/ja/capture-options/#乱数を記録する)）の要約です。BrowserHive v31.1.0 から、成功して WACZ を作った
  取り込みの `.result.json` に、頼んだかどうかに関わらず載ります。乱数を記録した取り込みは `recorded: true` と `documents`・`draws`・
  `truncated`、記録しなかった取り込みは `recorded: false` と理由（`skipped`: `not-requested`・`withheld`・`failed`）を持ちます。
  capture-ledger は書かれたまま返します —— 形は BrowserHive の契約（写しの `CaptureRandom`）が決めます。記録した値そのものは
  BrowserHive WACZ の中の `random/values.jsonl` に在り、同じ要約が `datapackage.json` の `browserhive:capture.random` にも在ります
  （WACZ Profile 1.26.0）。それより前の取り込みと、成功しなかった取り込みでは、鍵ごとありません。
- `capture.failureScreenshot` は、**呼び出し元が受け取れる**失敗の時点の絵が在るかどうかの真偽です。`.result.json`
  の同じ名前の欄は保管庫の場所（`s3://…`）ですが、**場所は返しません**。絵は[下のエンドポイント](#失敗の時点の絵)が返します。
  `true` になるのは、`.result.json` が設定の bucket の中の場所を言い、かつ呼び出し元が取り込みを出した組織に属している
  ときだけです（下のエンドポイントと同じ判定）。欄の無い取り込み・設定の bucket の外や `s3://` でない場所を言う取り込みと、
  **別の組織の呼び出し元**には `false` です —— 経緯のほかの欄は、今までどおり返ります。

絵を撮るのは、BrowserHive の配備がそう設定したときだけです（`BROWSERHIVE_STAGE_SCREENSHOTS`。既定は切）。切の配備では、
`screenshots` のどの項目も `skipped: "disabled"` で、失敗の時点の絵はありません。この repo の開発スタックは入にしています
（`docker-compose.yml` の BrowserHive の環境変数）。入でも、シークレットを渡した取り込みと、方針（`no-archive`・`no-body`・
content-type の方針）が文書や画像やメディアに当たった取り込みは、絵を残しません。

読めないときも 200 で、`capture`・`log`・`trace` が `null` になり、理由（`reason`）が入ります。理由はログのエンドポイントの
上の 4 つ（`not-captured`・`no-manifest`・`manifest-missing`・`manifest-invalid`）で、`no-log` はありません。保管庫に届かなければ 502 です。

認可はログと同じ `maySubmit` です。クロールを始められる者は、どのクロールの経緯も読めます。WACZ の中身を読む許可
（`can_view`）より広いので、WACZ の鍵だけを `can_view` で絞っています。**この答えは署名の下にありません。**
示すための正は、BrowserHive WACZ の中の記録です。

### 失敗の時点の絵

失敗した取り込みが、失敗の時点に取り込みのページの viewport に見せていた絵（WebP）を返すエンドポイントです。
BrowserHive v30.2.0 から、絵を撮る設定の配備が、成果物と同じ名前の `.failure.webp` として保管庫に置きます。

```sh
curl http://localhost:7070/api/crawls/9072b625-…/pages/1234/trace/failure-screenshot
# → { "contentType": "image/webp", "base64": "UklGR…" }
```

答えは JSON で、絵は base64 です —— capture-workbench の `/api/*` の中継が、文字の答えだけを通すためです。

**絵が在るのは、取り込みのページを触っている間の失敗だけです。** 文書が 4xx・5xx だった取り込みと、文書が届いた後に
失敗した取り込み（操作ごとの時間切れ・capture scripts の失敗）で、取り込み全体の予算が残っているときに置かれます。
**文書が取り込みのページに届く前に読み込みが時間切れになった取り込みには、ありません**（どの文書の絵かを言えないため）。
取り込み全体の時間切れ・途中で切られた呼び出し・renderer の crash・方針の失敗と、絵を残さない取り込み（上の条件）にも
ありません。経緯の答えの `capture.failureScreenshot` が `true` のときにだけ、ここを読んでください。

capture-ledger は絵を持ちません。経緯と同じ道で `.result.json` を読み、その `failureScreenshot` が言う場所を読みます。

- 鍵は組みません。`.result.json` が言う場所から bucket を外した残りが鍵です。**bucket は設定と照らし**、違えば読みません
  （`.result.json` に読み先を選ばせないため）。
- 読む前に保管庫に大きさを訊き、**1 MiB を超える物は読みません**。
- 読んだ物が WebP の頭（`RIFF`…`WEBP`）を持たなければ、返しません。

| 答え                                                        | いつ                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 200 `{ "contentType": "image/webp", "base64": "…" }`        | 絵を返せた                                                                                                                                                                                                                           |
| 400                                                         | `id` が UUID でない・`page` が数字だけで 18 桁までの綴りでない（認可より前に落ちる）                                                                                                                                                 |
| 401 `{ "error": "unauthenticated" }`                        | 身元が無い                                                                                                                                                                                                                           |
| 404 `{ "error": "not found" }`                              | 絵を返せる取り込みが無い: 認可が通らない・ページが無い・取り込みの答えが無い・`.result.json` が読めない・絵を言っていない・場所が設定の bucket の外か `s3://` でない・保管庫のその場所に無い。**理由は分けません**（ログに書きます） |
| 502 `{ "error": "storage unreachable" }`                    | 保管庫に届かない                                                                                                                                                                                                                     |
| 502 `{ "error": "failure screenshot too large" }`           | その場所の物が 1 MiB を超える                                                                                                                                                                                                        |
| 502 `{ "error": "failure screenshot is not a WebP image" }` | その場所の物が WebP でない                                                                                                                                                                                                           |

**認可は、経緯より狭い線です。** 絵は取り込みのページが見せていた物そのものなので、WACZ の中身と同じ広さに置きます。
WACZ は `can_view` で絞りますが、失敗した取り込みには WACZ が無く、訊く相手の archive がありません。だから
`maySubmit` に加えて、**取り込みを出した組織（[`capture_submissions`](/capture-ledger/ja/databases/capture-submissions/)
の `org_id`）に、呼び出し元が属しているか**を見ます。組織を決めるのは capture-ledger が記録した行で、呼び出し元は選べません。
属していなければ、無いページと同じ 404 です —— 「在るが見せない」と「無い」を区別させません。経緯の答えの
`capture.failureScreenshot` も同じ線で決めるので、属していない呼び出し元には `false` が返ります。

**絵は WACZ の外のファイルで、署名の下にありません。** 取り込みのページが見せていた物をそのまま持ち、後から何も消せません。

## robots.txt の例外

クロールは robots.txt に従います（[相手に負荷をかけないために](#相手に負荷をかけないために)）。それでも撮る必要のあるページ —— 公開の投稿を証拠として残す、など —— のために、組織の admin が「このホストのこの path の型は、robots.txt が断っていても撮る」を、理由・期限・名乗る User-Agent と一緒に登録できます。行は [`robots_exemptions`](/capture-ledger/ja/databases/robots-exemptions/) に残ります。

:::note[v0.117.0 から、行がクロールに効きます]
v0.116.0 が入れたのは表と API だけでした。v0.117.0 から、capture-ledger は段を起こすたびに効く行を引き、flow の引数 `robots_exemptions` で渡します（[クロールへの効き方](#クロールへの効き方)）。robots.txt と path の型で判じるのは capture-scheduler の flow なので、**例外を判じる版の capture-scheduler が要ります**。入力を持たない古い flow は引数を黙って捨て、行を登録していても、今までどおり robots.txt に従います。
:::

入れない物も決めてあります。ログインの壁・CAPTCHA・rate limit を避ける仕組みと、browser の名に見せかける名乗りは、例外の対象にしません。相手の利用規約は、登録する人が別に確かめます。

### 行が言うこと

| 欄                        | 中身                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgId`                   | どの組織の例外か。本文で名指す（名乗りの 1 つ目の組織に頼りません）                                                                               |
| `host`                    | ホスト。`example.test` や `example.test:8443` の形で、scheme・path・wildcard は書けません。`url.host` の形（小文字・punycode）に整えて残します    |
| `pathPattern`             | robots.txt と同じ書き方の path の型（`*` と末尾の `$`）。省くと `/`（ホストの全て）。`/` で始まる 1 行で、空白と `#` を含まない ASCII、256 字まで |
| `scope`                   | `seeds`（起点だけ）か `links`（辿ったリンクも）                                                                                                   |
| `appliesTo`               | `all`（どのクロールにも。既定）か `human`（人が始めたクロールにだけ）                                                                             |
| `userAgent`               | このホストで名乗る名（下記）                                                                                                                      |
| `reason`                  | 理由。1〜500 字                                                                                                                                   |
| `expiresAt`               | 期限。offset つきの ISO 8601 の時刻で、登録より後・90 日以内。延ばす時は新しい行を登録します                                                      |
| `dailyLimit`・`linkLimit` | この行で外して撮る枚数の上限。24 時間で（1〜10000。既定 100）と、1 クロールの辿ったリンクで（1〜1000。既定 20）                                   |

同じ組織・ホスト・path の型で効いている行は 1 つまでです。同じ組織・ホストで効いている行の名乗りは 1 つに揃えます。どちらも、破る登録は 409 で断ります。

### クロールへの効き方

行が当たるのは、**robots.txt が断っていて、URL の path が行の型に当たるページだけ**です。robots.txt は今までどおり読み、`Crawl-delay` も効きます。断られていないページには何も起きません（そのホストを行の名乗りで撮ること、を除きます。下記）。

**どのクロールに効くか。** 行はクロールの組織（`crawls.org_id`）の物だけが当たります。そのうえで、クロールを始める時に「資格」を 1 度だけ決めて行に残します（`crawls.exemption_eligibility`）。

| 資格      | 当たる行                  | どのクロールか                                                                                                                                |
| --------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `human`   | 全ての行                  | 人が `POST /api/crawls` で始め、クロールの組織で始めてよい（`can_submit`）                                                                    |
| `machine` | `appliesTo` が `all` の行 | 機械の主体（client credentials のトークン）が始めた。または定期の回（[誰の回か](/capture-ledger/ja/schedules/#誰の回か)。「いま撮る」の回も） |
| `none`    | 無し（robots.txt に従う） | 主体がクロールの組織で `can_submit` を持たない。またはヘッダで名乗る経路（`CAPTURE_LEDGER_DEV_IDENTITY=1`）で始めた                           |

資格を別に訊くのは、クロールの組織が名乗りの 1 つ目で決まり、始めてよいと許した組織とは限らないためです（[誰が始めてよいか](#誰が始めてよいか)）。名乗りが A・B で許しは B だけの主体のクロールは A の物になりますが、A で許しを持たないので `none` になり、A の行は当たりません。訊くのは、クロールの組織 1 つについての保存された関係だけです（所属の申告は一緒に渡しません）。

**範囲と深さ。** `scope` が `seeds` の行は起点（深さ 0）にだけ、`links` の行は起点にも辿ったリンクにも当たります。

**残りの枚数。** 行ごとに、段を起こす時に残りを数えて渡します。24 時間でその行で外した数を `dailyLimit` から引き、深さ 1 から先では、そのクロールの辿ったリンクで外した数を `linkLimit` から引いた物との小さい方です。**外して撮りに行き、撮れなかったページも数えます**（相手に要求は届いています）。残りが尽きると、型に当たったページは理由 `robots-exemption-limit` で見送ります。

**名乗り。** その段で効く行の在るホストのページは、robots.txt が断っていないページも、行の `userAgent` で撮ります（クロールの `userAgent` は、そのホストでは使いません）。robots.txt を照らす名前も、その名乗りから決まります。外したページの在るホストの間隔は、2000 ms より詰めません。

**取り消しと期限切れは、次に起こす段から効きます。** 引いた行は段の行（[`crawl_levels`](/capture-ledger/ja/databases/crawl-levels/) の `args`）に残り、段の送り直し（10 分まで）は残した引数をそのまま送ります。もう起こした段には効きません。走っているクロールも、次の段からは外れます。全ての行を取り消せば、次の段からどのクロールも robots.txt に従います。

**記録。** 外したページは、ページの行に行の番号が残ります（[ページと取り込みのログ](#ページと取り込みのログ)の `robotsExemptionId`、[規則が何を決めたか](#規則が何を決めたか)の `robotsOverridden`）。WACZ には、flow が撮る要求に付けた申告（BrowserHive の `robotsOverride`）が、`datapackage.json` の `browserhive:capture.robotsOverride` に残ります。申告は行から組んだ 7 つの欄です。

| 欄            | 中身                                            |
| ------------- | ----------------------------------------------- |
| `exemptionId` | 行の番号                                        |
| `reason`      | 行の理由                                        |
| `pathPattern` | 行の path の型                                  |
| `scope`       | 行の範囲                                        |
| `grantedBy`   | 登録した人の読める名前。名前が無ければ主体の ID |
| `grantedAt`   | 登録の時刻（UTC の ISO 8601。`Z` で終わる）     |
| `expiresAt`   | 期限（同じ形）                                  |

申告は求めた側（capture-ledger）の言い分で、BrowserHive は確かめずに書きます。申告を受けるのは BrowserHive v32.2.0 からです。配備の形式に WACZ が無い時は、flow は申告を付けません（その時も、ページの行の番号は残ります）。

### 名乗りは偽らない

`userAgent` は必須で、形は道具の名と、名乗りを説明する頁の URL だけを書く括弧の注 1 つに限ります。

```text
BrowserHive/1.0
BrowserHive/1.0 (+https://example.test/bot)
```

- 頭は `BrowserHive/<版>`。版は英数字と `.+-` で 32 字まで。
- 注は任意で 1 つ。中身は `+https://…`（か `+http://…`）の URL ちょうど 1 つです。地の文は書けません（`(compatible; Googlebot)` のように、ほかのクローラや browser の名を並べて名乗れてしまうため）。
- 全体で 512 字まで。
- 字のどこにも（URL の中も）、browser とよく知られたクローラの名を含められません（`mozilla`・`chrome`・`safari`・`applewebkit`・`gecko`・`firefox`・`msie`・`trident`・`crios`・`fxios`・`compatible`・`google`・`bingbot`・`twitterbot`・`facebookexternalhit`・`applebot` など。大文字小文字を問わない。`{chrome}` と、語としての `edg`・`edge`・`edga`・`edgios`・`opr`・`opera` も）。
- URL の path に、英字の直後の `/` と数字は置けません。製品の印の形（`/Edg/131.0`）で、日付や番号の段（`/docs/2024`）もこれと見分けられないので、同じく断ります。

### API

```sh
# 一覧（効いている行・切れた行・取り消した行）
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/robots-exemptions
# → { "exemptions": [ { "id": "7", "orgId": "acme", "host": "example.test", …, "state": "active", "usedLast24h": 3 } ] }

# 登録
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  http://127.0.0.1:7070/api/robots-exemptions \
  -d '{"orgId":"acme","host":"example.test","pathPattern":"/*/status/*","scope":"seeds",
       "userAgent":"BrowserHive/1.0 (+https://example.test/bot)",
       "reason":"公開の投稿を証拠として残す","expiresAt":"2026-12-28T00:00:00+09:00"}'
# → 201 と、登録した行

# 取り消し（行は消えず、state が revoked になる）
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7070/api/robots-exemptions/7/revoke
# → 200 と、取り消した行
```

行は `id`（字）・`orgId`・`host`・`pathPattern`・`scope`・`appliesTo`・`userAgent`・`reason`・`dailyLimit`・`linkLimit`・`createdBy`・`createdByName`・`createdAt`・`expiresAt`・`revokedAt`・`revokedBy`・`revokedByName`・`state` を持ちます。`state` は `active`（効いている）・`expired`（期限が過ぎた）・`revoked`（取り消した）のどれかです。一覧の行だけが `usedLast24h` を持ちます。24 時間の内に、その行で robots.txt を外したページの数で、`dailyLimit` と比べる数です（外して撮りに行き、撮れなかったページも含みます）。

| 答え | いつ                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401  | 名乗りが無い                                                                                                                                              |
| 403  | 登録・取り消しを、機械の主体が頼んだ／ヘッダで名乗る経路で頼んだ／その組織の admin でない者が頼んだ（訳は下の句）                                         |
| 400  | 本文の中身が駄目。`{ "error": "<訳>", "field": "<欄の名前>" }` で、最初に見つけた 1 つを返す。知らない鍵も 400                                            |
| 404  | 取り消しで、行が無い。呼び手の名乗りの組織に無い行も同じ答え（在ることを漏らしません）                                                                    |
| 409  | 登録が、効いている行と重なる（同じ path の型。答えに行の `id`）／名乗りが違う（答えに今の `userAgent`）。取り消しで、もう取り消してある／期限が過ぎている |

403 の `error` は決まった句です。

| 句                                                           | 意味                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `not an organization admin`                                  | その組織の admin でない（本文の `orgId` が名乗りの組織に無い時も同じ句）          |
| `machine identities cannot manage robots exemptions`         | 機械の主体（client credentials のトークン）は登録・取り消しができない             |
| `robots exemptions are not available with header identities` | ヘッダで名乗る経路（`CAPTURE_LEDGER_DEV_IDENTITY=1`）では登録・取り消しができない |

### 誰が登録できるか

- **読む**（`GET`）のは、名乗りの組織のうち、クロールを始めてよい（`can_submit`）組織の者です。その組織の行だけが返り、そういう組織が無ければ空の一覧が返ります。
- **登録と取り消し**は、その組織の **admin** で、人だけです。`can_submit` より狭く、OpenFGA に保存した関係 `admin` を直に訊きます（所属の申告は一緒に渡しません）。

admin は、次の命令で付けます。

```sh
pnpm run fga:grant admin <user> <org>
```

`<user>` は呼び出し元の主体（JWT ならトークンの `sub`）です。admin は `can_submit` も持つので、付けるとその人はその組織のクロールも始められます。

機械の主体とヘッダの経路を断るのは、次の訳です。例外を足すのは人の判断で、道具に任せません（AI の担当の狭い scope は、[scope の門](/capture-ledger/ja/development-environment/)が先に断ります）。ヘッダの経路では主体そのものが呼び手の申告なので、admin の主体を名乗れば検査が通ってしまいます。手元で登録を試す時は、JWT の経路（Floci）で名乗ります。

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
`after-load`、capture scripts の後が `after-capture-scripts`。BrowserHive WACZ Profile 1.30.0 より前の WACZ は `after-behaviors` と
書き、capture-ledger は `after-capture-scripts` として索引します）。行の `url` は写しの urn
（`urn:browserhive:snapshot:after-load:https://…` の形で、文書の URL はその後ろ）です。
capture-ledger は行ごとに 1 件として載せ、時点を `stage` に入れます。同じアーカイブの
検索前と検索後が両方当たれば 2 件返ります。認可はアーカイブで決まるので、2 件の答えは
同じです。

WACZ Profile 1.18.0 から、1 行目はいつでも取り込んだ文書の行です。`stage` が無く、`url` は
要求の URL で、題と本文は capture scripts の後に読んだ物 —— `after-capture-scripts` の行とほぼ同じ文です。
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
`pages.json` を、capture-ledger が保管庫に書きます。[replay](https://github.com/uraitakahito/replayweb-player) は
それを 1 つのアーカイブとして開き、ある WACZ の頁から別の WACZ の頁へリンクで行けます。
形（v1）は replayweb-player の `docs/replay-bundle.md` にあります。

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
`document.url`（リダイレクトの後）を `parseHttpUrl` と同じ形に正規化した物で、replayweb-player が
頁を引く鍵です。写しの行には付けません。

各行には、文字（`text`）の sha256 と長さ、伏せた理由（`textWithheld`）も入れ、`datapackage.json` の
`browserhive:capture.build.version` と `browserhive:capture.browser.product` から撮った BrowserHive と Chrome の版を `archives` に入れます（`035`）。前回からの変化（[定期実行](/capture-ledger/ja/schedules/)）は、
digest が同じページの WACZ を開かずに「同じ」と言えます。文字そのものは capture-ledger の DB に持ちません。
`035` より前の行は `pnpm run changes:backfill` が埋めます。

同じ検めで、節目のスクリーンショットの在り処も `archive_screenshots`（`041`）に書きます（[節目のスクリーンショット](#節目のスクリーンショット)）。
検めの後の別のトランザクションで書くので、絵の記録で失敗しても検めは巻き戻りません。印（`archives.screenshots_recorded_at`）が
立たないまま残り、`041` より前に検めた行と一緒に `pnpm run screenshots:backfill` が埋めます（`--verify` は書かずに、
書いた位置を保管庫への Range の読みで確かめます）。

記録が 0 の WACZ（索引が空か、`waczStats.totalRecorded` が 0）は外します（`skipped`。名前と sha256 は
`replayBundle.skippedResources` に残ります）。replay が
長さ 0 の Range を求め、保管庫の 416 で JSON を読み直し続けるからです。`resources` は起点の WACZ を
先頭に、続けて深さ・撮った時刻の順です（決まった順にするためです。replay が、頁が持たない物を探す
3 本は、この並びではなく WACZ の名前の順で選ばれます）。
`initialPages`（replay が最初に見せる一覧）は、`pages.json` の行を replayweb-player の `/q/` が問いなしで
答える並び（深さ → 時刻 → `id`）にした先頭の 25 行です。文書の行も DOM の写しの行（after-load・after-capture-scripts）も
入ります。起点が先頭に来て、replay は一覧の 2 ページ目を `/q/` の 26 行目から読むので、切れ目なく続きます。写しの行の
`isSeed` は同じ頁の文書の行と同じです（深さ 0 なら true）。起点と起点でない行が混ざると、replay は既定で `isSeed` の
行だけを並べるからです。
行に `id` が無ければ（BrowserHive WACZ でない WACZ）、`<filename>#<何番目の行か>` を振ります。replayweb-player は
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
bucket は replayweb-player の `/wacz/` を通して匿名で読めるので、合本はクロールの WACZ の鍵を全部、
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

capture-ledger を使わずに確かめる手です。読むのは replayweb-player の `/wacz/`（bucket の匿名の read）からで、錨は検める人が選びます
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
[replay](https://github.com/uraitakahito/replayweb-player) で開く。
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

picker が replayweb-player に渡すのは `objectKey` だけ:

```
http://127.0.0.1:8899/?source=/wacz/<objectKey>
```

（符号にする前の形。link は鍵を区切りごとに符号にし、その path 全体を query の値としてもう 1 度符号にする ——
[アーカイブを見る（picker）](/capture-ledger/ja/picker/#行をクリックした後)。）

署名付き URL は使わない。あれは S3 を直接指すので viewer から見て別 origin になり、
bucket に CORS が要る。object key なら読みは replayweb-player 自身の上流（`/wacz/`）を通るので、
picker が replayweb-player に求める物はほかに無い。

:::caution[絞っているのは一覧だけで、読みではない]
`can_view` が決めるのは picker に出るかどうか。`/wacz/<key>` を**守ってはいない** ——
その経路は bucket の匿名 read で配られるので、鍵を知っていれば誰でも読める。
絞り込みが決めるのは「何を見せるか」であって「何を取れるか」ではない。
replayweb-player の `/q/<置き場>/pages`（クロールの[合本](#合本)の頁の問い）も同じ匿名の read から答える。

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
