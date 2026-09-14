---
title: capture_submissions
description: 投げた瞬間に「誰のために投げたか」を残すテーブル。組織を知る唯一の出どころ。
---

**投げた瞬間に「誰のために投げたか」を残すための表です。**

```ts file="src/db/migrations/004-capture-submissions-and-org-id.ts#capture-submissions-columns"

```

取り込みごとの結果 manifest の在り処は `014` で足しました。

```ts file="src/db/migrations/014-add-capture-submissions-manifest.ts#capture-submissions-manifest-columns"

```

## なぜ必要か

**BrowserHive に「組織」という概念はありません。** 取り込みを投げるとき capture-ledger は
URL と設定だけを渡し、返ってくるのは `taskId` です。

後から bucket の `.result.json` を拾って台帳を埋めるとき、その manifest には
**組織を特定するものが何も入っていません**。だから投げた瞬間にここへ記録して
おくのが唯一の出どころになります。

```
capture-ledger が知っている        BrowserHive が知っている
─────────────────          ─────────────────────
capture_targets.org_id ──┐      taskId
                         │      成果物の場所
                         └──→   （組織は知らない）
              capture_submissions
              task_id → org_id の対応
```

この行が無いと、reconciler は「このアーカイブは誰のものか」を言えません。

## 書かれ方

段の報告を受ける handler（`src/api/crawls.ts`）が、報告のうち `taskId` を持つページ
すべて（失敗も含む）について 1 行ずつ書きます。その取り込みの `.result.json` が
書かれた場所も一緒です。

```ts
submitted.map((r): Insertable<CaptureSubmissionsTable> => ({
  taskId: r.taskId,
  correlationId: r.correlationId ?? crawlId,
  orgId: crawl.orgId,
  submittedBy: crawl.requestedBy,
  manifestKey: manifests.get(r.taskId)?.key ?? null,
  manifestError: manifests.get(r.taskId)?.error ?? null,
}));
```

**capture-ledger は manifest の鍵を組みません。** BrowserHive（または受け口）は `Capture`
の応答で manifest を書いた場所を答え、Windmill の flow がそれを `manifestLocation` として
運びます。handler は、その場所が設定の bucket の中なら鍵の部分を残します。manifest を
書けなかった取り込みは代わりに `manifestError` で報告され、その理由がここに入ります。
別の bucket や `s3://` でない場所も理由として入ります —— 読み先を報告する側に選ばせない
ためです。

`taskId` を持つのに、この 2 つのちょうど 1 つを持たない報告は 400 で断ります。受け付けると、
読みに行く先の無い取り込みが残るからです。

`taskId` は BrowserHive が採番し、使い回されることはありませんが、段の報告が送り直される
ことはあるので `onConflict … doNothing()` を置いています。

## 読まれ方

`reconcile.ts` が、bucket の manifest から台帳を埋めるときに引きます。

```
.result.json から taskId を得る
  → capture_submissions で org_id と submitted_by を引く
  → archives に登録し、その org_id と submitted_by で tuple を積む
```

## 列の要点

| 列               | 要点                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `task_id`        | **主キー。** BrowserHive が採番したもので、結果の報告へ戻る join の鍵                                                         |
| `org_id`         | `not null`。**この表が在る理由そのもの**                                                                                      |
| `submitted_by`   | それを求めた利用者。**人ではなく組織に属する定期実行では NULL**                                                               |
| `submitted_at`   | `now()` 既定                                                                                                                  |
| `manifest_key`   | その取り込みの `.result.json` の在り処（bucket を除く）。報告のまま。`manifest_error` が在るときと、`014` より前の行では NULL |
| `manifest_error` | 台帳が読める manifest が無い理由。書けなかったか、報告された場所が設定の bucket の外                                          |

:::caution[`submitted_by` は認証の結果ではありません]
この列を埋めているのは、API のリクエストが名乗った主体です
（[身元](/capture-ledger/ja/archive-ledger/#身元)）。**開発用のヘッダ経路では検証されません**
—— `CAPTURE_LEDGER_DEV_IDENTITY=1` のとき `X-Capture-ledger-Subject` はそのまま信じられ、誰の名前でも
入ります。JWT の経路では署名と期限が検証されます。

それでも `null` のままにしないのは、この値がそのまま `capture_job` の
`owner` tuple になるからです。埋まっていないアーカイブは、
[`can_delete`](/capture-ledger/ja/archive-ledger/#認可モデル) が `owner from parent`
だけを見るので、**誰にも削除できません**。
:::

:::note[台帳と件数が一致しません]
この表には**投げたものすべて**が入りますが、[`archives`](/capture-ledger/ja/databases/archives/)
に入るのは**アーカイブを生んだものだけ**です。失敗した取り込みは何もアップロード
していないので、差が出るのが正常です。
:::
