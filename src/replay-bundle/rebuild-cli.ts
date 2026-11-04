/**
 * 合本を作り直す: クロール 1 本の合本を、新しい版として保管庫に書く (CAPTURE-56)。
 *
 *   pnpm run replay-bundle:rebuild --crawl <id>
 *
 * **打つのは、段の合本に入っていない物があるとき。** flow は段の報告の後に合本の口
 * (`POST /api/crawls/:id/replay-bundle`) を叩くが、それより後に台帳に入った物は、次の段が無ければどの合本にも入らない:
 *
 * - 後から reconcile が受けた取り込み (段の登録で manifest を読めなかった物)
 * - 保管庫に書けなかった段 (`crawls.replay_bundle_error`)・flow が落ちた段の後
 * - 027 より前のクロール。先にそのクロールのアーカイブに `crawl_id` を入れる (`crawl_pages.task_id` から。
 *   台帳の他の口と同じ繋ぎ方)
 *
 * 口と同じ関数 (`replay-bundle/write.ts`) を、API を通らずに台帳 (Postgres) と保管庫 (S3) に直に当てる。アクセス
 * トークンは使わず、認可も通らない —— 書くのは、台帳と保管庫が既に持っている物から組んだ合本だけ。版は口と同じく
 * 払い出すので、flow の段と重なっても版は食い違わない (台帳が指すのは大きいほう)。
 *
 * 書けなかった、または検められなかった WACZ が在れば終了コード 1 (検められなかった物は、打ち直せば拾う)。
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { databaseUrlOption } from "../cli/database-url-option.js";
import { collectEnv, storageFrom } from "../config/env.js";
import { createKyselyClient } from "../db/kysely.js";
import { createS3Client } from "../archive/s3.js";
import { fatal } from "../logger.js";
import { linkArchivesToCrawl, writeReplayBundle } from "./write.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const crawlId = (raw: string): string => {
  if (!UUID.test(raw)) throw new InvalidArgumentError("クロールの id (UUID) を渡す");
  return raw;
};

const rebuild = async (opts: { databaseUrl: string; crawl: string }): Promise<void> => {
  const { storage } = collectEnv((need) => ({ storage: storageFrom(need) }));
  const s3 = createS3Client(storage);
  const db = createKyselyClient(opts.databaseUrl);
  try {
    const linked = await linkArchivesToCrawl(db, opts.crawl);
    if (linked > 0) {
      process.stdout.write(`クロールに繋いだアーカイブ ${String(linked)} 本 (027 より前の行)\n`);
    }

    const result = await writeReplayBundle(opts.crawl, null, {
      db,
      s3,
      bucket: storage.bucket,
    });
    if (result === undefined) {
      process.stderr.write(`クロール ${opts.crawl} は台帳に無い\n`);
      process.exitCode = 1;
      return;
    }
    const counts =
      `外した ${String(result.skipped)} 本 (記録が 0)・` +
      `検められなかった ${String(result.failed)} 本`;
    if (result.rev === null) {
      process.stdout.write(`入れる WACZ が無いので書かなかった (${counts})\n`);
    } else if (result.error === null) {
      process.stdout.write(
        `合本 r${String(result.rev)} を書いた: WACZ ${String(result.members)} 本・頁 ${String(result.pages)} 行 (${counts})\n`,
      );
    } else {
      process.stderr.write(`合本 r${String(result.rev)} を書けなかった: ${result.error}\n`);
    }
    if (result.error !== null || result.failed > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("replay-bundle:rebuild")
  .description(
    "クロールの合本 (replay.json と pages.json) を、新しい版として保管庫に書く (台帳と保管庫を直に読み書きする)",
  )
  .addOption(
    new Option("--crawl <id>", "このクロールの合本").argParser(crawlId).makeOptionMandatory(true),
  )
  .addOption(databaseUrlOption)
  .action(rebuild)
  .showHelpAfterError(true);

program.parseAsync(process.argv).catch(fatal);
