/**
 * 索引を作り直す: アーカイブの `indexed_at` を空にして、1 本ずつ OpenSearch に入れ直す (CAPTURE-53)。
 *
 *   pnpm run search:reindex                 # 全部のアーカイブ
 *   pnpm run search:reindex --crawl <id>    # 1 本のクロールぶん
 *
 * **打つのは、索引が capture-ledger と合わなくなったとき。** compose の OpenSearch は volume を持たないので、
 * 作り直すと索引は空になる。capture-ledger の `indexed_at` は立ったままなので、flow の索引の段
 * (`POST /api/crawls/:id/index`) は何も拾い直さない —— 周回する係も無い。索引の mapping を変えた
 * (索引を消した) ときも同じ。
 *
 * API を通らずに capture-ledger (Postgres)・保管庫 (S3)・OpenSearch を直に読み書きする。アクセストークンは
 * 使わず、認可も通らない —— 書くのは、capture-ledger が既に持っている物の写しだけ。
 *
 * 1 本でも入らなければ終了コード 1。入らなかった行の `indexed_at` は空のまま残るので、打ち直せば拾う。
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { sql } from "kysely";
import { databaseUrlOption } from "../cli/database-url-option.js";
import { collectEnv, searchFrom, storageFrom } from "../config/env.js";
import { createKyselyClient } from "../db/kysely.js";
import { createS3Client } from "../archive/s3.js";
import { fatal } from "../logger.js";
import { createSearchClient, ensureSearchReady } from "./client.js";
import { indexArchive } from "./index-archive.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const crawlId = (raw: string): string => {
  if (!UUID.test(raw)) throw new InvalidArgumentError("クロールの id (UUID) を渡す");
  return raw;
};

const reindex = async (opts: { databaseUrl: string; crawl?: string }): Promise<void> => {
  const { storage, searchSettings } = collectEnv((need) => ({
    storage: storageFrom(need),
    searchSettings: searchFrom(need),
  }));
  const search = createSearchClient(searchSettings);
  await ensureSearchReady(search, searchSettings);
  const s3 = createS3Client(storage);
  const db = createKyselyClient(opts.databaseUrl);
  try {
    const columns = [
      "archives.id",
      "archives.bucket",
      "archives.objectKey",
      "archives.sourceUrl",
      "archives.labels",
      "archives.capturedAt",
    ] as const;
    // クロールで絞るときは、索引のエンドポイントと同じ繋ぎ方 (`crawl_pages.task_id` は text なので cast する)。
    const archives =
      opts.crawl === undefined
        ? await db.selectFrom("archives").select(columns).execute()
        : await db
            .selectFrom("archives")
            .innerJoin("crawlPages", (join) =>
              join.onRef(
                "crawlPages.taskId",
                "=",
                sql<string>`${sql.ref("archives.taskId")}::text`,
              ),
            )
            .select(columns)
            .where("crawlPages.crawlId", "=", opts.crawl)
            .distinctOn("archives.id")
            .execute();
    if (archives.length === 0) {
      process.stdout.write("入れ直すアーカイブは 0 本\n");
      return;
    }
    // 先に全部の印を外す。途中で落ちても、外した行は次の索引の段か打ち直しで拾われる。
    await db
      .updateTable("archives")
      .set({ indexedAt: null })
      .where(
        "id",
        "in",
        archives.map((archive) => archive.id),
      )
      .execute();

    let indexed = 0;
    let pages = 0;
    const failed: string[] = [];
    for (const archive of archives) {
      try {
        pages += await indexArchive(archive, { db, s3, search, index: searchSettings.index });
        indexed += 1;
      } catch (err) {
        failed.push(`${archive.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.stdout.write(
      `索引 ${searchSettings.index}: アーカイブ ${String(archives.length)} 本のうち ${String(indexed)} 本を入れた` +
        ` (ページ ${String(pages)} 件・入らなかった ${String(failed.length)} 本)\n`,
    );
    for (const line of failed) process.stderr.write(`  入らなかった ${line}\n`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("search:reindex")
  .description(
    "索引を作り直す。アーカイブの indexed_at を空にして、OpenSearch に入れ直す (capture-ledger の DB・保管庫・OpenSearch を直に読み書きする)",
  )
  .addOption(new Option("--crawl <id>", "このクロールのアーカイブだけ").argParser(crawlId))
  .addOption(databaseUrlOption)
  .action(reindex)
  .showHelpAfterError(true);

program.parseAsync(process.argv).catch(fatal);
