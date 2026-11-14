/**
 * WARC のレコード 1 つを読む。BrowserHive WARC (`data-NNN.browserhive.warc.gz`) はレコードごとに gzip の member を
 * 分けて書くので (WARC 1.1 の附属書 D)、索引 (`indexes/index.cdxj`) が言う `offset`・`length` は member 1 つを指す。
 *
 * 読むのは、節目のスクリーンショットの resource (`archive/stage-screenshots.ts`)。**ちょうど 1 レコード**を求める ——
 * 範囲が短ければ gzip が解けず、長ければ次のレコードが後ろに残るので、どちらも投げる (位置の誤りを黙って通さない)。
 */
import { gunzipSync } from "node:zlib";

/** レコード 1 つ。見出しの名前は小文字。 */
export interface WarcRecord {
  headers: ReadonlyMap<string, string>;
  /** `Content-Length` の長さの本文 (block)。 */
  body: Buffer;
}

const CRLF2 = Buffer.from("\r\n\r\n", "latin1");

/** gzip の member を解く。伸長した後が `maxBytes` を超えれば投げる (膨らむ入力で memory を使い切らない)。 */
export const gunzipMember = (member: Buffer, maxBytes: number): Buffer =>
  gunzipSync(member, { maxOutputLength: maxBytes });

/** 伸長した WARC のバイト列から、ちょうど 1 レコードを読む。形が違えば投げる。 */
export const parseWarcRecord = (raw: Buffer): WarcRecord => {
  const headEnd = raw.indexOf(CRLF2);
  if (headEnd < 0) throw new Error("the WARC record has no end of headers");
  const lines = raw.toString("utf8", 0, headEnd).split("\r\n");
  if (!/^WARC\/1\.[01]$/.test(lines[0] ?? "")) {
    throw new Error(`not a WARC record (${JSON.stringify((lines[0] ?? "").slice(0, 20))})`);
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0)
      throw new Error(`a WARC header line without a name: ${JSON.stringify(line.slice(0, 40))}`);
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const declared = headers.get("content-length");
  if (declared === undefined || !/^\d+$/.test(declared)) {
    throw new Error("the WARC record has no Content-Length");
  }
  const length = Number(declared);
  const bodyStart = headEnd + CRLF2.length;
  const bodyEnd = bodyStart + length;
  // 本文の後ろは、レコードの終わりの CRLF CRLF ちょうど
  if (raw.length !== bodyEnd + CRLF2.length || !raw.subarray(bodyEnd).equals(CRLF2)) {
    throw new Error(
      `the WARC record is ${String(raw.length)} bytes, not ${String(bodyEnd + CRLF2.length)} (Content-Length ${String(length)})`,
    );
  }
  return { headers, body: raw.subarray(bodyStart, bodyEnd) };
};
