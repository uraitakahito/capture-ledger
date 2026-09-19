/**
 * リンクを辿る取り込みを、外から起こすための口。
 *
 * 実行そのものは Windmill の flow が回し、BrowserHive を直接呼ぶ。ここに残るのは
 * **認可・方針・記録** の 3 つ —— つまり「誰が起こしてよいか」「どこまで辿るか」
 * 「何が起きたか」。走らせる段取りは持たない。
 *
 * ## なぜ判断がここに集まるのか
 *
 * 範囲の絞り込みも重複排除も上限の判定も、**flow ではなくこちら**で行う。方針は
 * `crawls` の行に在り、重複排除は `crawl_pages` の unique index が持っているので、
 * 判断材料が両方ここに在る。flow 側に写すと、2 つの場所が食い違ったときにどちらが
 * 正しいのか言えなくなる。
 *
 * flow がすることは「見つけたものを全部報告し、次に取るものを受け取る」だけ。
 *
 * ## 走行中は 1 本
 *
 * ホストあたりの間隔は flow のループの形が守っている。2 本のクロールが同時に走ると
 * 互いの間隔が見えず、同じホストへの頻度が黙って倍になる。だから `crawls` の部分
 * unique index で 1 本に縛り、違反を 409 に翻訳する (`007-create-crawls` に詳しい)。
 *
 * ## 帰属
 *
 * 投げるのが ledger でなくなっても、`capture_submissions` はここで書く。段ごとの
 * 報告に taskId と manifest の置き場所が載っているので、そのときに書けばよい。
 * reconciler (`archive/reconcile.ts`) はこの行だけを読む —— **報告の届かなかった
 * 取り込みは、ここに行が無いので台帳に入らない**。
 */
import type { FastifyInstance } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Insertable, Kysely } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { CaptureSubmissionsTable, CrawlsTable, Database, CrawlScope } from "../db/database.js";
import type { IdentityResolver } from "./identity.js";
import { admitLevel } from "../crawl/admit-level.js";
import { acceptLinks, parseHttpUrl, type DiscoveredLink, type ParsedUrl } from "../crawl/scope.js";
import { planNextLevel } from "../crawl/budget.js";
import { getJsonObject } from "../archive/s3.js";
import { manifestOutcome } from "../archive/manifest.js";
import { isUniqueViolation, maySubmit, unauthorized } from "./authorization.js";
import { withLinks, type CaptureFormats, type CaptureSettings } from "../config/capture-formats.js";
import { loadTargets } from "../data/url-source.js";
import { createChildLogger } from "../logger.js";
import { crawlKeyPrefix, sinkForCrawl, type SinkConfig } from "./sink.js";

const log = createChildLogger({ module: "api" });

/**
 * 既定の方針。**控えめな側に倒してある。**
 *
 * `MAX_PAGES` が小さいのは、深さより先にこちらで止まるのが普通であってほしいから ——
 * 上限が働いていることが日常的に見えていれば、「全部辿った」と思い込む余地が消える。
 * 広げるのは呼ぶ側の意図的な行為にする。
 *
 * `PER_HOST_DELAY_MS` は 1 回の取り込みが 1 リクエストではないことを踏まえた値。
 * ブラウザはサブリソースまで取るので、1 ページが相手には数十本のバーストに見える。
 */
const DEFAULT_SCOPE: CrawlScope = "same-origin";
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_PER_HOST_DELAY_MS = 2000;
const DEFAULT_HOST_PARALLELISM = 4;
/** `GET /api/crawls/:id` が返す、取れなかったページの数の上限。理由を読むには数本で足りる。 */
const FAILURES_SHOWN = 5;

/**
 * Windmill に投げる関数。既定は webhook を叩くもので、試験だけが差し替える。
 * 起こした job の id を返す (Windmill が返さなければ undefined)。
 */
export type CrawlDispatcher = (crawl: DispatchedCrawl) => Promise<string | undefined>;

/**
 * Windmill の flow に渡す 1 段ぶんの仕事。
 *
 * **段の繰り返しは ledger が回す。** flow は 1 段を処理して報告するだけで、次があるかを
 * 判断しない。そうしたのは、Windmill の while ループが止まらなかったから ——
 * `stop_after_if` を付けた最小の flow が 643 回まで回り続けた (実測)。相手のサーバに
 * 負荷をかけない仕組みを、暴走しうるループの上には載せられない。
 *
 * 上限の判定は `budget.ts` に在って単体試験がある。**繰り返しは、その判定と同じ場所に置く。**
 */
export interface DispatchedCrawl {
  crawlId: string;
  depth: number;
  /**
   * この段で取る URL。空で渡すことはない。
   *
   * `lastFinishedAt` は **そのホストを最後に触り終えた時刻**。段をまたぐ間隔を
   * 守るために要る —— 間隔は `crawl_host` の呼び出し 1 回の中でしか効かないので、
   * これが無いと段の境目だけ間隔が空かない。実測で 521ms まで詰まった。
   */
  frontier: { url: string; host: string; lastFinishedAt: string | null }[];
  perHostDelayMs: number;
  hostParallelism: number;
  /**
   * 取り込む形式と署名。**必ず載せる。**
   *
   * flow の schema の既定値には頼れない —— Windmill は webhook 起動のとき
   * 既定値を埋めないので、送らなければ `undefined` が届く (実測)。決めるのは
   * 依然として ledger 側で、flow は言われたとおりに投げる。
   */
  captureFormats: CaptureFormats;
  /**
   * 成果物の送り先。**在れば BrowserHive はそこへ押し出し、自前の保管庫へは書かない。**
   *
   * 段ごとに作る —— クロールは長く続きうるので、後の段には新しい期限を配る。
   * 無ければ従来どおり BrowserHive が自前の保管庫へ書く (2 つの経路は同時に生きる)。
   */
  artifactSink?: { url: string; token: string };
  signing: boolean;
}

export interface CrawlRouteDeps {
  /** 取り込む形式と署名。起動時に env から解釈したもの (`config/capture-formats.ts`)。 */
  capture: CaptureSettings;
  db: Kysely<Database>;
  fga: OpenFgaClient;
  /**
   * `.links.json` を読むため。**リンクを読むのは ledger の仕事にしてある** ——
   * Windmill に読ませると S3 の資格情報と到達性をあちらにも用意することになり、
   * (別ドメインのコンテナからは seaweedfs に届かないという実務上の壁もある)
   * 「見つけた URL は何か」の判断材料が 2 か所に散る。
   */
  s3: S3Client;
  bucket: string;
  resolveIdentity: IdentityResolver;
  /** 受け口の設定。無ければ送り先を配らない。 */
  sink?: SinkConfig;
  dispatch: CrawlDispatcher;
}

interface CrawlBody {
  seeds?: string[];
  /**
   * 種を明示せず、`capture_targets` の有効な行から取る。
   *
   * これが `runs` を畳んだ先。既定では**辿らない** (`maxDepth: 0`) ので、
   * 「登録済みの URL 一覧を、いま全部取ってこい」がそのまま表せる。
   */
  fromTargets?: { limit?: number };
  scope?: CrawlScope;
  maxDepth?: number;
  maxPages?: number;
  perHostDelayMs?: number;
  hostParallelism?: number;
}

/** 段の報告 1 件。flow が 1 ページ処理するたびに 1 つ積む。 */
interface PageReport {
  url: string;
  status: "captured" | "failed" | "skipped";
  skipReason?: string;
  taskId?: string;
  correlationId?: string;
  submittedAt?: string;
  finishedAt?: string;
  /** `.links.json` の置き場所 (`s3://bucket/key`)。中身を読むのはこちら。 */
  linksLocation?: string;
  /**
   * `.result.json` を書けた場所 (`s3://bucket/key`)。BrowserHive (または受け口) の答えのまま。
   * **台帳はこれを組み直さない。**
   */
  manifestLocation?: string;
  /** 書けなかった理由。`taskId` を持つ報告は、この 2 つのどちらか一方を必ず持つ。 */
  manifestError?: string;
}

interface LevelBody {
  depth: number;
  results: PageReport[];
}

export const registerCrawlRoutes = (app: FastifyInstance, deps: CrawlRouteDeps): void => {
  const { db, fga, resolveIdentity, dispatch, capture, sink } = deps;

  /**
   * 段を 1 つ Windmill へ投げる。**待たない** —— この Promise の行き先は `crawls` の行で、
   * 応答ではない。
   *
   * 起こした job の id を `last_job_*` に残す (`016`)。失敗したクロールから、その run へ
   * 1 回で辿れるように。**深さが戻る書き込みはしない** —— 段の報告は速いので、前の段の
   * id が次の段の id の後に届くことがありうる。
   *
   * 投げられなければクロールを締める。黙って `running` のまま置くと、部分 unique index が
   * 以後のクロールを全部塞ぐ。以前はこの 2 つを、最初の段と次の段の 2 か所に写していた。
   */
  const dispatchLevel = (level: DispatchedCrawl): void => {
    const { crawlId, depth } = level;
    void dispatch(level)
      .then(
        async (jobId) => {
          if (jobId === undefined) return;
          await db
            .updateTable("crawls")
            .set({ lastJobId: jobId, lastJobDepth: depth })
            .where("id", "=", crawlId)
            .where((eb) => eb.or([eb("lastJobDepth", "is", null), eb("lastJobDepth", "<=", depth)]))
            .execute();
        },
        async (err: unknown) => {
          log.error({ err, crawlId, depth }, "Could not dispatch a level");
          await db
            .updateTable("crawls")
            .set({
              state: "failed",
              stopReason: "failed",
              finishedAt: new Date().toISOString(),
              error: err instanceof Error ? err.message : String(err),
            })
            .where("id", "=", crawlId)
            .execute();
        },
      )
      .catch((updateErr: unknown) => {
        log.error({ err: updateErr, crawlId, depth }, "Could not record the dispatch");
      });
  };

  /**
   * クロールを 1 本起こす。
   *
   * 完了は待たない —— 段を重ねるので、待てる呼び出し元が居ない。受理したことだけを
   * 202 で返し、続きは `crawls` の行が語る。
   */
  app.post<{ Body: CrawlBody | undefined }>(
    "/api/crawls",
    {
      schema: {
        body: {
          type: "object",
          // 知らない鍵は拒む。`server.ts` の `removeAdditional: false` がこれを
          // 「黙って削る」ではなく「400 で返す」意味にしている。
          additionalProperties: false,
          // **`seeds` と `fromTargets` のどちらか一方**。schema では表さず handler で
          // 見る —— ajv の `oneOf` は「どちらでもない」と「両方」を同じ 400 にするが、
          // 呼ぶ側にとっては別の間違いなので、言い分を分けたい。
          properties: {
            // **1 本以上。** 種を持たないクロールは始まりが無いので進みようがなく、
            // 受理されたのに何も起きない、という形になる (`011` の CHECK と対)。
            seeds: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
            fromTargets: {
              type: "object",
              additionalProperties: false,
              properties: { limit: { type: "integer", minimum: 1 } },
            },
            scope: { type: "string", enum: ["same-origin", "same-host"] },
            maxDepth: { type: "integer", minimum: 0, maximum: 10 },
            maxPages: { type: "integer", minimum: 1, maximum: 10000 },
            // 0 を許すのは、試験で意図的に間隔を外せるようにするため。
            perHostDelayMs: { type: "integer", minimum: 0, maximum: 600000 },
            hostParallelism: { type: "integer", minimum: 1, maximum: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);

      if (!(await maySubmit(fga, identity))) {
        log.info({ subject: identity.subject }, "Denied");
        return reply.code(404).send({ error: "not found" });
      }

      const body = request.body ?? {};

      // **どちらか一方。** 両方渡されたら、どちらを使うかをこちらが決めることに
      // なるので拒む。片方も無ければ始まりが無い。
      const fromTargets = body.fromTargets;
      if ((body.seeds === undefined) === (fromTargets === undefined)) {
        return reply.code(400).send({ error: "provide exactly one of seeds or fromTargets" });
      }

      // 組織は呼び出し元の 1 つ目。`maySubmit` はどれか 1 つで許されていれば通すので、
      // 帰属も同じ組織に寄せる。**対象を読むときの絞り込みにも同じ値を使う。**
      const orgId = identity.organizations[0] ?? "";

      // `fromTargets` なら `capture_targets` から。以前の CLI 経路 (run.ts) が
      // 読んでいたのと同じ表で、絞り込みだけが変わる (組織で絞る)。
      const rawSeeds =
        fromTargets === undefined
          ? (body.seeds ?? [])
          : (
              await loadTargets(db, {
                orgId,
                ...(fromTargets.limit === undefined ? {} : { limit: fromTargets.limit }),
              })
            ).map((row) => row.url);

      // **1 本も無ければ拒む。** 対象が 0 件のときにここを通すと、`011` の CHECK に
      // 当たって 500 になる —— 呼ぶ側から見れば「壊れた」で、「対象が無い」ではない。
      if (rawSeeds.length === 0) {
        return reply.code(400).send({
          error:
            fromTargets === undefined
              ? "seeds must not be empty"
              : "no enabled capture targets for this organization",
        });
      }

      // 読めない種が 1 本でもあれば拒む。**黙って落とさない** ——
      // 落とすと、投げた側は全部辿ったつもりで結果を読むことになる。
      const seeds = rawSeeds.map((raw) => parseHttpUrl(raw));
      if (seeds.some((parsed) => parsed === undefined)) {
        return reply.code(400).send({ error: "every seed must be an http(s) URL" });
      }
      const parsedSeeds = seeds as ParsedUrl[];

      const crawlId = randomUUID();
      // **型注釈を付けること。** 注釈の無い変数に入れてから `.values()` へ渡すと
      // 余剰プロパティの検査が効かず、存在しない列名を書いても typecheck が緑で通る。
      const crawl: Insertable<CrawlsTable> = {
        id: crawlId,
        seeds: parsedSeeds.map((parsed) => parsed.normalized),
        scope: body.scope ?? DEFAULT_SCOPE,
        // **対象一覧から取るときは、既定で辿らない。** それが `runs` の意味だった。
        // 明示された値は勝つので、「一覧を種にして 2 段辿る」も書ける。
        maxDepth: body.maxDepth ?? (fromTargets === undefined ? DEFAULT_MAX_DEPTH : 0),
        // 既定の 30 だと対象一覧が切り落とされる。**種の数は下回らせない。**
        maxPages: body.maxPages ?? Math.max(DEFAULT_MAX_PAGES, parsedSeeds.length),
        perHostDelayMs: body.perHostDelayMs ?? DEFAULT_PER_HOST_DELAY_MS,
        hostParallelism: body.hostParallelism ?? DEFAULT_HOST_PARALLELISM,
        orgId,
        requestedBy: identity.subject,
        state: "running" as const,
        // **置く場所を、いま 1 度だけ決めて書き残す。** 以後は置く側 (受け口) も
        // 探す側 (`admitLevel`) もこの列を読む —— 両側が別々に計算すると、
        // 受け口の設定を切り替えた配備や月をまたぐクロールでずれる。
        // 受け口を使わない配備では書かない (NULL = 記録が無い)。
        ...(sink && { artifactKeyPrefix: crawlKeyPrefix(orgId, new Date()) }),
      };

      try {
        await db.insertInto("crawls").values(crawl).execute();
      } catch (err) {
        if (isUniqueViolation(err, "crawls_single_active")) {
          log.info({ subject: identity.subject }, "Crawl already in progress");
          // 塞いでいる 1 本を名指しする (走行中は全体で 1 本 —— `007` の部分 unique index)。
          // 止まっているなら、呼び手はこの id で `POST /api/crawls/:id/failed` を叩ける。
          // 呼び手は `can_submit` を通った後で、その許可は組織を跨いで効く (`maySubmit`) ので、
          // 他の組織のクロールの id を見せても新しく漏れるものは無い。
          const running = await db
            .selectFrom("crawls")
            .select(["id", "startedAt"])
            .where("state", "=", "running")
            .executeTakeFirst();
          return reply.code(409).send({
            error: "a crawl is already in progress",
            ...(running && { crawlId: running.id, startedAt: running.startedAt }),
          });
        }
        throw err;
      }

      // 種を最初の行として置く。深さ 0。ここから flow が読む。
      //
      // **深さ 1 以降と同じ形にしてある** —— 配列で入れ、`onConflict` で重複を
      // index に落とさせ、`returning` で実際に入った行だけを次に渡す。種が複数に
      // なると同じ URL が 2 度渡されうるので、ここも同じ守りが要る。
      const seeded = await db
        .insertInto("crawlPages")
        .values(
          parsedSeeds.map((parsed) => ({
            crawlId,
            url: parsed.normalized,
            depth: 0,
            host: parsed.host,
            state: "pending" as const,
          })),
        )
        .onConflict((oc) => oc.columns(["crawlId", "urlHash"]).doNothing())
        .returning(["url", "host"])
        .execute();

      dispatchLevel({
        crawlId,
        depth: 0,
        // 最初の段には「前」が無い。
        frontier: seeded.map((row) => ({ url: row.url, host: row.host, lastFinishedAt: null })),
        perHostDelayMs: crawl.perHostDelayMs,
        hostParallelism: crawl.hostParallelism,
        // 辿るつもりが無いなら `links` は要らない。取り出させても相手と S3 に無駄が出る。
        captureFormats: withLinks(capture.formats, crawl.maxDepth > 0),
        signing: capture.signing,
        ...(sink && { artifactSink: sinkForCrawl(sink, crawlId) }),
      });

      log.info({ subject: identity.subject, crawlId }, "Crawl started");
      return reply.code(202).send({ crawlId });
    },
  );

  /** クロール 1 本の状態。 */
  app.get<{ Params: { id: string } }>(
    "/api/crawls/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }

      const crawl = await db
        .selectFrom("crawls")
        .selectAll()
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      if (!crawl) return reply.code(404).send({ error: "not found" });

      // 取れなかったページと、その理由。0 ページで「成功」したクロールは、これが無いと
      // 理由が台帳の中に眠ったままになる (`skip_reason` には失敗の理由も入る)。
      const failures = await db
        .selectFrom("crawlPages")
        .select(["url", "depth", "skipReason"])
        .where("crawlId", "=", crawl.id)
        .where("state", "=", "failed")
        .orderBy("id", "desc")
        .limit(FAILURES_SHOWN)
        .execute();

      return reply.code(200).send({
        crawlId: crawl.id,
        seeds: crawl.seeds,
        scope: crawl.scope,
        state: crawl.state,
        stopReason: crawl.stopReason,
        maxDepth: crawl.maxDepth,
        maxPages: crawl.maxPages,
        perHostDelayMs: crawl.perHostDelayMs,
        hostParallelism: crawl.hostParallelism,
        startedAt: crawl.startedAt,
        finishedAt: crawl.finishedAt,
        pagesDiscovered: crawl.pagesDiscovered,
        pagesCaptured: crawl.pagesCaptured,
        error: crawl.error,
        lastJob:
          crawl.lastJobId === null ? null : { id: crawl.lastJobId, depth: crawl.lastJobDepth },
        failures: failures.map((page) => ({
          url: page.url,
          depth: page.depth,
          reason: page.skipReason,
        })),
      });
    },
  );

  /**
   * 1 段ぶんの報告を受け、次の段を返す。
   *
   * **この 1 往復に判断が全部入っている。** 報告を記録し、帰属を書き、見つけたリンクを
   * 範囲で絞り、重複を index に落とさせ、上限を当て、残ったものを返す。
   *
   * 重複排除を `ON CONFLICT DO NOTHING` + `returning` で行うのが肝 ——
   * 「入った行」がそのまま「次に取るもの」になるので、記録と決定がずれようがない。
   */
  app.post<{ Params: { id: string }; Body: LevelBody }>(
    "/api/crawls/:id/pages",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["depth", "results"],
          properties: {
            depth: { type: "integer", minimum: 0 },
            results: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["url", "status"],
                properties: {
                  url: { type: "string", minLength: 1 },
                  status: { type: "string", enum: ["captured", "failed", "skipped"] },
                  skipReason: { type: "string" },
                  taskId: { type: "string" },
                  correlationId: { type: "string" },
                  submittedAt: { type: "string", format: "date-time" },
                  finishedAt: { type: "string", format: "date-time" },
                  linksLocation: { type: "string" },
                  manifestLocation: { type: "string", minLength: 1 },
                  manifestError: { type: "string", minLength: 1 },
                },
                // taskId を持つ報告は manifest の結末をちょうど 1 つ持ち、結末は taskId 無しでは
                // 来ない。**運び忘れた flow をここで断る** —— 黙って受けると、その取り込みは
                // 読みに行く鍵を持たないまま台帳に残り、誰も拾わない。
                dependencies: {
                  taskId: {
                    oneOf: [{ required: ["manifestLocation"] }, { required: ["manifestError"] }],
                  },
                  manifestLocation: ["taskId"],
                  manifestError: ["taskId"],
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }

      const crawlId = request.params.id;
      const crawl = await db
        .selectFrom("crawls")
        .selectAll()
        .where("id", "=", crawlId)
        .executeTakeFirst();
      if (!crawl) return reply.code(404).send({ error: "not found" });

      const { depth, results } = request.body;
      // 種は投入時に検査しているので、読めない行はここに来ない。**それでも
      // 全部を読み直す** —— 範囲の判定に要るのは正規化した形で、行に入っているのは
      // 文字列だから。1 本でも読めなければ行が壊れている。
      const parsedSeeds: ParsedUrl[] = [];
      for (const raw of crawl.seeds) {
        const parsed = parseHttpUrl(raw);
        if (parsed === undefined) {
          return reply.code(500).send({ error: "a crawl seed is not a usable url" });
        }
        parsedSeeds.push(parsed);
      }

      // ── 1. 報告された行を閉じる ────────────────────────────────────────
      for (const page of results) {
        await db
          .updateTable("crawlPages")
          .set({
            state: page.status,
            skipReason: page.skipReason ?? null,
            taskId: page.taskId ?? null,
            correlationId: page.correlationId ?? null,
            submittedAt: page.submittedAt ?? null,
            finishedAt: page.finishedAt ?? null,
          })
          .where("crawlId", "=", crawlId)
          .where("url", "=", page.url)
          .execute();
      }

      // ── 2. 帰属を書く ────────────────────────────────────────────────
      // 投げたのが ledger でなくても、記録はここに残す。reconciler はこの行 (帰属と
      // manifest の鍵) だけを読む。
      //
      // **状態は問わない。`taskId` を持つ全件に書く。** 以前は `captured` だけに
      // 書いていたが、それだと失敗と報告された取り込みの帰属が残らない ——
      // 実体が S3 に在っても組織が言えず、台帳に入れようがない。
      // 投入が通っている限り id は在るので、書かない理由が無い。
      const submitted = results.filter(
        (r): r is PageReport & { taskId: string } =>
          typeof r.taskId === "string" && r.taskId !== "",
      );
      // 報告の場所を台帳の形に。**1 度だけ計算し、書き留める値と読みに行く鍵に同じものを使う。**
      const manifests = new Map(submitted.map((r) => [r.taskId, manifestOutcome(r, deps.bucket)]));
      let recovered: string[] = [];
      if (submitted.length > 0) {
        await db
          .insertInto("captureSubmissions")
          .values(
            // **戻り値の型を書く。** 無いと excess property 検査が効かず、`.map()` を
            // 通った object literal は**存在しない列を書いても typecheck が緑になる**
            // (`source_url` を落としたときに実測)。ledger に DB を使う試験は 1 本も
            // 無いので、schema とのずれを静的に捕まえるのはここだけ。
            submitted.map((r): Insertable<CaptureSubmissionsTable> => ({
              taskId: r.taskId,
              correlationId: r.correlationId ?? crawlId,
              orgId: crawl.orgId,
              submittedBy: crawl.requestedBy,
              // nullable な列は `Insertable` で省略できる —— 書き忘れても typecheck は緑。
              // 値は `test/routes-crawls-manifest.test.ts` が見ている。
              manifestKey: manifests.get(r.taskId)?.key ?? null,
              manifestError: manifests.get(r.taskId)?.error ?? null,
            })),
          )
          .onConflict((oc) => oc.column("taskId").doNothing())
          .execute();

        // ── 2b. 台帳に載せる ──────────────────────────────────────────
        // ここが無いと、クロールしたページは `reconcile` を走らせるまで存在しない。
        // 詳しくは `crawl/admit-level.ts`。
        //
        // **失敗の報告も渡す。** 報告は flow の言い分で、正本は BrowserHive が成果物の
        // 隣に書く manifest。`failed` と報告されたページに成功の manifest が在れば、
        // 取り込みは成功している。
        //
        // **読むのは報告が運んだ鍵。** 書けなかった取り込みには鍵が無く、admitLevel は
        // それを飛ばす。
        const admitted = await admitLevel(
          submitted.map((r) => ({
            taskId: r.taskId,
            url: r.url,
            manifestKey: manifests.get(r.taskId)?.key ?? null,
          })),
          {
            db,
            s3: deps.s3,
            bucket: deps.bucket,
            crawlId,
            orgId: crawl.orgId,
            requestedBy: crawl.requestedBy,
          },
        );

        // ── 2c. 拾えたものは記録を直す ──────────────────────────────────
        // **台帳には在るのにクロールの記録では失敗している、を残さない。**
        // どちらが正しいかを後から言えなくなる。manifest が成功を語っているなら
        // そちらが正 —— 報告のほうは「15 分では見えなかった」でしかない。
        const reportedFailed = new Set(
          results.filter((r) => r.status !== "captured").map((r) => r.url),
        );
        recovered = admitted.admittedUrls.filter((url) => reportedFailed.has(url));
        if (recovered.length > 0) {
          await db
            .updateTable("crawlPages")
            .set({ state: "captured", skipReason: null })
            .where("crawlId", "=", crawlId)
            .where("url", "in", recovered)
            .execute();
          log.info(
            { crawlId, depth, recovered: recovered.length },
            "recovered captures the flow could not see",
          );
        }
      }

      // ── 3. 見つけたリンクを読み、絞る ────────────────────────────────
      const links: DiscoveredLink[] = [];
      for (const page of results) {
        if (page.linksLocation === undefined || page.linksLocation === "") continue;
        // `s3://bucket/key` から鍵だけを取り出す。bucket はこちらの設定を使う ——
        // 報告に入っていた bucket を信じると、報告する側が読み先を選べることになる。
        const key = page.linksLocation.replace(/^s3:\/\/[^/]+\//, "");
        const raw = await getJsonObject(deps.s3, deps.bucket, key);
        if (raw === null || typeof raw !== "object") continue;
        const parsed = (raw as { links?: unknown }).links;
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as DiscoveredLink).href === "string"
          ) {
            links.push(item as DiscoveredLink);
          }
        }
      }

      const discovered = acceptLinks(links, parsedSeeds, crawl.scope);

      // ── 4. 上限を当てる ──────────────────────────────────────────────
      const nextDepth = depth + 1;
      const { count } = await db
        .selectFrom("crawlPages")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("crawlId", "=", crawlId)
        .executeTakeFirstOrThrow();

      const { toInsert, stopReason } = planNextLevel(discovered, {
        nextDepth,
        maxDepth: crawl.maxDepth,
        maxPages: crawl.maxPages,
        known: Number(count),
      });

      // ── 5. 重複を index に落とさせ、入った行だけを次の段にする ──────────
      const inserted =
        toInsert.length === 0
          ? []
          : await db
              .insertInto("crawlPages")
              .values(
                toInsert.map((link) => ({
                  crawlId,
                  url: link.url,
                  depth: nextDepth,
                  host: link.host,
                  state: "pending" as const,
                })),
              )
              .onConflict((oc) => oc.columns(["crawlId", "urlHash"]).doNothing())
              .returning(["url", "host"])
              .execute();

      // ── 6. 集計と、終わったなら締める ────────────────────────────────
      // **拾い直したぶんも数える。** 報告だけを数えると、台帳に入った件数と
      // `pages_captured` が食い違う。
      const capturedCount =
        results.filter((r) => r.status === "captured").length + recovered.length;
      const done = inserted.length === 0;

      // **最初に効いた理由を残す。上書きしない。**
      //
      // 段の途中で `max_pages` に当たって切っても、そのあと最後の段が `max_depth` で
      // 終われば、素朴に書くと後者で上書きされる。すると「深さの範囲は全部辿った」と
      // 読めてしまうが、実際には切り落としている —— 実測で踏んだ: 50 件見つけて 9 件
      // 入れたクロールが `max_depth` と記録された。
      //
      // `coalesce` で最初の非 NULL を守る。`budget.ts` が深さを件数より優先するのと
      // 同じ考え方で、**先に効いた制約**が理由になる。
      const reason = stopReason ?? (done ? ("completed" as const) : null);
      await db
        .updateTable("crawls")
        .set((eb) => ({
          pagesCaptured: eb("pagesCaptured", "+", capturedCount),
          pagesDiscovered: eb("pagesDiscovered", "+", discovered.length),
          ...(reason === null ? {} : { stopReason: eb.fn.coalesce("stopReason", eb.val(reason)) }),
          ...(done ? { state: "succeeded" as const, finishedAt: new Date().toISOString() } : {}),
        }))
        .where("id", "=", crawlId)
        .execute();

      log.info(
        { crawlId, depth, reported: results.length, next: inserted.length, stopReason },
        "Crawl level recorded",
      );

      // ── 7. 次の段があるなら、こちらから投げる ────────────────────────
      // flow は 1 段を処理して報告するだけ。繰り返しをここに置いたのは、上限の判定
      // (`budget.ts`) と同じ場所に置くため —— そして Windmill の while ループが
      // 止まらなかったため (`DispatchedCrawl` の注記を見ること)。
      if (!done) {
        // ホストごとの「最後に触り終えた時刻」を引く。段をまたぐ間隔のために要る。
        const lastByHost = new Map<string, string>();
        const seen = await db
          .selectFrom("crawlPages")
          .select((eb) => ["host", eb.fn.max("finishedAt").as("last")])
          .where("crawlId", "=", crawlId)
          .where("finishedAt", "is not", null)
          .groupBy("host")
          .execute();
        for (const row of seen) {
          if (row.last !== null) lastByHost.set(row.host, new Date(row.last).toISOString());
        }

        dispatchLevel({
          crawlId,
          depth: nextDepth,
          frontier: inserted.map((row) => ({
            url: row.url,
            host: row.host,
            lastFinishedAt: lastByHost.get(row.host) ?? null,
          })),
          perHostDelayMs: crawl.perHostDelayMs,
          hostParallelism: crawl.hostParallelism,
          captureFormats: withLinks(capture.formats, crawl.maxDepth > nextDepth),
          signing: capture.signing,
          ...(sink && { artifactSink: sinkForCrawl(sink, crawlId) }),
        });
      }

      return reply.code(200).send({
        next: inserted.map((row) => ({ url: row.url, host: row.host, depth: nextDepth })),
        stopReason: done ? (stopReason ?? "completed") : null,
      });
    },
  );

  /**
   * 段が落ちたことを受け取り、クロールを締める。
   *
   * ## なぜ要るのか
   *
   * flow が段の途中で落ちると `POST /pages` に辿り着かないので、**ledger は何も
   * 知らされない**。行は `running` のまま残り、部分 unique index が以後のクロールを
   * 全部塞ぐ。実測で踏んだ: BrowserHive を止めてクロールを起こすと、`crawl_host` が
   * `UNAVAILABLE` で落ちて flow ごと失敗し、行は永久に走行中になった。
   *
   * 以前 (`runs`) は同じ状況で「全ページ失敗の**成功した**実行」になっていた ——
   * 静かに間違うよりは止まるほうがよいが、止まったまま塞ぐのも同じくらい困る。
   * flow に締めさせる。
   *
   * ## 走行中のものしか締めない
   *
   * 終わった行に後から `failed` を被せない。段の失敗が遅れて届くことはありうるし、
   * そのとき既に別の段が締めていれば、**そちらの理由のほうが正しい**。
   *
   * ## 落ちた段の取り込みは台帳に入らない
   *
   * 落ちた段でも、そこまでに成功した取り込みの成果物は S3 に在る。けれど報告が来ないので
   * `crawl_pages` は `pending` のまま、`capture_submissions` も書かれない —— 帰属も
   * manifest の鍵も分からないので、`reconcile` もそれを台帳に入れられない。bucket を
   * 一覧していた頃も同じで、見つけても帰属が無く `unattributed` と数えるだけだった。
   * **成果物は残るが、台帳とクロールの記録からは欠ける。**
   */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/crawls/:id/failed",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: "string", maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }

      const crawlId = request.params.id;
      const closed = await db
        .updateTable("crawls")
        .set({
          state: "failed",
          stopReason: "failed",
          finishedAt: new Date().toISOString(),
          error: request.body?.reason ?? "the flow failed without saying why",
        })
        .where("id", "=", crawlId)
        // **走行中のものだけ。** 終わった行に後から被せない。
        .where("state", "=", "running")
        .returning("id")
        .execute();

      if (closed.length === 0) {
        // 既に終わっているか、そもそも無い。どちらでも「締めるものが無い」で同じ。
        log.info({ crawlId }, "Nothing to close");
        return reply.code(200).send({ closed: false });
      }
      log.warn({ crawlId, reason: request.body?.reason }, "Crawl closed by the flow");
      return reply.code(200).send({ closed: true });
    },
  );
};
