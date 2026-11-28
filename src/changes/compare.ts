/**
 * 取り込み 2 本をその場で比べる (CAPTURE-462)。同じ URL の、好きな 2 本。結果は保存しない (2 本の WACZ から
 * いつでも作り直せる)。認可と、2 本が同じ URL かは呼ぶ側 (`api/history.ts`) が見る。
 *
 * 周回 (`changes/worker.ts`) と同じ物を使う: 比べる行の選び方 (`changes/pairs.ts`)・差分の作り方
 * (`changes/change-of.ts`)。違うのは WACZ の読み方だけで、こちらは `pages/pages.jsonl` を Range で読む
 * (`archive/wacz-range.ts`)。周回は同じ予定・同じ撮り方の隣の回だけを比べるが、こちらは撮り方も比べる行の
 * 種類も違う 2 本を比べうるので、その印 (`recipeDiffers`・`stageDiffers`) を答えに付ける。
 *
 * ## 順
 *
 * 1. DB の行だけで言える「比べられない」(まだ検めていない・伏せた・文字が無い)。今を先に見る
 * 2. 文字の digest が同じなら「同じ」。**保管庫は読まない**
 * 3. 2 本の `pages.jsonl` を読む。WACZ が保管庫に無い・解いた後が大きすぎるなら「比べられない」
 * 4. 行数の掛け算が上限を超えれば「比べられない」(差分は掛け算で重くなり、計算の間は API がほかに答えられない)
 * 5. 差分を作る。空 (空行と字下げだけの違い) なら「同じ」
 */
import type { S3Client } from "@aws-sdk/client-s3";

import { PAGES_ENTRY_PATH } from "../archive/wacz.js";
import { readWaczEntryByRange } from "../archive/wacz-range.js";
import { parsePagesJsonl } from "../search/document.js";
import { changeOf, linesOf, type DiffLine } from "./change-of.js";
import { notComparableOf, type HistoryArchive, type NotComparable } from "./history.js";
import { comparedTextOf } from "./pairs.js";

/**
 * 比べる 2 本の行数 (`linesOf` の後) の掛け算の上限。差分の表はこの数の升を持つ。2026-11-22 の開発用の DB の
 * 最大は 1,275 行どうし (掛け算で約 163 万)。
 */
export const MAX_LINE_PRODUCT = 4_000_000;

export type PairState = "same" | "diffed" | "not_comparable";
export type PairReason = NotComparable | "wacz_missing" | "too_large";

/** 答えが WACZ を名指すのに要る欄と、比べた行の種類。 */
export interface PairArchiveRef {
  archiveId: string;
  objectKey: string;
  sourceUrl: string;
  capturedAt: Date;
  browserhiveVersion: string | null;
  /** 比べた行が写しなら `after-capture-scripts`、文書の行なら null。比べる行が無ければ null。 */
  stage: string | null;
}

export interface PairComparison {
  url: string;
  state: PairState;
  /** `not_comparable` のときだけ。 */
  reason: PairReason | null;
  /** `same` のときだけ。`digest` は文字の digest が同じ、`lines` は空行と字下げだけの違い。 */
  sameBy: "digest" | "lines" | null;
  added: number;
  removed: number;
  hunks: DiffLine[][];
  /** 撮り方 (クロールの `recipe_sha256`) が違うか。どちらかが分からなければ null。 */
  recipeDiffers: boolean | null;
  /** 比べた行の種類 (写し・文書の行) が違うか。 */
  stageDiffers: boolean;
  before: PairArchiveRef;
  after: PairArchiveRef;
}

/** 保管庫に何回頼み、何バイト取ったか (2 本の合計。ログ用)。 */
export interface PairStoreStats {
  requests: number;
  bytes: number;
}

const refOf = (archive: HistoryArchive): PairArchiveRef => ({
  archiveId: archive.id,
  objectKey: archive.objectKey,
  sourceUrl: archive.sourceUrl,
  capturedAt: archive.capturedAt,
  browserhiveVersion: archive.browserhiveVersion,
  stage: archive.line?.stage ?? null,
});

/** 比べる行の文字。読めなかった取り込みは、その訳。 */
type TextRead = { text: string } | { reason: "wacz_missing" | "too_large" };

export const comparePair = async (
  s3: S3Client,
  after: HistoryArchive,
  before: HistoryArchive,
): Promise<{ comparison: PairComparison; store: PairStoreStats }> => {
  const store: PairStoreStats = { requests: 0, bytes: 0 };
  const base = {
    url: after.sourceUrl,
    added: 0,
    removed: 0,
    hunks: [] as DiffLine[][],
    recipeDiffers:
      after.recipeSha256 === null || before.recipeSha256 === null
        ? null
        : after.recipeSha256 !== before.recipeSha256,
    stageDiffers: (after.line?.stage ?? null) !== (before.line?.stage ?? null),
    before: refOf(before),
    after: refOf(after),
  };
  const notComparable = (reason: PairReason) => ({
    comparison: { ...base, state: "not_comparable" as const, reason, sameBy: null },
    store,
  });
  const same = (sameBy: "digest" | "lines") => ({
    comparison: { ...base, state: "same" as const, reason: null, sameBy },
    store,
  });

  const unreadable =
    notComparableOf(after.inspectedAt, after.line) ??
    notComparableOf(before.inspectedAt, before.line);
  if (unreadable !== null) return notComparable(unreadable);
  // 検めた取り込みは大きさを必ず持つ (`027` の CHECK)。無ければ、検めていない物として扱う
  if (after.waczBytes === null || before.waczBytes === null) return notComparable("not_inspected");

  if (after.line?.textSha256 === before.line?.textSha256) return same("digest");

  const readText = async (archive: HistoryArchive, size: number): Promise<TextRead> => {
    const read = await readWaczEntryByRange(
      s3,
      { bucket: archive.bucket, objectKey: archive.objectKey, size },
      PAGES_ENTRY_PATH,
    );
    store.requests += read.requests;
    store.bytes += read.bytes;
    switch (read.kind) {
      case "wacz_missing":
      case "too_large":
        return { reason: read.kind };
      case "no_entry":
        // `pages.jsonl` の無い WACZ は、周回と同じく空の文字として比べる
        return { text: "" };
      case "entry":
        return { text: comparedTextOf(parsePagesJsonl(read.text), archive.line?.stage ?? null) };
    }
  };
  const [afterText, beforeText] = await Promise.all([
    readText(after, after.waczBytes),
    readText(before, before.waczBytes),
  ]);
  // 今を先に見る
  if ("reason" in afterText) return notComparable(afterText.reason);
  if ("reason" in beforeText) return notComparable(beforeText.reason);

  if (linesOf(afterText.text).length * linesOf(beforeText.text).length > MAX_LINE_PRODUCT) {
    return notComparable("too_large");
  }
  const change = changeOf(beforeText.text, afterText.text);
  // digest は違うが、空行と字下げだけの違い
  if (!change.changed) return same("lines");
  return {
    comparison: {
      ...base,
      state: "diffed",
      reason: null,
      sameBy: null,
      added: change.added,
      removed: change.removed,
      hunks: change.hunks,
    },
    store,
  };
};
