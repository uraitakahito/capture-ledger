/**
 * アーカイブ 1 本を索引に載せる。
 *
 * S3 から WACZ を取り、`pages/pages.jsonl` を抜き、`document.ts` に写させ、
 * OpenSearch へ送り、`indexed_at` を立てる。**判断は `document.ts` にしかない** ——
 * ここは配管。
 *
 * ## zip を丸ごと落とす
 *
 * WACZ の大半は WARC なので、小さな JSONL 1 本のために全部を落としている。
 * 承知のうえ: 現物は数十 KB〜数 MB で、範囲読みの複雑さに見合わない。
 * 直し方は `archive/s3.ts` の `getObjectBytes` の docstring に書いてある。
 *
 * `fflate.unzipSync` (browserhive の test helper) を使わないのは、あれが
 * **全 entry を一括で伸長する**から。落とす量は同じでも、伸長する量が違う。
 *
 * ## 失敗しても `indexed_at` を立てない
 *
 * 立てるのは送り終えてから。途中で落ちれば列は NULL のままなので、次の周回が
 * 同じ行を拾う。**at-least-once** で、`_id` がアーカイブの id と時点
 * (`document.ts` の `searchDocumentId`) なので重複しない。
 */
import type { Kysely } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Client } from "@opensearch-project/opensearch";
import { fromBuffer } from "yauzl-promise";
import { getObjectBytes } from "../archive/s3.js";
import type { Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import { parsePagesJsonl, searchDocument, searchDocumentId, type ArchiveRow } from "./document.js";

const log = createChildLogger({ module: "search-index-archive" });

/** WACZ の中で `pages.jsonl` が置かれる場所。BrowserHive の `PAGES_ENTRY_PATH` と対。 */
const PAGES_ENTRY_PATH = "pages/pages.jsonl";

/** zip から 1 つの entry だけを読む。無ければ `undefined`。 */
const readEntry = async (zip: Buffer, path: string): Promise<string | undefined> => {
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

export interface IndexArchiveOptions {
  db: Kysely<Database>;
  s3: S3Client;
  search: Client;
  index: string;
}

/**
 * 1 本を索引に載せる。載せた件数 (= そのアーカイブの `pages.jsonl` の行の数。時点ごとに
 * 1 行) を返す。
 *
 * WACZ が無い、あるいは `pages.jsonl` が無いときは **`indexed_at` を立てる**。
 * 索引に載せるものが無いことは確定していて、次の周回で拾い直しても同じ答えに
 * なるため —— 立てないと、その行を永久に読み続けることになる。
 */
export const indexArchive = async (
  archive: ArchiveRow & { bucket: string },
  options: IndexArchiveOptions,
): Promise<number> => {
  const bytes = await getObjectBytes(options.s3, archive.bucket, archive.objectKey);
  const raw = bytes === undefined ? undefined : await readEntry(bytes, PAGES_ENTRY_PATH);

  const pages = raw === undefined ? [] : parsePagesJsonl(raw);
  if (pages.length > 0) {
    const body = pages.flatMap((page) => {
      const doc = searchDocument(page, archive);
      // 1 アーカイブは時点ごとに行を持つ (検索前と検索後) ので、_id はアーカイブの id と
      // 時点で作る。archive の id だけだと、後の行が前の行を上書きする。
      return [{ index: { _index: options.index, _id: searchDocumentId(doc) } }, doc];
    });
    const result = await options.search.bulk({ body, refresh: true });
    if (result.body.errors === true) {
      // 部分的な失敗を握り潰さない。`indexed_at` を立てずに投げ、次の周回に回す。
      const first = result.body.items?.find(
        (item: { index?: { error?: unknown } }) => item.index?.error !== undefined,
      );
      throw new Error(`bulk indexing failed: ${JSON.stringify(first)}`);
    }
  } else {
    log.info({ archiveId: archive.id }, "archive carries no page text; marking it indexed anyway");
  }

  await options.db
    .updateTable("archives")
    .set({ indexedAt: new Date().toISOString() })
    .where("id", "=", archive.id)
    .execute();

  return pages.length;
};
