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
import { collectEnv, fgaFrom, storageFrom, searchFrom } from "../config/env.js";
import { envFilesNote, readEnvFiles } from "../config/env-files.js";
import { createKyselyClient } from "../db/kysely.js";
import { createFgaClient } from "../fga/client.js";
import { drainOutbox } from "../fga/outbox-worker.js";
import { createS3Client } from "../archive/s3.js";
import { submitterOrganizations } from "./authorization.js";
import { selectIdentity } from "./identity.js";
import { startupNotes, type StartupFacts } from "./startup-notes.js";
import { registerRoutes } from "./routes.js";
import { registerMeRoute } from "./me.js";
import { registerScriptsRoute } from "./scripts.js";
import { registerPicker, replaywebServerOriginFromEnv } from "./picker.js";
import { parseCaptureFormats } from "../config/capture-formats.js";
import { registerCrawlRoutes } from "./crawls.js";
import { registerScheduleRoutes } from "./schedules.js";
import type { ReplayBundleWriter } from "../crawl/launch.js";
import { levelClock, levelDispatcher } from "../crawl/launch.js";
import { prepareCrawl } from "../crawl/prepare.js";
import { scheduleSettings } from "../config/schedules.js";
import { scheduleStoreOf } from "../schedules/store.js";
import { scheduleClock, type ScheduleClock } from "../schedules/tick.js";
import { registerReplayBundleRoutes } from "./replay-bundle.js";
import { signerFromEnv } from "../config/signer.js";
import { createReplayBundleSigner } from "../replay-bundle/sign.js";
import { writeReplayBundle } from "../replay-bundle/write.js";
import { createTsCompile } from "../config/ts-compile.js";
import { claudeBudgetUsd, createClaude } from "../config/claude.js";
import { derivationStoreOf } from "../derivations/store.js";
import { registerSearchRoutes } from "./search.js";
import { registerChangeRoutes } from "./changes.js";
import { changeReadsOf } from "../changes/reads.js";
import { changeStoreOf } from "../changes/store.js";
import { changeClock } from "../changes/worker.js";
import { registerSinkRoutes, type SinkConfig } from "./sink.js";
import { createSearchClient, ensureSearchReady } from "../search/client.js";
import { createWindmillDispatcher } from "../crawl/dispatch.js";
import { createWindmillVariables } from "../crawl/windmill-variables.js";
import { optional } from "../config/env.js";
import { fatal, logger } from "../logger.js";

const DEFAULT_PORT = 7070;
const DEFAULT_DRAIN_INTERVAL_MS = 5_000;
/**
 * 待ち受けるアドレス。既定はループバックのまま —— 外に出すのは配備の判断で、
 * このプロセスは取り込みを始められるエンドポイントを持つ(`api/crawls.ts`)。既定で広げない。
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
  // **最初に、値の出どころを言う。** 足りなくてここから先へ進めなかったときにこそ要る
  // 行なので、何かを建てる前に出す (collectEnv はこの直後に投げうる)。
  logger.info(envFilesNote(readEnvFiles()));
  // S3 と OpenFGA を **1 つの collectEnv の中で** 建てる。別々に呼ぶと 1 つ目が
  // 投げた時点で 2 つ目は評価されないので、S3 の 4 個を直したあとに FGA の 2 個が
  // 出てきて往復が 2 回になる。
  const { storage, fgaSettings, searchSettings } = collectEnv((need) => ({
    storage: storageFrom(need),
    fgaSettings: fgaFrom(need),
    searchSettings: searchFrom(need),
  }));
  const db = createKyselyClient(options.databaseUrl);
  const fga = createFgaClient(fgaSettings);
  const s3 = createS3Client(storage);
  // 機械 (M2M) の組織はトークンに載らないので、OpenFGA に保存した許可から引く。
  const identity = selectIdentity({
    machineOrganizations: (subject) => submitterOrganizations(fga, subject),
  });
  const resolveIdentity = identity.resolve;
  // どの名乗り方で起きたか。起動ログと picker が同じものを言う —— resolver は渡さない
  // (どちらも言うだけで、検めはしない)。
  const identityMode: StartupFacts["identity"] =
    identity.mode === "jwt" ? { mode: "jwt", issuer: identity.issuer } : { mode: identity.mode };
  // 待ち受け。listen の直前ではなくここで決めるのは、picker が「外に出ている」を画面で言うため。
  const listen = { host: optional("CAPTURE_LEDGER_API_HOST", DEFAULT_HOST), port: options.port };

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
  // 型の検査のクライアント (ts-compile-service を host の loopback で)。クロールとスクリプトのエンドポイントの両方が使う
  const tsCompile = createTsCompile();
  // 何が走るかを、**頼む前に**訊けるエンドポイント。webhook の設定が無い配備でも出す ——
  // 登録済みのスクリプトが無いことは、クロールを始められるかどうかとは別の問いなので。
  registerScriptsRoute(app, { db, fga, resolveIdentity, ...(tsCompile && { tsCompile }) });

  // 成果物の受け取り先。**BrowserHive が保管庫を持たずに済むためのエンドポイント。**
  //
  // **両方揃ったときだけ生きる。** 鍵だけでは受け取り先を出せない (誰でも書ける受け取り先になる)。
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
  registerPicker(app, {
    replaywebServerOrigin: replaywebServerOriginFromEnv(),
    identity: identityMode,
    listen,
  });

  // 合本の署名 (CAPTURE-61)。**起動で 1 回だけ読んで確かめる** —— 4 つ組の一部だけ・WACZ の署名を求めるのに無い・
  // 錨が読めない・openssl が `ts -attime` を持たない、のどれでもここで止まる (`config/signer.ts`)。合本のたびに
  // 「署名が付かない」と言われても、直す先が分からない。
  const signerConfig = await signerFromEnv();
  const signer = signerConfig === undefined ? undefined : createReplayBundleSigner(signerConfig);
  if (signerConfig === undefined) {
    logger.info("CAPTURE_LEDGER_SIGNER_URL is not set — replay bundles are not signed");
  } else {
    logger.info(
      { url: signerConfig.url, opensslBin: signerConfig.opensslBin },
      "Replay bundles of finished crawls are signed",
    );
  }

  // **形式は起動時に 1 回だけ解釈する。** 綴りの誤りをここで落とすため
  // (`config/capture-formats.ts` を見ること)。実行のたびに解釈すると、`waxz` のような
  // 打ち間違いは夜中の定期実行が失敗して初めて見つかる。
  const capture = parseCaptureFormats(
    optional("CAPTURE_LEDGER_CAPTURE_FORMATS", DEFAULT_CAPTURE_FORMATS),
    optional("CAPTURE_LEDGER_CAPTURE_SIGNING", "") === "1",
  );

  // リンクを辿るクロールのエンドポイント。実行は Windmill の flow が回すので、ここが渡すのは
  // 「頼んだ」という事実だけ。dispatcher は **起動時に** 設定を読む —— 頼まれた瞬間に
  // 「設定がありません」と言うのでは遅く、そのときには行が既に立っている。
  //
  // 設定が無ければエンドポイントごと出さない。**404 になるのは正しい** —— その配備にこの能力は
  // 本当に無いので、「してはいけない」と同じ答えでよい。log で区別が付くようにする。
  const dispatch = createWindmillDispatcher();
  // 定期実行の周回 (`schedules/tick.ts`)。クロールのエンドポイントと同じ設定で動くので、エンドポイントが無い配備では周回も無い
  let clock: ScheduleClock | undefined;
  // 投げる係の時計 (CAPTURE-180)。受け取りを確かめられない段を送り直し、10 分で諦める。webhook の無い配備では無い
  let levelClockHere: ReturnType<typeof levelClock> | undefined;
  // Claude のクライアント。直す係 (下) と前回からの変化の周回が同じ物を使う。鍵が無ければ無い
  const claude = createClaude();
  if (dispatch === undefined) {
    logger.info("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL is not set — /api/crawls is not served");
  } else {
    // 宣言で結ぶシークレットが Windmill に在るかを訊くクライアント。webhook と同じ設定から作る (新しい env は無い)。
    // 無いのは URL が flow の webhook の形でないときだけで、そのときシークレットを宣言したクロールは 400。
    const windmill = createWindmillVariables();
    if (windmill === undefined) {
      logger.warn(
        "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL is not a flow webhook (…/api/w/<workspace>/jobs/run/…) — " +
          "crawls whose scripts declare secrets are refused",
      );
    }
    // **クロールを始めるには型の検査のクライアントが要る。** 始めるエンドポイントが、必須の変数が渡されているかをここに訊く。
    // 無ければ起動で止める (黙って飛ばすと、必須を渡さないクロールが flow まで進んでから落ちる)。
    if (tsCompile === undefined) {
      throw new Error(
        "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL needs CAPTURE_LEDGER_TS_COMPILE_URL " +
          "(POST /api/crawls asks ts-compile-service whether the required variables are given)",
      );
    }
    if (claude === undefined) {
      logger.info(
        "CAPTURE_LEDGER_ANTHROPIC_API_KEY is not set — /api/crawls/:id/inline/:name/fix is not served",
      );
    }
    // 締めた後の合本 (`/failed`・投げられなかった段)。合本のエンドポイントと同じ関数・同じ署名のクライアント
    const bundleWriter: ReplayBundleWriter = (crawlId, depth) =>
      writeReplayBundle(crawlId, depth, {
        db,
        s3,
        bucket: storage.bucket,
        ...(signer && { signer }),
      });
    // **投げる係は 1 つ** (CAPTURE-180)。クロールのエンドポイント・定期実行の周回・投げる係の時計が分け合う
    const levels = levelDispatcher({
      db,
      dispatch,
      writeReplayBundle: bundleWriter,
      ...(sink && { sink }),
    });
    levelClockHere = levelClock(levels);
    registerCrawlRoutes(app, {
      db,
      fga,
      s3,
      bucket: storage.bucket,
      resolveIdentity,
      dispatch,
      levels,
      ...(sink && { sink }),
      ...(windmill && { windmill }),
      tsCompile,
      ...(claude && {
        claude,
        derivations: derivationStoreOf(db),
        claudeBudgetUsd: claudeBudgetUsd(),
      }),
      capture,
      writeReplayBundle: bundleWriter,
    });

    // 定期実行。周回はクロールを始める係をエンドポイントと分け合う。始める前に確かめる関数も同じ物
    const settings = scheduleSettings();
    const store = scheduleStoreOf(db);
    const { dispatchLevel } = levels;
    const scheduleClockHere = scheduleClock({
      store,
      capture,
      ...(sink && { sink }),
      ...(windmill && { windmill }),
      dispatchLevel,
      startedAt: new Date(),
      quietMs: settings.quietMinutes * 60_000,
      now: () => new Date(),
    });
    clock = scheduleClockHere;
    registerScheduleRoutes(app, {
      fga,
      resolveIdentity,
      store,
      prepare: (body, who) =>
        prepareCrawl(
          { db, tsCompile, formats: capture.formats, ...(windmill && { windmill }) },
          body,
          who,
        ),
      poke: () => {
        scheduleClockHere.poke();
      },
      minIntervalMinutes: settings.minIntervalMinutes,
      now: () => new Date(),
    });
    // 合本のエンドポイント (`api/replay-bundle.ts`)。クロールの flow が段ごとに叩く。合本は保管庫に書くので bucket が要る
    registerReplayBundleRoutes(app, {
      db,
      fga,
      s3,
      bucket: storage.bucket,
      resolveIdentity,
      ...(signer && { signer }),
    });
  }

  // 全文検索のエンドポイント。**必須** (CAPTURE-53) —— 宛先は上の collectEnv が他の設定と一緒に求める。
  // 起動の時に OpenSearch に繋いで索引を作る (無ければ)。答えなければここで止まる。以前の
  // 「設定が無ければエンドポイントを出さない」形では、flow の索引の段が 404 を「飛ばした」として緑で終わり、
  // 検索が無いことに誰も気づかなかった。
  const search = createSearchClient(searchSettings);
  await ensureSearchReady(search, searchSettings);
  logger.info(
    { url: searchSettings.url, index: searchSettings.index },
    "Full-text search is ready",
  );
  registerSearchRoutes(app, {
    db,
    fga,
    s3,
    search,
    index: searchSettings.index,
    resolveIdentity,
  });

  // 前回からの変化 (CAPTURE-167)。予定の回を前の回と比べ、違えば Claude に要約させる。鍵が無ければ比べるだけ。
  // webhook の無い配備でも回す (予定の回が在れば比べられる)
  registerChangeRoutes(app, { fga, resolveIdentity, reads: changeReadsOf(db) });
  const changes = changeClock({
    store: changeStoreOf(db),
    spentThisMonth: (orgId) => derivationStoreOf(db).spentThisMonth(orgId),
    s3,
    ...(claude && { claude }),
    budgetUsd: claudeBudgetUsd(),
    now: () => new Date(),
  });

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
   * `POST /api/crawls/:id/failed` を叩く (capture-scheduler の fail_crawl.ts)。行を足してから webhook を投げ終える
   * までの間に ledger が落ちたときは、段の行 (`crawl_levels`) が残るので、起こし直した後に投げる係の時計が送る
   * (CAPTURE-180)。**ledger と flow が同時に落ちたとき**は、残った行を手で締めることになる (定期の回なら状態が
   * `stuck` になり、画面に「締める」が出る)。
   */
  const shutdown = async (): Promise<void> => {
    clearInterval(drainTimer);
    await clock?.stop();
    await levelClockHere?.stop();
    await changes.stop();
    await app.close();
    await db.destroy();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  await app.listen(listen);
  // **待ち受けの後に回す。** 周回が投げた段の報告は、この API に戻ってくる
  clock?.start();
  levelClockHere?.start();
  changes.start();
  // 最後に、待ち受け・名乗り方と、段の報告を受けられるかを言う (`startup-notes.ts`)。
  // 開発用ヘッダの警告もここから出る —— ヘッダが実際に効いているときだけ。
  const notes = startupNotes({
    ...listen,
    identity: identityMode,
    devIdentity: process.env["CAPTURE_LEDGER_DEV_IDENTITY"] === "1",
    crawls: dispatch !== undefined,
    sink: sink !== undefined,
  });
  for (const note of notes) logger[note.level](note.fields ?? {}, note.msg);
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
