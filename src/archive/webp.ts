/**
 * capture-ledger が返す絵 (WebP) の確かめ。失敗の時点の絵 (`api/trace.ts`。WACZ の外の `.failure.webp`) と、節目の
 * スクリーンショット (`archive/stage-screenshots.ts`。WACZ の中の WARC の resource) が使う。
 */

/**
 * 絵として返す大きさの上限。viewport 1 枚の WebP は数十〜数百 KiB (2026-11-15 の dev の 201 枚は 2,706〜100,728
 * バイト)。読む場所は BrowserHive が言った物なので、そこに何が在っても、これより大きい物は返さない。
 */
export const PICTURE_MAX_BYTES = 1024 * 1024;

/** WebP の頭 (RIFF の入れ物の `RIFF`・4 バイトの長さ・`WEBP`)。 */
export const isWebp = (bytes: Buffer): boolean =>
  bytes.length >= 12 &&
  bytes.toString("latin1", 0, 4) === "RIFF" &&
  bytes.toString("latin1", 8, 12) === "WEBP";
