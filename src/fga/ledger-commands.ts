#!/usr/bin/env node
/**
 * 台帳の保守コマンド。
 *
 * `capture-ledger` (取り込みの client) と分けているのは、これらが仕事を投げるのではなく
 * 台帳を操作するものだから。そして両方とも、別のどこかからタイマーで走らせると
 * 役に立つから。`capture-ledger` は目的が 1 つのコマンドのままにしておく。
 *
 *   capture-ledger drain      積まれた tuple を OpenFGA へ配送する
 *   capture-ledger reconcile  報告が書き留めた manifest の鍵から台帳の穴を埋める
 *   capture-ledger grant      組織に対する権限を与える
 *   capture-ledger revoke     それを取り消す
 */
import { Command, InvalidArgumentError, Option } from "commander";
import { databaseUrlOption } from "../cli/database-url-option.js";
import { fgaConfig, storageConfig } from "../config/env.js";
import { createKyselyClient } from "../db/kysely.js";
import { createFgaClient, FgaUnreachableError, isUnreachable } from "./client.js";
import { drainOutbox } from "./outbox-worker.js";
import { createS3Client } from "../archive/s3.js";
import { reconcile } from "../archive/reconcile.js";
import { isAlreadyInDesiredState } from "./client.js";
import { fatal, logger } from "../logger.js";

/**
 * 日数。**数であることをここで確かめる。** 文字列のまま渡すと SQL の側で解釈され、
 * 誤った値が「0 件」として静かに通る。
 */
const positiveInt = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
};

const runDrain = async (databaseUrl: string): Promise<void> => {
  const config = fgaConfig();
  const db = createKyselyClient(databaseUrl);
  try {
    const result = await drainOutbox(db, createFgaClient(config));
    if (result.unreachable !== undefined) {
      throw new FgaUnreachableError(config.apiUrl, result.unreachable);
    }
    logger.info(result, "Drain finished");
  } finally {
    await db.destroy();
  }
};

const runReconcile = async (databaseUrl: string, sinceDays: number | undefined): Promise<void> => {
  const storage = storageConfig();
  const db = createKyselyClient(databaseUrl);
  try {
    // `--since-days` は「その日数のうちに報告された取り込み」。bucket を歩かないので、
    // 絞れない経路も、絞れずに全走査へ落ちる場合も無い。時刻は DB の `now()` ではなく
    // この process の時計で決める —— 窓は運用者が「いまから何日」と言ったもので、
    // 問い合わせは 1 本なので DB と数秒ずれても結果は変わらない。
    const since =
      sinceDays === undefined ? undefined : new Date(Date.now() - sinceDays * 86_400_000);
    const result = await reconcile(db, createS3Client(storage), storage.bucket, since);
    logger.info(result, "Reconcile finished");
  } finally {
    await db.destroy();
  }
};

/**
 * 組織そのものに対して保存できる権限。
 *
 * `member` は**意図して入れていない**。所属は保存せず、呼び出し元のトークンから
 * contextual tuple として毎回届く —— ここで書けるようにすると、同じ事実の権威が
 * 2 か所に生まれ、食い違ったときにどちらが正しいのか誰にも言えなくなる
 * (`fga/model.fga` の `submitter` の注記)。
 */
const GRANTABLE = ["submitter", "admin"] as const;
type Grantable = (typeof GRANTABLE)[number];

const isGrantable = (value: string): value is Grantable =>
  (GRANTABLE as readonly string[]).includes(value);

/**
 * 組織への権限を 1 つ書く / 消す。
 *
 * outbox を通さず直に書く。outbox が在るのは、tuple の書き込みをアプリの
 * トランザクションに載せられないから —— 運用者が手で叩くこの経路にはその
 * トランザクションが無い。直に書けば、通ったかどうかがその場で分かる。
 */
const runGrant = async (
  relation: string,
  user: string,
  org: string,
  remove: boolean,
): Promise<void> => {
  if (!isGrantable(relation)) {
    throw new Error(`relation must be one of: ${GRANTABLE.join(", ")} (got ${relation})`);
  }
  const tuple = { user: `user:${user}`, relation, object: `organization:${org}` };
  const config = fgaConfig();
  const fga = createFgaClient(config);
  try {
    await fga.write(remove ? { deletes: [tuple] } : { writes: [tuple] });
  } catch (caught) {
    if (isUnreachable(caught)) throw new FgaUnreachableError(config.apiUrl, caught.message);
    // 既にその状態なら、頼まれたことは達成されている。
    if (!isAlreadyInDesiredState(caught)) throw caught;
    logger.info(tuple, remove ? "Already revoked" : "Already granted");
    return;
  }
  logger.info(tuple, remove ? "Revoked" : "Granted");
};

const program = new Command()
  .name("capture-ledger")
  .description("Maintain capture-ledger's archive ledger and its OpenFGA tuples")
  .showHelpAfterError(true);

program
  .command("drain")
  .description("Deliver queued relationship tuples from fga_outbox to OpenFGA")
  .addOption(databaseUrlOption)
  .action(async (opts: { databaseUrl: string }) => {
    await runDrain(opts.databaseUrl);
  });

program
  .command("reconcile")
  .description(
    "Register any reported capture whose manifest was written but is missing from the ledger",
  )
  .addOption(databaseUrlOption)
  .addOption(
    new Option("--since-days <n>", "Only captures reported within the last n days").argParser(
      positiveInt,
    ),
  )
  .action(async (opts: { databaseUrl: string; sinceDays?: number }) => {
    await runReconcile(opts.databaseUrl, opts.sinceDays);
  });

program
  .command("grant")
  .description(`Give <user> <relation> on <organization> (one of: ${GRANTABLE.join(", ")})`)
  .argument("<relation>")
  .argument("<user>")
  .argument("<organization>")
  .action(async (relation: string, user: string, org: string) => {
    await runGrant(relation, user, org, false);
  });

program
  .command("revoke")
  .description("Take back what `grant` gave")
  .argument("<relation>")
  .argument("<user>")
  .argument("<organization>")
  .action(async (relation: string, user: string, org: string) => {
    await runGrant(relation, user, org, true);
  });

program.parseAsync(process.argv).catch(fatal);
