/**
 * `pnpm run changes:backfill` (CAPTURE-167)。前回からの変化が読む列を、`035` より前の行に埋める。
 *
 * - `crawls.recipe_sha256`: 行の列 (scripts・variables・secrets・user_agent) から、新しい行と同じ関数で数える
 *   (`crawl/recipe-digest.ts`)。保管庫は読まない
 * - `archive_pages.text_sha256`・`text_chars`・`text_withheld` と `archives.browserhive_version`・`browser_version`:
 *   検めた WACZ を保管庫から読み直し、検めるときと同じ関数で数える (`replay-bundle/inspect.ts`・`format.ts`)。
 *   **保管庫に無い WACZ は飛ばして数える** (2026-11-07 の volume の作り直しで消えた物がある)
 *
 * 何度打っても同じ (埋まっていない行だけを読む)。capture-ledger の DB と保管庫を直に読み書きする。
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { sql } from "kysely";

import { getObjectBytes, createS3Client } from "../archive/s3.js";
import { databaseUrlOption } from "../cli/database-url-option.js";
import { collectEnv, storageFrom } from "../config/env.js";
import { recipeDigestOf } from "../crawl/recipe-digest.js";
import type { CrawlScript } from "../db/database.js";
import { createKyselyClient } from "../db/kysely.js";
import { fatal } from "../logger.js";
import { archivePageRows } from "../replay-bundle/format.js";
import { readWaczFacts } from "../replay-bundle/inspect.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (raw: string): string => {
  if (!UUID.test(raw)) throw new InvalidArgumentError("UUID を渡す");
  return raw;
};

const backfill = async (opts: { databaseUrl: string; schedule?: string }): Promise<void> => {
  const { storage } = collectEnv((need) => ({ storage: storageFrom(need) }));
  const s3 = createS3Client(storage);
  const db = createKyselyClient(opts.databaseUrl);
  try {
    // ---- 撮り方の digest ----
    let crawlsQuery = db
      .selectFrom("crawls")
      .select(["id", "scripts", "variables", "secrets", "userAgent"])
      .where("recipeSha256", "is", null);
    if (opts.schedule !== undefined)
      crawlsQuery = crawlsQuery.where("scheduleId", "=", opts.schedule);
    const crawls = await crawlsQuery.execute();
    for (const crawl of crawls) {
      const scripts: readonly CrawlScript[] = crawl.scripts;
      await db
        .updateTable("crawls")
        .set({
          recipeSha256: recipeDigestOf({
            scripts,
            variables: crawl.variables,
            userAgent: crawl.userAgent ?? "",
            secretNames: Object.keys(crawl.secrets),
          }),
        })
        .where("id", "=", crawl.id)
        .where("recipeSha256", "is", null)
        .execute();
    }

    // ---- 文字の digest と版 ----
    let archivesQuery = db
      .selectFrom("archives")
      .select(["archives.id", "archives.bucket", "archives.objectKey"])
      .where("archives.inspectedAt", "is not", null)
      .where("archives.browserhiveVersion", "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("archivePages")
            .select(sql<number>`1`.as("one"))
            .whereRef("archivePages.archiveId", "=", "archives.id")
            .where("archivePages.textSha256", "is", null),
        ),
      );
    if (opts.schedule !== undefined) {
      archivesQuery = archivesQuery
        .innerJoin("crawls", "crawls.id", "archives.crawlId")
        .where("crawls.scheduleId", "=", opts.schedule);
    }
    const archives = await archivesQuery.execute();
    let filled = 0;
    let missing = 0;
    const failed: string[] = [];
    for (const archive of archives) {
      try {
        const zip = await getObjectBytes(s3, archive.bucket, archive.objectKey);
        if (zip === undefined) {
          missing += 1;
          continue;
        }
        const facts = await readWaczFacts(zip);
        const rows = archivePageRows(facts.lines, undefined);
        await db.transaction().execute(async (trx) => {
          for (const row of rows) {
            await trx
              .updateTable("archivePages")
              .set({
                textSha256: row.textSha256,
                textChars: row.textChars,
                textWithheld: row.textWithheld,
              })
              .where("archiveId", "=", archive.id)
              .where("ordinal", "=", row.ordinal)
              .execute();
          }
          await trx
            .updateTable("archives")
            .set({
              browserhiveVersion: facts.browserhiveVersion,
              browserVersion: facts.browserVersion,
            })
            .where("id", "=", archive.id)
            .execute();
        });
        filled += 1;
      } catch (err) {
        failed.push(`${archive.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.stdout.write(
      `撮り方の digest: クロール ${String(crawls.length)} 本に入れた\n` +
        `文字の digest: アーカイブ ${String(archives.length)} 本のうち ${String(filled)} 本を埋めた` +
        ` (保管庫に無い ${String(missing)} 本・読めなかった ${String(failed.length)} 本)\n`,
    );
    for (const line of failed) process.stderr.write(`  読めなかった ${line}\n`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("changes:backfill")
  .description(
    "前回からの変化が読む列 (crawls.recipe_sha256・archive_pages.text_sha256 ほか) を、035 より前の行に埋める (capture-ledger の DB と保管庫を直に読み書きする)",
  )
  .addOption(new Option("--schedule <id>", "この予定の回だけ").argParser(uuid))
  .addOption(databaseUrlOption)
  .action(backfill)
  .showHelpAfterError(true);

program.parseAsync(process.argv).catch(fatal);
