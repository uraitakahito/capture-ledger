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
 * 直し方は `archive/s3.ts` の `getObjectBytes` の docstring に書いてある。zip の中を読むのは
 * `archive/wacz.ts` (合本と共有)。
 *
 * ## 失敗しても `indexed_at` を立てない
 *
 * 立てるのは送り終えてから。途中で落ちれば列は NULL のままなので、次に索引の口
 * (`POST /api/crawls/:id/index`。flow の段) か `pnpm run search:reindex` を叩いたときに同じ行を拾う
 * —— 自分で周回する係は無い。**at-least-once** で、`_id` がアーカイブの id と時点
 * (`document.ts` の `searchDocumentId`) なので重複しない。
 */
import type { Kysely } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Client } from "@opensearch-project/opensearch";
import { getObjectBytes } from "../archive/s3.js";
import { PAGES_ENTRY_PATH, readEntry } from "../archive/wacz.js";
import type { Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import {
  pagesToIndex,
  parsePagesJsonl,
  searchDocument,
  searchDocumentId,
  type ArchiveRow,
} from "./document.js";

const log = createChildLogger({ module: "search-index-archive" });

export interface IndexArchiveOptions {
  db: Kysely<Database>;
  s3: S3Client;
  search: Client;
  index: string;
}

/**
 * 1 本を索引に載せる。載せた件数（写しの行があれば時点ごとに 1 件、無ければ文書の行の 1 件。
 * `document.ts` の `pagesToIndex`）を返す。
 *
 * WACZ が無い、あるいは `pages.jsonl` が無いときは **`indexed_at` を立てる**。
 * 索引に載せるものが無いことは確定していて、拾い直しても同じ答えになるため ——
 * 立てないと、索引の口を叩くたびにその行を読み続けることになる。
 */
export const indexArchive = async (
  archive: ArchiveRow & { bucket: string },
  options: IndexArchiveOptions,
): Promise<number> => {
  const bytes = await getObjectBytes(options.s3, archive.bucket, archive.objectKey);
  const raw = bytes === undefined ? undefined : await readEntry(bytes, PAGES_ENTRY_PATH);

  const pages = raw === undefined ? [] : pagesToIndex(parsePagesJsonl(raw));
  if (pages.length > 0) {
    const body = pages.flatMap((page) => {
      const doc = searchDocument(page, archive);
      // 1 アーカイブは時点ごとに行を持つ (検索前と検索後) ので、_id はアーカイブの id と
      // 時点で作る。archive の id だけだと、後の行が前の行を上書きする。
      return [{ index: { _index: options.index, _id: searchDocumentId(doc) } }, doc];
    });
    const result = await options.search.bulk({ body, refresh: true });
    if (result.body.errors === true) {
      // 部分的な失敗を握り潰さない。`indexed_at` を立てずに投げる (呼ぶ側が failed に数える)。
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
