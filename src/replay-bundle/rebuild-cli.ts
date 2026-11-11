/**
 * 合本を作り直す: クロール 1 本の合本を、新しい版として保管庫に書く (CAPTURE-56)。
 *
 *   pnpm run replay-bundle:rebuild --crawl <id>
 *
 * **打つのは、段の合本に入っていない物があるとき。** flow は段の報告の後に合本のエンドポイント
 * (`POST /api/crawls/:id/replay-bundle`) を叩くが、それより後に capture-ledger に入った物は、次の段が無ければどの合本にも入らない:
 *
 * - 後から reconcile が受けた取り込み (段の登録で manifest を読めなかった物)
 * - 保管庫に書けなかった段 (`crawls.replay_bundle_error`)・flow が落ちた段の後
 * - 027 より前のクロール。先にそのクロールのアーカイブに `crawl_id` を入れる (`crawl_pages.task_id` から。
 *   capture-ledger の他のエンドポイントと同じ繋ぎ方)
 *
 * エンドポイントと同じ関数 (`replay-bundle/write.ts`) を、API を通らずに capture-ledger (Postgres) と保管庫 (S3) に直に当てる。アクセス
 * トークンは使わず、認可も通らない —— 書くのは、capture-ledger と保管庫が既に持っている物から組んだ合本だけ。版はエンドポイントと同じく
 * 払い出すので、flow の段と重なっても版は食い違わない (capture-ledger が指すのは大きいほう)。
 *
 * **署名も API と同じに判定する** (`config/signer.ts`)。署名の 4 つ組が揃い、クロールが終わっていて、未検めの WACZ が
 * 残っていなければ、新しい版に署名する —— 署名の付かなかった合本を署名し直すのは、これを打つこと (前の置き場に
 * digest を足すことはしない)。4 つ組の一部だけ・`CAPTURE_LEDGER_CAPTURE_SIGNING=1` で無い、なら書く前に止まる。
 *
 * 書けなかった・検められなかった WACZ が在る・終わったクロールなのに署名が付かなかった、のどれでも終了コード 1
 * (打ち直せば拾う・署名し直す)。
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { databaseUrlOption } from "../cli/database-url-option.js";
import { collectEnv, storageFrom } from "../config/env.js";
import { signerFromEnv } from "../config/signer.js";
import { createKyselyClient } from "../db/kysely.js";
import { createS3Client } from "../archive/s3.js";
import { fatal } from "../logger.js";
import { createReplayBundleSigner } from "./sign.js";
import { linkArchivesToCrawl, writeReplayBundle } from "./write.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const crawlId = (raw: string): string => {
  if (!UUID.test(raw)) throw new InvalidArgumentError("クロールの id (UUID) を渡す");
  return raw;
};

const rebuild = async (opts: { databaseUrl: string; crawl: string }): Promise<void> => {
  const { storage } = collectEnv((need) => ({ storage: storageFrom(need) }));
  // 署名の設定は API と同じ判定。一部だけ・錨が読めない・openssl が使えない、なら何も書く前に止まる
  const signerConfig = await signerFromEnv();
  const signer = signerConfig === undefined ? undefined : createReplayBundleSigner(signerConfig);
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
      ...(signer && { signer }),
    });
    if (result === undefined) {
      process.stderr.write(`クロール ${opts.crawl} は capture-ledger に無い\n`);
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
    if (result.digestKey !== null) {
      process.stdout.write(`署名した: ${result.digestKey}\n`);
    } else if (result.signError !== null) {
      process.stderr.write(`署名しなかった: ${result.signError}\n`);
    } else if (result.rev !== null && result.error === null) {
      process.stdout.write(
        signer === undefined
          ? "署名はしない (CAPTURE_LEDGER_SIGNER_URL などの設定が無い)\n"
          : "署名はしない (クロールが走っている)\n",
      );
    }
    if (result.error !== null || result.failed > 0 || result.signError !== null) {
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("replay-bundle:rebuild")
  .description(
    "クロールの合本 (replay.json と pages.json) を、新しい版として保管庫に書く (capture-ledger の DB と保管庫を直に読み書きする)",
  )
  .addOption(
    new Option("--crawl <id>", "このクロールの合本").argParser(crawlId).makeOptionMandatory(true),
  )
  .addOption(databaseUrlOption)
  .action(rebuild)
  .showHelpAfterError(true);

program.parseAsync(process.argv).catch(fatal);
