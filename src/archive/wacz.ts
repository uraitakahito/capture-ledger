/**
 * WACZ (中身は zip) の中を読む道具。全文検索の索引 (`search/index-archive.ts`) と合本 (`replay-bundle/inspect.ts`) が
 * 使う。
 *
 * **WACZ は丸ごとメモリにある** (`archive/s3.ts` の `getObjectBytes`)。`fromBuffer` は中央ディレクトリを読むだけ
 * なので、呼ぶたびに開き直しても安い。
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
