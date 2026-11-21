/**
 * WACZ (中身は zip) の中を読む道具。全文検索の索引 (`search/index-archive.ts`) と合本 (`replay-bundle/inspect.ts`) が
 * 使う。
 *
 * **WACZ は丸ごとメモリにある** (`archive/s3.ts` の `getObjectBytes`)。`fromBuffer` は中央ディレクトリを読むだけ
 * なので、呼ぶたびに開き直しても安い。丸ごと持たずに、保管庫への Range の読みだけで entry 1 つを取る道は
 * `archive/wacz-range.ts` に在る (好きな 2 本の差分が使う。CAPTURE-462)。entry の名前の定数は、そちらもここの物を使う。
 *
 * `fflate.unzipSync` (browserhive の test helper) を使わないのは、あれが **全 entry を一括で伸長する**から。
 * 欲しいのは小さな JSONL 1 本と、索引の大きさだけ。
 */
import { fromBuffer } from "yauzl-promise";

/** WACZ の中で `pages.jsonl` が置かれる場所。BrowserHive の `PAGES_ENTRY_PATH` と対。 */
export const PAGES_ENTRY_PATH = "pages/pages.jsonl";

/** WACZ の中の CDXJ の索引。BrowserHive は必ず書く (記録が 0 なら空)。 */
export const INDEX_ENTRY_PATH = "indexes/index.cdxj";

/** zip から 1 つの entry だけを読む。無ければ `undefined`。 */
export const readEntry = async (zip: Buffer, path: string): Promise<string | undefined> => {
  const file = await fromBuffer(zip);
  try {
    for await (const entry of file) {
      if (entry.filename !== path) continue;
      const stream = await entry.openReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf-8");
    }
    return undefined;
  } finally {
    await file.close();
  }
};

/**
 * zip の entry 1 つの、伸長した後の大きさ (バイト)。無ければ `undefined`。**中身は読まない** ——
 * 中央ディレクトリが持つ数を返すだけ。
 */
export const entrySize = async (zip: Buffer, path: string): Promise<number | undefined> => {
  const file = await fromBuffer(zip);
  try {
    for await (const entry of file) {
      if (entry.filename === path) return entry.uncompressedSize;
    }
    return undefined;
  } finally {
    await file.close();
  }
};

/** zip の entry の中身が、zip のどこに在るか (`storedEntryRange`)。 */
export interface EntryRange {
  /** 中身の最初のバイトの、zip の頭からの位置。 */
  start: number;
  /** 中身の長さ (zip に入っているままのバイト数。stored なら伸長した後と同じ)。 */
  size: number;
  /** 圧縮の方式 (0 は stored、8 は deflate)。 */
  method: number;
}

/** local header の印 (`PK\x03\x04`)。 */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/**
 * entry 1 つの中身の在り処。無ければ `undefined`。**中身は読まない。**
 *
 * yauzl の `fileDataOffset` は `openReadStream()` を呼ぶまで null なので、local header を直に読む: 中身は
 * local header の 30 バイトと、名前と、extra の後ろから始まる。**名前と extra の長さは local header の値を使う** ——
 * 中央ディレクトリの extra とは長さが違いうる。大きさは中央ディレクトリの値を使う (stream で書いた zip の
 * local header は大きさの欄が 0 で、後ろに data descriptor が付く)。
 */
export const storedEntryRange = async (
  zip: Buffer,
  path: string,
): Promise<EntryRange | undefined> => {
  const file = await fromBuffer(zip);
  try {
    for await (const entry of file) {
      if (entry.filename !== path) continue;
      const at = entry.fileHeaderOffset;
      if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL_HEADER_SIGNATURE) {
        throw new Error(`no local header for ${path} at ${String(at)}`);
      }
      const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
      if (start + entry.compressedSize > zip.length) {
        throw new Error(`${path} runs past the end of the zip`);
      }
      return { start, size: entry.compressedSize, method: entry.compressionMethod };
    }
    return undefined;
  } finally {
    await file.close();
  }
};
