/**
 * 終わった取り込みを台帳に **受け入れる** —— 行を入れ、それを到達可能にする tuple を
 * queue に積む。1 つのトランザクションで。
 *
 * ## なぜ `register` ではないのか
 *
 * 以前は `registerArchive` という名前だった。「登録する」は前半しか言っておらず、
 * **後半は「誰がそのアーカイブを読めるか」を決める部分**なのに、呼び出し箇所だけを
 * 読むと台帳に行を足しているようにしか見えなかった。
 *
 * 名前が短いことは引数に出ていた —— `orgId` と `submittedBy` は tuple のためだけに
 * 使われる。行を書くだけの操作が、なぜ誰が投げたかを知る必要があるのか、
 * 「登録」では説明できない。
 *
 * `accept` は使えない (`crawl/scope.ts` の `acceptLinks` と `runs.accepted` で
 * 別の意味に取られている)。`admit` は**入れる**と**通す**の両方を含む。
 *
 * この 2 つの書き込みは、それだけでは 1 つの原子的な操作にできない: アーカイブの
 * 行は Postgres へ、関係の tuple は OpenFGA の HTTP API へ行き、両方に跨がる
 * トランザクションは無い。独立にやると片方だけ入りうるし、その両側とも悪い ——
 * 誰も辿り着けないアーカイブか、巻き戻された行を指す権限か。
 *
 * そこで tuple の書き込みは、アーカイブと同じトランザクションの中で outbox の
 * 行として **記録** する。両方入るか、どちらも入らないか。あとは worker が
 * OpenFGA に受け入れられるまで再送しながら配送する。
 */
import type { Kysely } from "kysely";
import {
  CaptureStatus,
  captureStatusToJSON,
  type CaptureResultReport,
} from "../rpc/generated/browserhive/v1/capture.js";
import type { Database } from "../db/database.js";
import { parseS3Uri } from "./s3-uri.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "archive-admit" });

export interface AdmitResult {
  /** 何も挿入しなかったときは `undefined` —— エラーではない。下を見ること。 */
  archiveId?: string;
  reason?: "no-archive" | "already-known";
}

/**
 * 取り込みの報告から、台帳の 1 行を組む。
 *
 * 挿入から切り出してあるのは、ここが**どの field を読むか**を決めている唯一の
 * 場所だから。トランザクションと `onConflict` は配管で、Postgres を立てないと
 * 触れない。写像だけなら立てずに確かめられる。
 *
 * `waczComplete` と `signed` はどちらも 3 状態を持つ (`true` / `false` / `null`)。
 * `?? null` を落として `?.` だけにすると `undefined` が入り、Kysely は列を
 * 省いて既定値に落とす —— 「報告が届かなかった」が「NULL」ではなく「既定」に
 * 化けるので、両方とも明示する。
 */
export const archiveRow = (
  report: CaptureResultReport,
  location: { bucket: string; key: string },
): {
  taskId: string;
  correlationId: string | null;
  bucket: string;
  objectKey: string;
  sourceUrl: string;
  labels: string[];
  waczComplete: boolean | null;
  signed: boolean | null;
  capturedAt: string;
} => ({
  taskId: report.taskId,
  correlationId: report.correlationId ?? null,
  bucket: location.bucket,
  objectKey: location.key,
  sourceUrl: report.url,
  labels: report.labels,
  waczComplete: report.completeness?.complete ?? null,
  // 署名を求めていない取り込みでは報告ごと来ないので `null`。「求めたが付かなかった」
  // (`false`) とは別の主張で、後者は配備の異常を意味する。
  signed: report.signature?.signed ?? null,
  capturedAt: report.timestamp,
});

export const admitArchive = async (
  db: Kysely<Database>,
  report: CaptureResultReport,
  orgId: string,
  /**
   * 頼んだ本人。`null` なら owner の tuple を積まない。
   *
   * 本物の認証が入っても null はありうる —— 人ではなく組織に属する定期実行が
   * 投げたものがそれ。その場合、組織のメンバーは読めるが、削除できる者は居ない。
   */
  submittedBy: string | null,
): Promise<AdmitResult> => {
  // 失敗した取り込みは何もアップロードしていない。それを記録すると、署名の
  // エンドポイントが存在しないオブジェクトの URL を配ることになる —— 404 に対して
  // 認可が完璧に働いている状態で、最も気づきにくい壊れ方。
  // 比べる相手は必ず enum で、文字列ではない。report はいま protobuf —— wire でも
  // `.result.json` の manifest でも同じ —— なので `status` は数値であり、
  // `report.status !== "success"` はコンパイルは通ったうえで、これまでのすべての
  // 取り込みについて真になっていた。
  if (
    report.status !== CaptureStatus.CAPTURE_STATUS_SUCCESS ||
    report.artifacts?.wacz === undefined
  ) {
    log.warn(
      {
        taskId: report.taskId,
        status: captureStatusToJSON(report.status),
        error: report.errorDetails?.message,
        url: report.url,
      },
      "capture produced no archive; not adding to the ledger",
    );
    return { reason: "no-archive" };
  }

  // ファイル名を組み直したものではなく、server 自身の報告から取る。
  const { bucket, key } = parseS3Uri(report.artifacts.wacz);

  return db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("archives")
      .values(archiveRow(report, { bucket, key }))
      // 段の登録と reconciler の両方が同じ取り込みに辿り着けるし、どちらも
      // 再実行されうる。unique index があるので、それは重複ではなく無操作になる。
      .onConflict((oc) => oc.columns(["bucket", "objectKey"]).doNothing())
      .returning("id")
      .executeTakeFirst();

    // 既に台帳に在るということは、tuple も最初のときに queue へ積まれている。
    // もう一度書いても害は無いが、意味も無い。
    if (!inserted) return { reason: "already-known" as const };

    await trx
      .insertInto("fgaOutbox")
      .values({
        payload: JSON.stringify({
          writes: [
            {
              user: `capture_job:${report.taskId}`,
              relation: "parent",
              object: `archive:${inserted.id}`,
            },
            {
              user: `organization:${orgId}`,
              relation: "parent",
              object: `capture_job:${report.taskId}`,
            },
            // 削除は owner だけに許されている (`can_delete: owner from parent`)。
            // この tuple が無いと、そのアーカイブは誰にも消せない。
            ...(submittedBy === null
              ? []
              : [
                  {
                    user: `user:${submittedBy}`,
                    relation: "owner",
                    object: `capture_job:${report.taskId}`,
                  },
                ]),
          ],
        }),
      })
      .execute();

    log.info(
      { archiveId: inserted.id, taskId: report.taskId, orgId, objectKey: key },
      "archive registered",
    );
    return { archiveId: inserted.id };
  });
};
