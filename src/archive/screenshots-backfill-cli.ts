/**
 * `pnpm run screenshots:backfill` (CAPTURE-432)。節目のスクリーンショットの在り処 (`041`) を、検め済みの WACZ に
 * 埋める。`--verify` は書かずに、書いた位置を保管庫への Range の読みで確かめる (`archive/stage-screenshots-store.ts`)。
 *
 * - 読むのは、検め済み (`inspected_at` が在る) で印 (`screenshots_recorded_at`) の無い WACZ だけ。**何度打っても同じ**
 * - 欄の無い WACZ (BrowserHive v30.2.0 より前など) は、行を書かずに印だけ立てる。古い WACZ を読むのは最初の 1 回だけ
 * - **保管庫に無い WACZ は飛ばして数える** (印を立てない。2026-11-07 の volume の作り直しで消えた物がある)
 *
 * capture-ledger の DB と保管庫を直に読み書きする。
 */
import { Command, InvalidArgumentError, Option } from "commander";

import { createS3Client } from "./s3.js";
import { backfillStageScreenshots, verifyStageScreenshots } from "./stage-screenshots-store.js";
import { databaseUrlOption } from "../cli/database-url-option.js";
import { collectEnv, storageFrom } from "../config/env.js";
import { createKyselyClient } from "../db/kysely.js";
import { fatal } from "../logger.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (raw: string): string => {
  if (!UUID.test(raw)) throw new InvalidArgumentError("UUID を渡す");
  return raw;
};

const run = async (opts: {
  databaseUrl: string;
  crawl?: string;
  verify?: boolean;
}): Promise<void> => {
  const { storage } = collectEnv((need) => ({ storage: storageFrom(need) }));
  const s3 = createS3Client(storage);
  const db = createKyselyClient(opts.databaseUrl);
  try {
    if (opts.verify === true) {
      const counts = await verifyStageScreenshots({ db, s3, crawlId: opts.crawl });
      process.stdout.write(
        `確かめ: 位置の在る ${String(counts.located)} 枚のうち、名指しの絵だった ${String(counts.ok)} 枚` +
          ` (保管庫に無い ${String(counts.missing)} 枚・合わなかった ${String(counts.failed.length)} 枚)\n`,
      );
      for (const line of counts.failed) process.stderr.write(`  合わなかった ${line}\n`);
      if (counts.failed.length > 0) process.exitCode = 1;
      return;
    }
    const counts = await backfillStageScreenshots({ db, s3, crawlId: opts.crawl });
    process.stdout.write(
      `埋め直し: アーカイブ ${String(counts.candidates)} 本のうち、行を書いた ${String(counts.recorded)} 本` +
        `・欄が無く印だけ立てた ${String(counts.noField)} 本` +
        ` (保管庫に無い ${String(counts.missing)} 本・読めなかった ${String(counts.failed.length)} 本)\n`,
    );
    for (const line of counts.failed) process.stderr.write(`  読めなかった ${line}\n`);
    if (counts.failed.length > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("screenshots:backfill")
  .description(
    "節目のスクリーンショットの在り処 (archive_screenshots) を、検め済みの WACZ に埋める (capture-ledger の DB と保管庫を直に読み書きする)",
  )
  .addOption(new Option("--crawl <id>", "このクロールの WACZ だけ").argParser(uuid))
  .addOption(new Option("--verify", "書かずに、書いた位置を保管庫への Range の読みで確かめる"))
  .addOption(databaseUrlOption)
  .action(run)
  .showHelpAfterError(true);

program.parseAsync(process.argv).catch(fatal);
