/**
 * 節目のスクリーンショット (CAPTURE-8・CAPTURE-432)。BrowserHive は v30.2.0 から、取り込みの節目 (`after-load`・
 * `after-behaviors`) の viewport の絵 (WebP) を、BrowserHive WARC の `resource` レコードとして WACZ に入れる
 * (BrowserHive WACZ Profile の `#screenshots`)。`datapackage.json` の `browserhive:capture.screenshots[]` が時点ごとに
 * 「絵の url・date・record・bytes」か「残さなかった理由 (`skipped`)」を言い、索引 (`indexes/index.cdxj`) の
 * `<url> <14 桁>` の行が、絵のレコードの WARC のファイルと `offset`・`length` を言う。
 *
 * ## 位置だけを覚え、絵は写さない
 *
 * WACZ を検める時 (`replay-bundle/inspect.ts`) に、絵のレコードの **WACZ のオブジェクトの中の絶対の位置** (gzip の
 * member 1 つ) を求めて `archive_screenshots` に書く。読む時 (`GET /api/archives/:id/screenshots/:stage`) は、
 * 保管庫への Range の読み 1 本で済む。WARC は ZIP の中に無圧縮 (stored) で入っている (2026-11-15 の dev の 118 本で
 * 255 本とも) ので、位置 = WARC の entry の中身の始まり + 索引の `offset`。
 *
 * **求めた位置は、その場で解いて確かめる** (名指しのレコードか・時点が合うか・WebP か)。合わなければ位置を書かず、
 * 理由 (`problem`) を書く。間違った絵を返すより、絵が無いと言うほうがよい。
 */
import { gunzipMember, parseWarcRecord } from "./warc-record.js";
import { INDEX_ENTRY_PATH, readEntry, storedEntryRange } from "./wacz.js";
import { isWebp, PICTURE_MAX_BYTES } from "./webp.js";

/** 版を読む entry。WACZ の決まりの名前。 */
const DATAPACKAGE_ENTRY_PATH = "datapackage.json";

/** WARC のファイルの置き場 (WACZ の決まり)。索引の `filename` はここからの名前。 */
const ARCHIVE_DIR = "archive/";

/** 絵のレコードの Target-URI の頭。後ろに `<時点>:<文書の URL>` が付く。 */
export const SCREENSHOT_URN_PREFIX = "urn:browserhive:screenshot:";

/** 伸長の上限。絵の上限に、WARC の見出しのぶんを足す。 */
const RECORD_MAX_BYTES = PICTURE_MAX_BYTES + 64 * 1024;

/**
 * 位置を引けなかった理由。
 *
 *   entry-invalid    項目の形が半端 (url・date・record・bytes のどれかが無い)
 *   no-index-line    索引に、その url と時刻の行が無い
 *   warc-missing     索引が言う WARC のファイルが WACZ に無い
 *   warc-not-stored  WARC のファイルが ZIP の中で圧縮されている (位置を Range で読めない)
 *   out-of-bounds    索引の位置が WARC のファイルの外
 *   record-mismatch  位置のレコードが、名指しの絵でない (解けない・Record-ID・時点・形式・大きさが違う)
 */
export type ScreenshotProblem =
  | "entry-invalid"
  | "no-index-line"
  | "warc-missing"
  | "warc-not-stored"
  | "out-of-bounds"
  | "record-mismatch";

/** 時点 1 つの記録 (`archive_screenshots` の 1 行)。3 つの形のどれか 1 つ (CHECK)。 */
export type StageScreenshotRow =
  | { stage: string; kind: "skipped"; skipped: string }
  | {
      stage: string;
      kind: "located";
      waczOffset: number;
      waczLength: number;
      bytes: number;
      recordId: string;
    }
  | { stage: string; kind: "problem"; problem: ScreenshotProblem };

/** 位置のレコードが名指しの絵でないとき。 */
export class ScreenshotRecordError extends Error {}

/** 位置のレコードが満たすべきこと。 */
export interface ExpectedPicture {
  stage: string;
  /** WARC-Record-ID (山括弧なし。`urn:uuid:…`)。 */
  recordId: string;
  /** 絵のバイト数。分かっていれば照らす。 */
  bytes?: number | undefined;
}

/**
 * gzip の member 1 つから絵を取り出す。名指しの絵でなければ `ScreenshotRecordError`。検める時と、読み出しの
 * エンドポイントの両方が通る。
 */
export const pictureOf = (member: Buffer, expected: ExpectedPicture): Buffer => {
  let record;
  try {
    record = parseWarcRecord(gunzipMember(member, RECORD_MAX_BYTES));
  } catch (cause) {
    throw new ScreenshotRecordError(`the screenshot record does not read: ${String(cause)}`);
  }
  const { headers, body } = record;
  const fail = (what: string): never => {
    throw new ScreenshotRecordError(`the screenshot record ${what}`);
  };
  if (headers.get("warc-type") !== "resource")
    fail(`is not a resource (${String(headers.get("warc-type"))})`);
  const target = headers.get("warc-target-uri") ?? "";
  if (!target.startsWith(`${SCREENSHOT_URN_PREFIX}${expected.stage}:`)) {
    fail(`is not the ${expected.stage} screenshot (${target.slice(0, 60)})`);
  }
  const recordId = (headers.get("warc-record-id") ?? "").replace(/^<|>$/g, "");
  if (recordId !== expected.recordId) fail(`is ${recordId}, not ${expected.recordId}`);
  if (!(headers.get("content-type") ?? "").toLowerCase().startsWith("image/webp")) {
    fail(`is not image/webp (${String(headers.get("content-type"))})`);
  }
  if (body.length > PICTURE_MAX_BYTES) fail(`is larger than ${String(PICTURE_MAX_BYTES)} bytes`);
  if (expected.bytes !== undefined && body.length !== expected.bytes) {
    fail(`is ${String(body.length)} bytes, not ${String(expected.bytes)}`);
  }
  if (!isWebp(body)) fail("is not a WebP image");
  return body;
};

/** 14 桁の時刻 (CDXJ の鍵の 2 つ目)。`2026-11-14T01:36:12.338Z` → `20261114013612`。 */
const cdxjTimestamp = (date: string): string => date.replace(/[-:T]/g, "").slice(0, 14);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonNegativeInteger = (value: unknown): number | undefined => {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

/** `datapackage.json` の `screenshots[]`。無い・JSON でない・配列でないときは undefined。 */
const screenshotEntriesOf = (raw: string | undefined): unknown[] | undefined => {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const capture = isRecord(parsed) ? parsed["browserhive:capture"] : undefined;
  const entries = isRecord(capture) ? capture["screenshots"] : undefined;
  return Array.isArray(entries) ? entries : undefined;
};

/** 索引の行 1 つから位置を求め、その場で確かめる。 */
const locateLine = async (
  zip: Buffer,
  line: string,
  expected: ExpectedPicture,
): Promise<StageScreenshotRow> => {
  const problem = (p: ScreenshotProblem): StageScreenshotRow => ({
    stage: expected.stage,
    kind: "problem",
    problem: p,
  });
  let at: unknown;
  try {
    at = JSON.parse(line.slice(line.indexOf("{")));
  } catch {
    return problem("no-index-line");
  }
  if (!isRecord(at) || typeof at["filename"] !== "string") return problem("no-index-line");
  const offset = nonNegativeInteger(at["offset"]);
  const length = nonNegativeInteger(at["length"]);
  if (offset === undefined || length === undefined || length === 0) return problem("no-index-line");
  const entry = await storedEntryRange(zip, `${ARCHIVE_DIR}${at["filename"]}`);
  if (entry === undefined) return problem("warc-missing");
  if (entry.method !== 0) return problem("warc-not-stored");
  if (offset + length > entry.size) return problem("out-of-bounds");
  const waczOffset = entry.start + offset;
  try {
    const body = pictureOf(zip.subarray(waczOffset, waczOffset + length), expected);
    return {
      stage: expected.stage,
      kind: "located",
      waczOffset,
      waczLength: length,
      bytes: body.length,
      recordId: expected.recordId,
    };
  } catch (cause) {
    if (cause instanceof ScreenshotRecordError) return problem("record-mismatch");
    throw cause;
  }
};

/**
 * WACZ (丸ごとのバイト列) の節目のスクリーンショットの記録。`datapackage.json` に `screenshots` の欄が無ければ
 * `undefined` (BrowserHive v30.2.0 より前の WACZ・BrowserHive でない WACZ)。時点の並びは欄の順。
 *
 * 形の壊れた項目 (時点が文字でない・同じ時点の 2 つ目) は捨てる。zip として読めなければ投げる。
 */
export const locateStageScreenshots = async (
  zip: Buffer,
): Promise<StageScreenshotRow[] | undefined> => {
  const entries = screenshotEntriesOf(await readEntry(zip, DATAPACKAGE_ENTRY_PATH));
  if (entries === undefined) return undefined;
  let index: string[] | undefined;
  const rows: StageScreenshotRow[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    if (!isRecord(item)) continue;
    const stage = item["stage"];
    if (typeof stage !== "string" || stage === "" || seen.has(stage)) continue;
    seen.add(stage);
    const skipped = item["skipped"];
    if (typeof skipped === "string" && skipped !== "") {
      rows.push({ stage, kind: "skipped", skipped });
      continue;
    }
    const { url, date, record } = item;
    const bytes = nonNegativeInteger(item["bytes"]);
    if (
      typeof url !== "string" ||
      typeof date !== "string" ||
      typeof record !== "string" ||
      bytes === undefined
    ) {
      rows.push({ stage, kind: "problem", problem: "entry-invalid" });
      continue;
    }
    index ??= ((await readEntry(zip, INDEX_ENTRY_PATH)) ?? "").split("\n");
    const head = `${url} ${cdxjTimestamp(date)} `;
    const candidates = index.filter((line) => line.startsWith(head));
    if (candidates.length === 0) {
      rows.push({ stage, kind: "problem", problem: "no-index-line" });
      continue;
    }
    // 同じ url と秒の行が 2 本在れば、名指しのレコードと確かめられた方を採る
    let found: StageScreenshotRow | undefined;
    for (const line of candidates) {
      found = await locateLine(zip, line, { stage, recordId: record, bytes });
      if (found.kind === "located") break;
    }
    rows.push(found ?? { stage, kind: "problem", problem: "no-index-line" });
  }
  return rows;
};
