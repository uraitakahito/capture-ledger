/**
 * 保管庫の WACZ (中身は zip) から、entry 1 つを **Range の読みだけ**で取る (CAPTURE-462)。好きな 2 本の差分
 * (`changes/compare.ts`) が、`pages/pages.jsonl` を読むのに使う。
 *
 * 丸ごと読む道 (`archive/s3.ts` の `getObjectBytes` と `archive/wacz.ts`) と分けてあるのは、こちらが **人の操作の
 * たびに同じ WACZ を読む**から。WACZ の大半は WARC で、`pages.jsonl` は末尾の近くに在る (BrowserHive が WARC の
 * 後ろに入れる)。そこで最初の読みで末尾の `TAIL_BYTES` を 1 度に取って控え、zip の目次 (中央ディレクトリ) も
 * `pages.jsonl` も、収まる限りその控えから読む。収まらなかった分だけ追加で取る。2026-11-22 に開発用の保管庫の
 * 584 本に当てたとき、控えなしでは要求が 1 本で最大 99 回、256 KiB の控えで最大 3 回だった。
 *
 * **全体の大きさは呼ぶ側が渡す** (DB の `archives.wacz_bytes`。検めた取り込みは必ず持つ)。保管庫には訊かない。
 * 渡した大きさが実物と違えば、zip の終わりの印が見つからず投げる。
 *
 * zip を読むのは、丸ごとの道と同じ yauzl-promise (`fromReader` に、Range で読む `Reader` を渡す)。
 */
import { Readable } from "node:stream";

import type { S3Client } from "@aws-sdk/client-s3";
import { fromReader, Reader } from "yauzl-promise";

import { getObjectRange } from "./s3.js";

/** 最初の読みで取って控える、末尾の長さ。zip の終わりの印の探し (最大 64 KiB 強) を含む。 */
export const TAIL_BYTES = 256 * 1024;

/**
 * 解いた後の entry の大きさの上限。超える物は読まない (差分は行数の掛け算で重くなり、解いた文字はメモリに持つ)。
 * BrowserHive は文字を 1 行 100 万字で切るので、時点ごとの行が 2〜3 行の `pages.jsonl` は数 MB に収まる。
 */
export const ENTRY_MAX_BYTES = 8 * 1024 * 1024;

/** 保管庫が答えなかった・頼んだ範囲を返さなかった。エンドポイントは 502 にする。 */
export class WaczStoreError extends Error {
  override name = "WaczStoreError";
}

/** 保管庫に何回頼み、何バイト取ったか (ログ用)。 */
export interface RangeReadStats {
  requests: number;
  bytes: number;
}

export type RangeEntry =
  /** 読めた。 */
  | { kind: "entry"; text: string }
  /** zip は読めたが、その名前の entry が無い。 */
  | { kind: "no_entry" }
  /** WACZ が保管庫に無い。 */
  | { kind: "wacz_missing" }
  /** 解いた後の大きさが上限を超える。中身は読んでいない。 */
  | { kind: "too_large"; uncompressedSize: number };

export type RangeEntryRead = RangeEntry & RangeReadStats;

/** 末尾を控えて、残りを Range で読む reader。 */
class TailCachedRangeReader extends Reader {
  requests = 0;
  bytes = 0;
  /** WACZ が保管庫に無かった。 */
  missing = false;
  /** 保管庫の読みで起きた最初の誤り。yauzl の stream を通ると別の誤りに化けうるので、ここに控える。 */
  failure: unknown;
  private tail: Promise<{ from: number; buffer: Buffer }> | undefined;

  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly key: string,
    private readonly size: number,
  ) {
    super();
  }

  private async fetch(start: number, length: number): Promise<Buffer> {
    let buffer: Buffer | undefined;
    try {
      buffer = await getObjectRange(this.s3, this.bucket, this.key, start, length);
    } catch (err) {
      this.failure ??= err;
      throw err;
    }
    this.requests += 1;
    if (buffer === undefined) {
      this.missing = true;
      throw new Error(`the WACZ is not in the store (${this.bucket}/${this.key})`);
    }
    this.bytes += buffer.length;
    return buffer;
  }

  override async _read(start: number, length: number): Promise<Buffer> {
    // 最初の読み (zip の終わりの印を探す読み) で、末尾をまとめて取る
    this.tail ??= (async () => {
      const from = Math.max(0, this.size - TAIL_BYTES);
      return { from, buffer: await this.fetch(from, this.size - from) };
    })();
    const tail = await this.tail;
    if (start >= tail.from) {
      return tail.buffer.subarray(start - tail.from, start - tail.from + length);
    }
    // 控えより前に掛かる読みは、その範囲だけを取る
    return this.fetch(start, length);
  }

  override _createReadStream(start: number, length: number): Readable {
    const read = () => this._read(start, length);
    return Readable.from(
      (async function* () {
        yield await read();
      })(),
    );
  }
}

/**
 * 保管庫の WACZ から entry 1 つを読む。`size` は WACZ 全体のバイト数。
 *
 * 保管庫が答えなければ `WaczStoreError` を投げる。zip として読めないときは yauzl の誤りがそのまま出る。
 */
export const readWaczEntryByRange = async (
  s3: S3Client,
  archive: { bucket: string; objectKey: string; size: number },
  path: string,
  maxBytes = ENTRY_MAX_BYTES,
): Promise<RangeEntryRead> => {
  const reader = new TailCachedRangeReader(s3, archive.bucket, archive.objectKey, archive.size);
  const stats = (): RangeReadStats => ({ requests: reader.requests, bytes: reader.bytes });
  try {
    const zip = await fromReader(reader, archive.size);
    try {
      for await (const entry of zip) {
        if (entry.filename !== path) continue;
        if (entry.uncompressedSize > maxBytes) {
          return { kind: "too_large", uncompressedSize: entry.uncompressedSize, ...stats() };
        }
        const stream = await entry.openReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return { kind: "entry", text: Buffer.concat(chunks).toString("utf-8"), ...stats() };
      }
      return { kind: "no_entry", ...stats() };
    } finally {
      await zip.close();
    }
  } catch (err) {
    if (reader.missing) return { kind: "wacz_missing", ...stats() };
    if (reader.failure !== undefined) {
      throw new WaczStoreError(
        `the store did not answer for ${archive.bucket}/${archive.objectKey}`,
        { cause: reader.failure },
      );
    }
    throw err;
  }
};
