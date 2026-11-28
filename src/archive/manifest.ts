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
 * capture-ledger に入りうる。通らなければ、どの項目が駄目かを添えて投げる。呼ぶ側 (段の登録・
 * reconcile) は 1 件の失敗で止まらず、飛ばしてそう言う。1 ページのログのエンドポイント
 * (`GET /api/crawls/:id/pages/:page/log`) と経緯のエンドポイント (`GET /api/crawls/:id/pages/:page/trace`) は、
 * 投げたら `manifest-invalid` と答える。失敗の時点の絵のエンドポイント (`…/trace/failure-screenshot`) は 404 と答える。
 *
 * 契約に無い項目は通す。BrowserHive が項目を足す版上げで capture-ledger が止まらないため。
 *
 * **契約に `format` が入ると、この file の import で落ちる。** Ajv は `date-time` や `double` を知らず
 * (ajv-formats は依存に無い)、strict のまま compile すると投げる —— API は起動しない。compile するのは
 * `CaptureResultReport` から辿れる schema だけなので、写しを上げるときはそこに `format` が増えていないかを見る
 * (BrowserHive は、取り込みのログの時刻を Timestamp ではなく String に、数を Integer にしてある)。
 *
 * 契約が既定値を持つ項目は、欠けていれば既定値で補ってから照らす（Ajv の `useDefaults`）。
 * Smithy の `@default` は「無ければその値」という意味で、後から required になった項目を
 * 持たない古い manifest も、そのまま読めるようにするため。いま該当するのは、v12.2.0 で
 * required（既定 0）になった `waczStats.totalSkippedUrlPolicy`（それより前の server が書いた
 * manifest はこの欄を持たない。2026-09-26 に共有の保管庫で数えると、1677 本のうち 384 本）と、
 * v20.0.0 で同じく足した `waczStats.totalNotIntercepted`（本文をバイト列で読めなかった応答の数）と、
 * v29.0.0 で同じく足した `waczStats.totalSkippedSecret`（隠す値を含むので本文を落として記録した応答の数）。
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import openapi from "../rpc/generated/browserhive/openapi.json" with { type: "json" };
import type { components } from "../rpc/generated/browserhive/openapi.js";
import type { LogCounts } from "../db/database.js";
import { parseS3Uri, type S3Location } from "./s3-uri.js";
import { normalizeStage, recordStageNames } from "./stage-name.js";

export type CaptureResultReport = components["schemas"]["CaptureResultReport"];

/**
 * OpenAPI の components を、`$ref` (`#/components/schemas/X`) がそのまま引ける鍵で登録する。
 * 文書ごと足すと、strict の Ajv が根の `components` を知らない keyword として断る。
 */
const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
for (const [name, schema] of Object.entries(openapi.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`);
}
const validate = ajv.compile<CaptureResultReport>({
  $ref: "#/components/schemas/CaptureResultReport",
});

/** 契約が知る時点の名 (`ScreenshotStage`)。 */
const CONTRACT_STAGES: readonly string[] = openapi.components.schemas.ScreenshotStage.enum;

/**
 * 照らす時の時点の名。新しい名に寄せ、契約がそれを知らなければ、同じ時点の名のうち契約が知る物にする
 * (契約の写しが替わる前後のどちらでも、古い名と新しい名の `.result.json` を通すため)。
 */
const contractStageOf = (stage: string): string => {
  const normalized = normalizeStage(stage);
  if (CONTRACT_STAGES.includes(normalized)) return normalized;
  return recordStageNames(normalized).find((name) => CONTRACT_STAGES.includes(name)) ?? stage;
};

/** `screenshots[].stage` を替えた写し。欄が無い・形が違う時は、そのまま返す (形の誤りは Ajv が言う)。 */
const withScreenshotStages = (raw: unknown, rename: (stage: string) => string): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const screenshots = (raw as { screenshots?: unknown }).screenshots;
  if (!Array.isArray(screenshots)) return raw;
  return {
    ...raw,
    screenshots: screenshots.map((item: unknown) => {
      if (typeof item !== "object" || item === null) return item;
      const stage = (item as { stage?: unknown }).stage;
      return typeof stage === "string" ? { ...item, stage: rename(stage) } : item;
    }),
  };
};

/**
 * 契約に照らして返す。`screenshots[].stage` は照らす前に寄せ、返す物は新しい名 (`stage-name.ts`)。CAPTURE-506 より前の BrowserHive の
 * `.result.json` は `after-behaviors` と書き、それより後の契約はその名を持たない —— 寄せずに照らすと、古い取り込みのログ・経緯・
 * 段の登録・reconcile がみな `manifest-invalid` になる。
 */
export const readManifest = (raw: unknown): CaptureResultReport => {
  const candidate = withScreenshotStages(raw, contractStageOf);
  if (validate(candidate)) {
    return withScreenshotStages(candidate, normalizeStage) as CaptureResultReport;
  }
  throw new Error(
    `manifest is not a BrowserHive CaptureResultReport: ${ajv.errorsText(validate.errors)}`,
  );
};

/**
 * 取り込みのログの数を、`crawl_pages.log_counts` (`025`) の形にする。`log.counts` の 4 つに `log.dropped` を足す。
 *
 * `log` を持たない manifest (BrowserHive v24.0.0 より前) には数が無い —— 0 で埋めない。0 は「行が無かった」で、
 * 「読む物が無かった」とは別の事実なので、列は NULL (読んでいない) のまま残す。`log` は契約で任意の欄で、
 * 既定値も無いので、`useDefaults` が補うことも無い。
 */
export const logCountsOf = (report: CaptureResultReport): LogCounts | undefined => {
  if (report.log === undefined) return undefined;
  const { debug, info, warn, error } = report.log.counts;
  return { debug, info, warn, error, dropped: report.log.dropped };
};

/**
 * 失敗の時点の絵 (`failureScreenshot`。BrowserHive v30.2.0 から) の鍵。**capture-ledger が読める場所のときだけ。**
 * 欄が無い取り込みと、設定の bucket の外・`s3://` でない場所は null。
 *
 * 鍵は組まない (下の `manifestOutcome` と同じ)。`.result.json` が言う場所から bucket を外し、残りをそのまま鍵にする。
 * **bucket は設定と照らす** —— `.result.json` の言う bucket を信じると、書いた側が読み先を選べる。経緯のエンドポイント
 * (`api/trace.ts`) が「絵が在るか」を答えるのにも、絵を返すのにも、この 1 つを通す (在ると答えた絵は、場所の上では読める)。
 */
export const failureScreenshotKey = (
  report: Pick<CaptureResultReport, "failureScreenshot">,
  bucket: string,
): string | null => {
  if (report.failureScreenshot === undefined) return null;
  let parsed: S3Location;
  try {
    parsed = parseS3Uri(report.failureScreenshot);
  } catch {
    return null;
  }
  return parsed.bucket === bucket ? parsed.key : null;
};

/** capture-ledger に書く manifest の結末。どちらか一方だけが値を持つ。 */
export type ManifestOutcome = { key: string; error: null } | { key: null; error: string };

/**
 * 段の報告が運んだ manifest の結末を、capture-ledger に書く形にする。
 *
 * **鍵は組まない。** 書いた本人 (BrowserHive か受け取り先) が「ここに書いた」と答えた場所から
 * bucket を外し、残りをそのまま鍵にする。以前はここで BrowserHive の命名規則を写して綴りを
 * 組み直していたが、写しは間違えても静かに壊れ、bucket を一覧して拾う reconcile がその穴を
 * 隠していた。答えを持っている相手に訊けば、写しは要らない。
 *
 * **読むのは設定の bucket だけ。** 報告に入っていた bucket を信じると、報告する側が
 * 読み先を選べる (`.links.json` を読むときと同じ理由)。違う bucket や `s3://` でない
 * 場所は、読めない理由として残す —— **段の報告は落とさない。** 記録が遅れることより、
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
