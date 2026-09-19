#!/usr/bin/env node
/**
 * アーカイブの API。署名付き URL を配る唯一のもの。
 *
 * ついでにタイマーで outbox を掃き出す。別サービスにせずプロセス内で走らせても
 * 安全なのは、`drainOutbox` が `FOR UPDATE SKIP LOCKED` を取るから —— API の
 * インスタンスが複数あっても、手で叩く `capture-ledger drain` が加わっても、
 * 互いを踏まない。
 */
import Fastify, { type FastifyError } from "fastify";
import { Command, Option } from "commander";
import { collectEnv, fgaFrom, storageFrom, searchConfig } from "../config/env.js";
import { createKyselyClient } from "../db/kysely.js";
import { createFgaClient } from "../fga/client.js";
import { drainOutbox } from "../fga/outbox-worker.js";
import { createS3Client } from "../archive/s3.js";
import { resolveIdentityResolver } from "./identity.js";
import { registerRoutes } from "./routes.js";
import { registerMeRoute } from "./me.js";
import { registerPicker, replayOriginFromEnv } from "./picker.js";
import { parseCaptureFormats } from "../config/capture-formats.js";
import { registerCrawlRoutes } from "./crawls.js";
import { registerSearchRoutes } from "./search.js";
import { registerSinkRoutes, type SinkConfig } from "./sink.js";
import { createSearchClient } from "../search/client.js";
import { createWindmillDispatcher } from "../crawl/dispatch.js";
import { optional } from "../config/env.js";
import { fatal, logger } from "../logger.js";

const DEFAULT_PORT = 7070;
const DEFAULT_DRAIN_INTERVAL_MS = 5_000;
/**
 * 待ち受けるアドレス。既定はループバックのまま —— 外に出すのは配備の判断で、
 * このプロセスは取り込みを起こせる口を持つ(`api/crawls.ts`)。既定で広げない。
 */
const DEFAULT_HOST = "127.0.0.1";

/**
 * この配備が既定で取る形式。`wacz` なのは、このパイプラインが作るのが
 * 再生できるアーカイブで、他の形式はその付随物だから。
 */
const DEFAULT_CAPTURE_FORMATS = "wacz";

interface ServerOptions {
  databaseUrl: string;
  port: number;
  drainIntervalMs: number;
}

const parsePort = (value: string): number => {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be between 1 and 65535");
  }
  return port;
};

const start = async (options: ServerOptions): Promise<void> => {
  // S3 と OpenFGA を **1 つの collectEnv の中で** 建てる。別々に呼ぶと 1 つ目が
  // 投げた時点で 2 つ目は評価されないので、S3 の 4 個を直したあとに FGA の 2 個が
  // 出てきて往復が 2 回になる。
  const { storage, fgaSettings } = collectEnv((need) => ({
    storage: storageFrom(need),
    fgaSettings: fgaFrom(need),
  }));
  const db = createKyselyClient(options.databaseUrl);
  const fga = createFgaClient(fgaSettings);
  const s3 = createS3Client(storage);
  const resolveIdentity = resolveIdentityResolver();

  if (process.env["CAPTURE_LEDGER_DEV_IDENTITY"] === "1") {
    logger.warn(
      "CAPTURE_LEDGER_DEV_IDENTITY=1 — callers are trusted on the X-Capture-ledger-Subject header. Never enable this outside local development.",
    );
  }

  const app = Fastify({
    logger: false,
    // 知らない鍵は **落とさずに拒む**。fastify の ajv は既定で `removeAdditional`
    // が立っており、`additionalProperties: false` は「黙って削る」意味になる ——
    // すると `POST /api/crawls` に効かない設定を渡した呼び出し元が、渡ったつもりの
    // まま 202 を受け取る。頼んだことが無視されたなら、そう言うべき。
    ajv: { customOptions: { removeAdditional: false } },
  });

  /**
   * 予期しない失敗の中身を client に出さない。
   *
   * Fastify の既定は 500 でも `err.message` と `err.code` をそのまま返す。
   * Postgres のエラーはそこに列の型と値の成れの果てを載せてくるので、
   * client 側の誤りが **サーバ内部の形を教える窓** になる。
   *
   * 4xx は素通しする —— あれは client に向けて書かれた文言で、隠す理由が無い。
   * 500 の詳細は logger に残るので、調査する側は何も失わない。
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.send(error);
    }
    logger.error({ err: error, url: request.url }, "Unhandled error");
    return reply.code(500).send({ error: "internal error" });
  });

  registerRoutes(app, { db, fga, s3, resolveIdentity });
  registerMeRoute(app, { fga, resolveIdentity });

  // 成果物の受け口。**BrowserHive が保管庫を持たずに済むための口。**
  //
  // **両方揃ったときだけ生きる。** 鍵だけでは口を出せない (誰でも書ける受け口になる)。
  // 宛先だけでも配れない (署名できない)。片方だけ設定できる道を残すと
  // 「宛先は在るが誰も検めない」が作れてしまう —— 署名の設定で一度踏んだ形。
  const sinkOrigin = optional("CAPTURE_LEDGER_SINK_ORIGIN", "");
  const sinkSecret = optional("CAPTURE_LEDGER_SINK_SECRET", "");
  const sink: SinkConfig | undefined =
    sinkOrigin !== "" && sinkSecret !== "" ? { origin: sinkOrigin, secret: sinkSecret } : undefined;
  if (sink) {
    registerSinkRoutes(app, { db, s3, bucket: storage.bucket, secret: sink.secret });
  } else if (sinkOrigin !== "" || sinkSecret !== "") {
    // **片方だけは設定の誤り。声を上げて止まる。** 黙って従来経路へ落とすと、送り先を
    // 配ったつもりの配備が「なぜか自前の保管庫へ書かれている」状態になり、気づく
    // 手がかりが無い。`crawl/dispatch.ts` が webhook の 2 つに対して同じことをしている。
    throw new Error(
      "CAPTURE_LEDGER_SINK_ORIGIN and CAPTURE_LEDGER_SINK_SECRET must be set together " +
        "(one without the other cannot hand out a sink)",
    );
  }
  registerPicker(app, replayOriginFromEnv());

  // **形式は起動時に 1 回だけ解釈する。** 綴りの誤りをここで落とすため
  // (`config/capture-formats.ts` を見ること)。実行のたびに解釈すると、`waxz` のような
  // 打ち間違いは夜中の定期実行が失敗して初めて見つかる。
  const capture = parseCaptureFormats(
    optional("CAPTURE_LEDGER_CAPTURE_FORMATS", DEFAULT_CAPTURE_FORMATS),
    optional("CAPTURE_LEDGER_CAPTURE_SIGNING", "") === "1",
  );

  // リンクを辿るクロールの口。実行は Windmill の flow が回すので、ここが渡すのは
  // 「頼んだ」という事実だけ。dispatcher は **起動時に** 設定を読む —— 頼まれた瞬間に
  // 「設定がありません」と言うのでは遅く、そのときには行が既に立っている。
  //
  // 設定が無ければ口ごと出さない。**404 になるのは正しい** —— その配備にこの能力は
  // 本当に無いので、「してはいけない」と同じ答えでよい。log で区別が付くようにする。
  const dispatch = createWindmillDispatcher();
  if (dispatch === undefined) {
    logger.info("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL is not set — /api/crawls is not served");
  } else {
    registerCrawlRoutes(app, {
      db,
      fga,
      s3,
      bucket: storage.bucket,
      resolveIdentity,
      dispatch,
      ...(sink && { sink }),
      capture,
    });
  }

  // 全文検索の口。クロールと同じ形 —— 設定が無ければ出さない。索引を持たない配備が
  // ありうるし、そこでは 404 が正しい答え。
  const searchSettings = searchConfig();
  if (searchSettings === undefined) {
    logger.info("CAPTURE_LEDGER_OPENSEARCH_URL is not set — /api/search is not served");
  } else {
    registerSearchRoutes(app, {
      db,
      fga,
      s3,
      search: createSearchClient(searchSettings),
      index: searchSettings.index,
      resolveIdentity,
    });
  }

  const drainTimer = setInterval(() => {
    void drainOutbox(db, fga).catch((err: unknown) => {
      logger.error({ err }, "Scheduled outbox drain failed");
    });
  }, options.drainIntervalMs);
  // タイマーのためだけに event loop を開いたままにしない。
  drainTimer.unref();

  /**
   * **走行中の実行は待たない。** `app.close()` が待つのは応答を返していない
   * リクエストだけで、実行は 202 を返した後に続いているので、その勘定に入らない。
   * 途中で落ちたクロールの行は `running` のまま残り、**部分 unique index が次を全部
   * 塞ぐ** —— 生きているものと区別する術が行に無い。締めるのは flow の failure_module で、
   * `POST /api/crawls/:id/failed` を叩く (capture-scheduler の fail_crawl.ts)。**ledger と flow が
   * 同時に落ちたときだけ**、残った行を手で締めることになる。
   */
  const shutdown = async (): Promise<void> => {
    clearInterval(drainTimer);
    await app.close();
    await db.destroy();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  const host = optional("CAPTURE_LEDGER_API_HOST", DEFAULT_HOST);
  await app.listen({ port: options.port, host });
  logger.info({ port: options.port }, "Archive API listening");
};

const program = new Command()
  .name("capture-api")
  .description("Serve the archive ledger: authorization-gated signed URLs")
  .addOption(
    new Option("--database-url <url>", "Postgres connection string")
      .env("DATABASE_URL")
      .makeOptionMandatory(true),
  )
  .addOption(
    new Option("--port <n>", "Port to listen on")
      .env("CAPTURE_LEDGER_API_PORT")
      .default(DEFAULT_PORT)
      .argParser(parsePort),
  )
  .addOption(
    new Option("--drain-interval-ms <ms>", "How often to deliver queued tuples to OpenFGA")
      .env("CAPTURE_LEDGER_DRAIN_INTERVAL_MS")
      .default(DEFAULT_DRAIN_INTERVAL_MS)
      .argParser((value: string) => Number.parseInt(value, 10)),
  )
  .showHelpAfterError(true);

program.parse(process.argv);
start(program.opts<ServerOptions>()).catch(fatal);
