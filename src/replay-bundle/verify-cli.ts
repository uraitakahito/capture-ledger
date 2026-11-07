/**
 * 合本を確かめる: 1 版の `replay.json`・`pages.json`・`replay-digest.json` と WACZ が、署名と合っているか (CAPTURE-61)。
 *
 *   pnpm run replay-bundle:verify --crawl <id> [--rev <n>]                 # 保管庫の版 (既定は台帳が指す版)
 *   pnpm run replay-bundle:verify --crawl <id> --rev <n> --dir <path>      # 手元の写し
 *
 * 照らす物は `replay-bundle/verify.ts` (置き場・digest・署名の 4 段・pages.json・各 WACZ)。**全部 ok のときだけ
 * 終了コード 0。**
 *
 * - 保管庫から読むときは、台帳 (Postgres) でクロールの組織と版を引き、設定の bucket から読む。`--rev` を省けば
 *   台帳が指す版 (`crawls.replay_bundle_rev`) —— capture-workbench と replay が開く版。署名した版が別なら、それも言う
 * - 手元の写し (`--dir`) は、置き場の 3 つと、`resources[].name` の名前の WACZ が並ぶフォルダ。台帳にも保管庫にも
 *   繋がない。どの置き場の写しかは `--crawl` と `--rev` で言う (r3 の中身を r5 と言えば、`place` が落ちる)
 *
 * 錨は署名の設定と同じ 2 つ (`CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR`・`_TIMESTAMP_ANCHOR`) を既定に読み、旗で
 * 差し替えられる (別の根で検めれば落ちることを、手で確かめるため)。
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { collectEnv, storageFrom } from "../config/env.js";
import { readAnchor } from "../config/signer.js";
import { createKyselyClient } from "../db/kysely.js";
import { createS3Client } from "../archive/s3.js";
import { fatal } from "../logger.js";
import { replayBundleDir } from "./format.js";
import {
  dirSource,
  storeSource,
  verifyReplayBundle,
  type BundleClaim,
  type BundleSource,
  type CheckLine,
} from "./verify.js";
import { assertOpensslUsable, DEFAULT_OPENSSL_BIN } from "./verify-signed-data.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const crawlId = (raw: string): string => {
  if (!UUID.test(raw)) throw new InvalidArgumentError("クロールの id (UUID) を渡す");
  return raw;
};

const revision = (raw: string): number => {
  const rev = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(rev) || rev < 1) {
    throw new InvalidArgumentError("版は 1 以上の整数");
  }
  return rev;
};

interface VerifyOptions {
  crawl: string;
  rev?: number;
  dir?: string;
  trustAnchor: string;
  timestampAnchor: string;
  opensslBin: string;
  databaseUrl?: string;
}

/** 照らした結果を 1 行ずつ。 */
const print = (where: string, claim: BundleClaim, lines: readonly CheckLine[]): boolean => {
  process.stdout.write(
    `合本 ${where} (クロール ${claim.crawlId} の r${String(claim.rev)}) を確かめた:\n`,
  );
  for (const line of lines) {
    process.stdout.write(
      `  ${(line.ok ? "ok" : "FAILED").padEnd(7)} ${line.check.padEnd(10)} ${line.detail}\n`,
    );
  }
  const failed = [...new Set(lines.filter((line) => !line.ok).map((line) => line.check))];
  if (failed.length === 0) {
    process.stdout.write("合っている: 署名と、署名が覆う物 (置き場・pages.json・WACZ) が全部\n");
    return true;
  }
  process.stdout.write(`合っていない: ${failed.join("・")}\n`);
  return false;
};

const verify = async (opts: VerifyOptions): Promise<void> => {
  const anchors = {
    signing: readAnchor("--trust-anchor", opts.trustAnchor),
    timestamp: readAnchor("--timestamp-anchor", opts.timestampAnchor),
  };
  // 時刻印を検める openssl が `ts -attime` を持つか。持たなければ「時刻印が覆っていない」と嘘を言う前に止まる
  await assertOpensslUsable(opts.opensslBin);
  const options = { anchors, opensslBin: opts.opensslBin };

  if (opts.dir !== undefined) {
    if (opts.rev === undefined) {
      process.stderr.write("--dir には --rev も要る (どの版の写しかを言う)\n");
      process.exitCode = 1;
      return;
    }
    const claim = { crawlId: opts.crawl, rev: opts.rev };
    const source = dirSource(opts.dir);
    if (!print(source.where, claim, await verifyReplayBundle(source, claim, options))) {
      process.exitCode = 1;
    }
    return;
  }

  if (opts.databaseUrl === undefined || opts.databaseUrl === "") {
    process.stderr.write("保管庫から読むには --database-url (DATABASE_URL) が要る\n");
    process.exitCode = 1;
    return;
  }
  const { storage } = collectEnv((need) => ({ storage: storageFrom(need) }));
  const db = createKyselyClient(opts.databaseUrl);
  try {
    const crawl = await db
      .selectFrom("crawls")
      .select(["orgId", "replayBundleRev", "replayBundleSignedRev"])
      .where("id", "=", opts.crawl)
      .executeTakeFirst();
    if (crawl === undefined) {
      process.stderr.write(`クロール ${opts.crawl} は台帳に無い\n`);
      process.exitCode = 1;
      return;
    }
    const rev = opts.rev ?? crawl.replayBundleRev;
    if (rev === null) {
      process.stderr.write(`クロール ${opts.crawl} の合本は、まだ書けていない\n`);
      process.exitCode = 1;
      return;
    }
    if (opts.rev === undefined && crawl.replayBundleSignedRev !== rev) {
      process.stdout.write(
        crawl.replayBundleSignedRev === null
          ? `台帳が指す r${String(rev)} を確かめる (署名した版は無い)\n`
          : `台帳が指す r${String(rev)} を確かめる (署名した版は r${String(crawl.replayBundleSignedRev)}。` +
              `そちらは --rev ${String(crawl.replayBundleSignedRev)})\n`,
      );
    }
    const claim = { crawlId: opts.crawl, rev, orgId: crawl.orgId };
    const source: BundleSource = storeSource(
      createS3Client(storage),
      storage.bucket,
      replayBundleDir(crawl.orgId, opts.crawl, rev),
    );
    if (!print(source.where, claim, await verifyReplayBundle(source, claim, options))) {
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("replay-bundle:verify")
  .description(
    "合本の 1 版 (replay.json・pages.json・replay-digest.json と WACZ) が、署名と合っているかを確かめる",
  )
  .addOption(
    new Option("--crawl <id>", "このクロールの合本").argParser(crawlId).makeOptionMandatory(true),
  )
  .addOption(
    new Option("--rev <n>", "確かめる版 (省けば台帳が指す版。--dir では要る)").argParser(revision),
  )
  .addOption(
    new Option(
      "--dir <path>",
      "手元の写し (replay.json・pages.json・replay-digest.json と、resources の name の WACZ)。省けば保管庫から読む",
    ),
  )
  .addOption(
    new Option("--trust-anchor <pem>", "署名の鎖を照らす根 (PEM のファイル)")
      .env("CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR")
      .makeOptionMandatory(true),
  )
  .addOption(
    new Option("--timestamp-anchor <pem>", "時刻印の局の鎖を照らす根 (PEM のファイル)")
      .env("CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR")
      .makeOptionMandatory(true),
  )
  .addOption(
    new Option("--openssl-bin <path>", "時刻印を検める openssl (ts -attime が要る)")
      .env("CAPTURE_LEDGER_OPENSSL_BIN")
      .default(DEFAULT_OPENSSL_BIN),
  )
  .addOption(
    new Option("--database-url <url>", "Postgres (保管庫から読むときだけ。組織と版を引く)").env(
      "DATABASE_URL",
    ),
  )
  .action(verify)
  .showHelpAfterError(true);

program.parseAsync(process.argv).catch(fatal);
