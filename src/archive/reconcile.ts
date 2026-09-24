/**
 * 台帳の穴を、報告が書き留めた manifest の鍵から埋める。
 *
 * 段の報告は、取り込みごとに `capture_submissions` へ帰属 (組織・依頼者) と、BrowserHive
 * (または受け口) が `.result.json` を書いた場所の鍵を残す。段の登録 (`crawl/admit-level.ts`)
 * はその場で manifest を読んで台帳に入れるが、そこで入らなかったもの —— manifest の
 * 読み取りが一時的に落ちた、台帳への書き込みが落ちた —— が穴になる。これはその行を拾い直す。
 *
 * ## bucket は歩かない
 *
 * 以前は bucket を一覧して `.result.json` を探し、鍵の綴りから taskId を読んでいた。
 * 一覧は鍵を URL 符号化で返し、それを戻す読み方を実装ごとに合わせる必要があった
 * (SeaweedFS は鍵の最後の部分の空白を `+` で返し、`decodeURIComponent` はそれを戻さない)。
 * **鍵は書いた本人が答えている。** それを台帳に書き留めてあるので、読むのはその鍵だけ。
 * 一覧の符号化も、鍵から taskId を読む工夫も、絞るための接頭辞も要らない。
 *
 * ## 拾えないもの
 *
 * - **段の報告が届かなかった取り込み。** `capture_submissions` の行が無く、帰属も鍵も
 *   分からない。以前の一覧でも、見つけた manifest は帰属が無いので登録できなかった
 *   (`unattributed` として数えるだけだった)。
 * - **manifest を書けなかったと報告された取り込み。** 鍵が無い。予算切れと書き込みの
 *   完了が競って後から書けていた場合も、ここからは見えない。
 *
 * ## 規模
 *
 * 問うのは DB の未登録の行だけで、S3 には鍵を指定した GetObject しか投げない。手間は
 * bucket の大きさではなく、未登録の取り込みの数で決まる。成果物の無い manifest
 * (cancelled など) は台帳が受け付けないので、回すたびに読み直す —— 以前と同じ。
 */
import type { Kysely } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import { readManifest } from "./manifest.js";
import type { Database } from "../db/database.js";
import { getJsonObject } from "./s3.js";
import { admitArchive } from "./admit.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "archive-reconcile" });

export interface ReconcileResult {
  /** 報告は届いたのに台帳に入っていない、鍵の在る取り込み。 */
  pending: number;
  registered: number;
  /**
   * manifest は在ったが台帳が受け付けなかった (成果物の無い cancelled など)、または
   * 契約の形でなかった (v11 以前の protobuf JSON など。理由は warn に出る)。
   */
  skipped: number;
  /** 「書けた」と報告された場所に manifest が無かった。 */
  missing: number;
}

export const reconcile = async (
  db: Kysely<Database>,
  s3: S3Client,
  bucket: string,
  /** これより後に報告された取り込みだけ。省くと全部。 */
  since?: Date,
): Promise<ReconcileResult> => {
  let query = db
    .selectFrom("captureSubmissions as s")
    .leftJoin("archives as a", "a.taskId", "s.taskId")
    .select(["s.taskId", "s.manifestKey", "s.orgId", "s.submittedBy"])
    .where("a.taskId", "is", null)
    .where("s.manifestKey", "is not", null)
    // `is not null` で絞っても Kysely は列の型を狭めない。**型を言い張るだけ**なので、
    // 上の where を消しても typecheck は緑のまま —— 絞っていることは試験が見ている。
    .$narrowType<{ manifestKey: string }>();
  if (since !== undefined) query = query.where("s.submittedAt", ">=", since);
  const pending = await query.execute();

  const result: ReconcileResult = {
    pending: pending.length,
    registered: 0,
    skipped: 0,
    missing: 0,
  };

  for (const row of pending) {
    const raw = await getJsonObject(s3, bucket, row.manifestKey);
    if (raw === undefined) {
      // 一覧を挟まないので「消えた」とは言わない。言えるのは「報告された場所に無い」だけ。
      result.missing += 1;
      log.warn(
        { taskId: row.taskId, key: row.manifestKey },
        "Manifest is not where the capture reported writing it",
      );
      continue;
    }

    // 契約の形でない manifest (BrowserHive v11 以前が書いた protobuf JSON など) は、
    // 飛ばしてそう言う。1 件で回し全体を止めない —— 残りの行は読める。
    let report;
    try {
      report = readManifest(raw);
    } catch (err) {
      result.skipped += 1;
      log.warn(
        { err, taskId: row.taskId, key: row.manifestKey },
        "Manifest is not a report the ledger can read; skipping it",
      );
      continue;
    }

    // 冪等: 段の登録との競合は unique index が吸収する。identity はここでは作らない ——
    // reconcile は掃除役で、いま動かしている人と取り込みを頼んだ人は別。投げた時点の
    // 記録から読む。
    const admitted = await admitArchive(db, report, row.orgId, row.submittedBy);
    if (admitted.archiveId !== undefined) result.registered += 1;
    else result.skipped += 1;
  }

  log.info(result, "Reconcile complete");
  return result;
};
