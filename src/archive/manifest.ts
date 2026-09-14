/**
 * BrowserHive の `.result.json` manifest を読む。
 *
 * manifest は取り込み結果の永続化された複製で、成果物の隣に書かれる。BrowserHive
 * v3 以降これは **protobuf JSON**: server は `Capture` の応答に載せるのと同じ
 * `CaptureResultReport` メッセージを、生成された `toJSON` を通して直列化している。
 *
 * つまり enum は protobuf の名前で綴られる —— `status` は `"success"` ではなく
 * `"CAPTURE_STATUS_SUCCESS"` —— し、ここで誰も手でオブジェクトを解析していないのは
 * そのため。`fromJSON` は書き手の生成された逆関数なので、復号した report は wire から
 * 戻ってきたものと形が同一になり、呼ぶ側は 2 つの経路のどちらで届いたかを気にせず
 * `CaptureStatus` の enum と比べられる。
 */
import { CaptureResultReport } from "../rpc/generated/browserhive/v1/capture.js";
import { parseS3Uri, type S3Location } from "./s3-uri.js";

export const readManifest = (raw: unknown): CaptureResultReport =>
  CaptureResultReport.fromJSON(raw);

/** 台帳に書く manifest の結末。どちらか一方だけが値を持つ。 */
export type ManifestOutcome = { key: string; error: null } | { key: null; error: string };

/**
 * 段の報告が運んだ manifest の結末を、台帳に書く形にする。
 *
 * **鍵は組まない。** 書いた本人 (BrowserHive か受け口) が「ここに書いた」と答えた場所から
 * bucket を外し、残りをそのまま鍵にする。以前はここで BrowserHive の命名規則を写して綴りを
 * 組み直していたが、写しは間違えても静かに壊れ、bucket を一覧して拾う reconcile がその穴を
 * 隠していた。答えを持っている相手に訊けば、写しは要らない。
 *
 * **読むのは設定の bucket だけ。** 報告に入っていた bucket を信じると、報告する側が
 * 読み先を選べる (`.links.json` を読むときと同じ理由)。違う bucket や `s3://` でない
 * 場所は、読めない理由として残す —— **段の報告は落とさない。** 台帳が遅れることより、
 * クロールが止まることのほうが重い。
 */
export const manifestOutcome = (
  report: { manifestLocation?: string; manifestError?: string },
  bucket: string,
): ManifestOutcome => {
  if (report.manifestError !== undefined) return { key: null, error: report.manifestError };
  const location = report.manifestLocation ?? "";
  let parsed: S3Location;
  try {
    parsed = parseS3Uri(location);
  } catch {
    return { key: null, error: `not an s3:// location the ledger can read: ${location}` };
  }
  if (parsed.bucket !== bucket) {
    return {
      key: null,
      error: `written to bucket ${parsed.bucket}, but the ledger reads ${bucket}: ${location}`,
    };
  }
  return { key: parsed.key, error: null };
};
