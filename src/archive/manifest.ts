/**
 * BrowserHive の `.result.json` manifest を読む。
 *
 * manifest は取り込み結果の永続化された複製で、成果物の隣に書かれる。BrowserHive v12
 * 以降これは **HTTP API (`POST /captures`) の応答の `report` をそのまま JSON にした物**:
 * 契約は Smithy のモデルから生成された OpenAPI (`src/rpc/generated/browserhive/openapi.json`、
 * submodule の `generated/openapi.json` の写し) で、enum は `"success"` のように綴られる。
 * v3〜v11 は protobuf JSON で、同じ値が `"CAPTURE_STATUS_SUCCESS"` だった。
 *
 * 読む前に契約の `CaptureResultReport` に照らす。protobuf の頃は生成された `fromJSON` が
 * 知らない値を黙って UNRECOGNIZED に落としていたが、JSON の写しに逆関数は無い ——
 * 照らさずに型だけ名乗ると、v11 の manifest や壊れた物が `status` の比較を素通りして
 * 台帳に入りうる。通らなければ、どの項目が駄目かを添えて投げる。呼ぶ側 (段の登録・
 * reconcile) は 1 件の失敗で止まらず、飛ばしてそう言う。
 *
 * 契約に無い項目は通す。BrowserHive が項目を足す版上げで台帳が止まらないため。
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import openapi from "../rpc/generated/browserhive/openapi.json" with { type: "json" };
import type { components } from "../rpc/generated/browserhive/openapi.js";
import { parseS3Uri, type S3Location } from "./s3-uri.js";

export type CaptureResultReport = components["schemas"]["CaptureResultReport"];

/**
 * OpenAPI の components を、`$ref` (`#/components/schemas/X`) がそのまま引ける鍵で登録する。
 * 文書ごと足すと、strict の Ajv が根の `components` を知らない keyword として断る。
 */
const ajv = new Ajv2020({ allErrors: true });
for (const [name, schema] of Object.entries(openapi.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`);
}
const validate = ajv.compile<CaptureResultReport>({
  $ref: "#/components/schemas/CaptureResultReport",
});

export const readManifest = (raw: unknown): CaptureResultReport => {
  if (validate(raw)) return raw;
  throw new Error(
    `manifest is not a BrowserHive CaptureResultReport: ${ajv.errorsText(validate.errors)}`,
  );
};

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
