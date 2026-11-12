/**
 * `pnpm run links:backfill` (CAPTURE-246)。リンクを 1 本ずつ残す表 (`crawl_links`・`039`) を、表を足す前の
 * クロールに埋める。保管庫の `.links.json` を読み直し、段の報告と同じ決まりで行を作る (`crawl/links-backfill.ts`)。
 *
 * **既定は数えるだけ。** `--write` で書く。`.links.json` が保管庫に 1 つでも無いクロールは飛ばす (記録の無い
 * クロールのまま残る)。何度打っても同じ (記録の無いクロールだけを読む)。capture-ledger の DB と保管庫を直に読み書きする。
 */
import { Command, InvalidArgumentError, Option } from "commander";

import { createS3Client } from "../archive/s3.js";
import { databaseUrlOption } from "../cli/database-url-option.js";
import { collectEnv, storageFrom } from "../config/env.js";
import { createKyselyClient } from "../db/kysely.js";
import { fatal } from "../logger.js";
import { backfillCrawl, unrecordedCrawls } from "./links-backfill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (raw: string): string => {
  if (!UUID.test(raw)) throw new InvalidArgumentError("UUID を渡す");
  return raw;
};

const backfill = async (opts: {
  databaseUrl: string;
  write: boolean;
  crawl?: string;
}): Promise<void> => {
  const { storage } = collectEnv((need) => ({ storage: storageFrom(need) }));
  const s3 = createS3Client(storage);
  const db = createKyselyClient(opts.databaseUrl);
  try {
    const crawls = await unrecordedCrawls(db, opts.crawl);
    let filled = 0;
    let rows = 0;
    let dropped = 0;
    const skipped = new Map<string, number>();
    const failed: string[] = [];
    for (const crawl of crawls) {
      try {
        const result = await backfillCrawl({ db, s3, bucket: storage.bucket }, crawl, opts.write);
        if (result.kind === "filled") {
          filled += 1;
          rows += result.rows;
          dropped += result.dropped;
        } else {
          // 鍵や id を外して、理由ごとに束ねる
          const why = result.why
            .replace(/^保管庫に .* が無い$/, "保管庫に無い物がある")
            .replace(/^ページ \d+ の/, "");
          skipped.set(why, (skipped.get(why) ?? 0) + 1);
        }
      } catch (err) {
        failed.push(`${crawl.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const skippedTotal = [...skipped.values()].reduce((a, b) => a + b, 0);
    process.stdout.write(
      `リンクの記録の無いクロール ${String(crawls.length)} 本のうち、` +
        `${opts.write ? "埋めた" : "埋められる"} ${String(filled)} 本・${String(rows)} 行` +
        ` (上限で書かない ${String(dropped)} 本)・飛ばす ${String(skippedTotal)} 本・読めなかった ${String(failed.length)} 本\n`,
    );
    for (const [why, n] of skipped)
      process.stdout.write(`  飛ばす理由: ${why} —— ${String(n)} 本\n`);
    if (!opts.write) process.stdout.write("数えただけ。書くには --write\n");
    for (const line of failed) process.stderr.write(`  読めなかった ${line}\n`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("links:backfill")
  .description(
    "リンクを 1 本ずつ残す表 (crawl_links) を、表を足す前のクロールに埋める (capture-ledger の DB と保管庫を直に読み書きする)",
  )
  .addOption(new Option("--write", "書く (付けなければ数えるだけ)").default(false))
  .addOption(new Option("--crawl <id>", "このクロールだけ").argParser(uuid))
  .addOption(databaseUrlOption)
  .action(backfill)
  .showHelpAfterError(true);

program.parseAsync(process.argv).catch(fatal);
