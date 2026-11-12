/**
 * リンクを辿る取り込みを、外から始めるためのエンドポイント。
 *
 * 実行そのものは Windmill の flow が回し、BrowserHive を直接呼ぶ。ここに残るのは
 * **認可・方針・記録** の 3 つ —— つまり「誰が始めてよいか」「どこまで辿るか」
 * 「何が起きたか」。走らせる段取りは持たない。
 *
 * ## なぜ判断がここに集まるのか
 *
 * 規則でリンクを分けるのも重複排除も上限の判定も、**flow ではなくこちら**で行う。方針
 * (規則の並び) は `crawls` の行に在り、重複排除は `crawl_pages` の unique index が持っているので、
 * 判断材料が両方ここに在る。flow 側に写すと、2 つの場所が食い違ったときにどちらが
 * 正しいのか言えなくなる。規則が決めたことも、決めたここで `crawl_decisions` に残す。
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
 * 取り込みは、ここに行が無いので capture-ledger に入らない**。
 */
import type { FastifyInstance } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";
import { sql } from "kysely";
import type { Insertable, Kysely, Selectable } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import type {
  CaptureSubmissionsTable,
  CrawlPageState,
  CrawlRule,
  CrawlRuleAction,
  CrawlSecret,
  CrawlsTable,
  CrawlState,
  CrawlStopReason,
  CrawlLevelState,
  Database,
  LevelAnswer,
  LogCounts,
} from "../db/database.js";
import { readHostTypes, INLINE_PREFIX, isInlineId } from "../scripts/store.js";
import type { IdentityResolver } from "./identity.js";
import { admitLevel } from "../crawl/admit-level.js";
import { randomUUID } from "node:crypto";
import {
  insertLevel,
  launchCrawl,
  levelDispatcher,
  secretsForFlow,
  toDispatched,
  type CrawlDispatcher,
  type DispatchedCrawl,
  type LevelDispatcher,
  type ReplayBundleWriter,
} from "../crawl/launch.js";
import {
  CRAWL_BODY_LIMIT,
  CRAWL_BODY_SCHEMA,
  prepareCrawl,
  RULE_PATTERN_MAX,
  RULES_MAX,
  type CrawlBody,
} from "../crawl/prepare.js";
import {
  LEVEL_REPORT_LEASE_MS,
  MISSING_LEVEL_KEY,
  Superseded,
  writeTotals,
} from "../crawl/levels.js";
import {
  findRequest,
  forgetOldRequests,
  KEY_REUSED,
  MISSING_KEY,
  REQUEST_KEY_HEADER,
  requestDigest,
  requestKeyOf,
  type RememberedRequest,
  type RequestKey,
} from "../crawl/request-key.js";
import { nothingCapturedError } from "../crawl/close.js";
import { pagesFailed } from "../crawl/page-counts.js";
import { mergeCompiled, type CompiledReport } from "../crawl/compiled.js";
import { WindmillUnreachable, type WindmillVariables } from "../crawl/windmill-variables.js";
import {
  attributeDiagnostics,
  TsCompileUnreachable,
  type TsCompile,
} from "../scripts/ts-compile.js";
import type { Claude } from "../claude/types.js";
import { FIX_EFFORT, FIX_PROMPT_VERSION, fixInline, type FixResult } from "../scripts/fix.js";
import type { DerivationStore } from "../derivations/store.js";
import { HOSTNAME, parseHttpUrl, siteOf, type ParsedUrl } from "../crawl/scope.js";
import {
  acceptLinks,
  checkRules,
  compileRules,
  decidedOf,
  ruleOf,
  ruleParts,
  type DecidedLink,
  type PageLink,
} from "../crawl/rules.js";
import { aggregateDecisions, SAMPLES } from "../crawl/decisions.js";
import { planNextLevel } from "../crawl/budget.js";
import { cutOf, linkRows } from "../crawl/link-outcomes.js";
import { pageParents, replaceLinks } from "../crawl/links-store.js";
import { readPageLinks } from "../crawl/links-source.js";
import { readLinkGraph, readPageLinksOf } from "../crawl/links-read.js";
import { getJsonObject } from "../archive/s3.js";
import { manifestOutcome, readManifest } from "../archive/manifest.js";
import { maySubmit, unauthorized } from "./authorization.js";
import type { CaptureSettings } from "../config/capture-formats.js";
import { createChildLogger } from "../logger.js";
import { sinkForCrawl, type SinkConfig } from "./sink.js";

export type { CrawlDispatcher, DispatchedCrawl, ReplayBundleWriter } from "../crawl/launch.js";
export { CRAWL_BODY_LIMIT } from "../crawl/prepare.js";

const log = createChildLogger({ module: "api" });

const FAILURES_SHOWN = 5;
/** `GET /api/crawls/:id/pages` の 1 回の既定の行数と上限。続きは答えの `next` で引く。 */
const PAGES_DEFAULT = 100;
const PAGES_MAX = 500;
/**
 * ページの id (`crawl_pages.id`・bigserial) の綴り。**数字だけの文字列で、18 桁まで。** int では受けない ——
 * JSON の数は 2^53 を超えると丸まる。桁を縛るのは、bigint の上限 (19 桁) を超える値を SQL に渡すと
 * Postgres が「範囲の外」で断り、400 ではなく 500 になるから。
 */
const PAGE_ID = "^[0-9]{1,18}$";
/** 一覧の 1 ページ。`GET /api/archives` と同じ大きさに揃えてある。 */
const CRAWLS_PAGE = 50;
/** `GET /api/decisions` が返す行の上限。超えたら `truncated` で言う (`com` のような広いドメインのため)。 */
const DECISIONS_SHOWN = 500;
/**
 * そのクロールから出た WACZ の数。
 *
 * **繋ぐのは `crawl_pages` の `task_id`。** `archives.crawl_id` (`027`) は 027 より前の行で空なので、ここでは
 * 使わない —— 使うと、前からあるクロールの数が 0 に化ける (`008` と `013`)。
 *
 * **cast が 2 つとも要る。**
 *
 *   - `a.task_id::text` —— `archives.task_id` は uuid、`crawl_pages.task_id` は text。
 *     素で繋ぐと `operator does not exist: text = uuid` で落ちる (実測)。**uuid 側を
 *     text に倒す**のは意図的で、逆向き (`p.task_id::uuid`) は uuid の形でない値が
 *     1 行でも入った日に一覧ごと 500 になる。この repo に DB 試験は無いので、
 *     その日は本番で分かることになる。
 *   - `count(*)::int` —— `count` は int8 で、node-pg は精度を落とさないために
 *     **文字列で返す**。そのまま載せると JSON に `"3"` が出る。
 */
const waczCount = sql<number>`(
  select count(*)::int from archives a
  join crawl_pages p on a.task_id::text = p.task_id
  where p.crawl_id = crawls.id
)`;

/**
 * 一番新しい段を Windmill に投げた様子 (CAPTURE-180・`038`)。workbench が「段 N を Windmill に送り直し M 回」と
 * 最後の誤りを出す。`attempts` は送った回数 (受け取られた 1 回を含む)。段の行の無いクロール (段の行を入れる前に
 * 始めた物) は null。
 */
export interface DispatchSummary {
  depth: number;
  state: CrawlLevelState;
  attempts: number;
  lastError: string | null;
}
const dispatchOf = sql<DispatchSummary | null>`(
  select json_build_object('depth', l.depth, 'state', l.state, 'attempts', l.attempts, 'lastError', l.last_error)
  from crawl_levels l where l.crawl_id = crawls.id order by l.depth desc limit 1
)`;

/** その回の予定の名前。消した予定の行も残っているので、消した後も名前を言える (`032`)。 */
const scheduleName = sql<string | null>`(
  select s.name from crawl_schedules s where s.id = crawls.schedule_id
)`;

/** 定期の回の欄。手で始めたクロールは `schedule` が null。 */
const scheduleOf = (crawl: {
  scheduleId: string | null;
  scheduleName: string | null;
  scheduledFor: Date | null;
  scheduleMissed: number;
}) => ({
  schedule:
    crawl.scheduleId === null ? null : { id: crawl.scheduleId, name: crawl.scheduleName ?? "" },
  scheduledFor: crawl.scheduledFor,
  scheduleMissed: crawl.scheduleMissed,
});

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
  /** 受け取り先の設定。無ければ送り先を配らない。 */
  sink?: SinkConfig;
  dispatch: CrawlDispatcher;
  /** 投げる係 (`crawl/launch.ts`)。配備では `server.ts` が 1 つ作って分け合う。無ければ `dispatch` から作る */
  levels?: Pick<LevelDispatcher, "bundleAfterClose" | "dispatchLevel">;
  /** その場の送り直しの間 (ms)。`levels` を渡さないとき (試験) だけ効く */
  dispatchRetryDelaysMs?: readonly number[];
  /**
   * Windmill の変数に在るかを訊くクライアント (`crawl/windmill-variables.ts`)。webhook と同じ設定から作るので、
   * 無いのは URL が flow の webhook の形でないときだけ —— そのとき、シークレットを宣言したスクリプトの
   * クロールは 400 で止まる (値を解く flow が無いので)。
   */
  windmill?: WindmillVariables;
  /**
   * 型の検査のクライアント (`scripts/ts-compile.ts`)。flow の compile の段と同じ ts-compile-service を、host の
   * loopback で呼ぶ。**必須** —— 始めるエンドポイントが、必須の変数が渡されているかをここに訊く。
   */
  tsCompile: TsCompile;
  /**
   * Claude のクライアント (`claude/client.ts`。直す係 `scripts/fix.ts` が使う)。鍵が無ければ無い。`tsCompile` と `derivations` も揃ったときだけ
   * `POST /api/crawls/:id/inline/:name/fix` を出す (案は型の検査に通してから返し、費用は派生の層に残すため)。
   */
  claude?: Claude;
  /** 派生の層 (`026`) の store。月の上限を数え、Claude を呼んだ回を残す。 */
  derivations?: DerivationStore;
  /** 組織ごとの月の上限 (USD)。 */
  claudeBudgetUsd?: number;
  /**
   * 締めた後に合本を書く係。**締めた後は誰も合本を書かない** —— 段の合本は flow が段の報告の後に叩くが、締めるのは
   * flow が落ちた後 (`/failed`) か次の段を投げられなかった後で、どちらの後にも段は来ない。ここで書かないと、
   * クロールの最後の合本は走っている時の (署名の無い) 物のまま残る (CAPTURE-61)。
   */
  writeReplayBundle: ReplayBundleWriter;
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
   * `.result.json` を書けた場所 (`s3://bucket/key`)。BrowserHive (または受け取り先) の答えのまま。
   * **capture-ledger はこれを組み直さない。**
   */
  manifestLocation?: string;
  /** 書けなかった理由。`taskId` を持つ報告は、この 2 つのどちらか一方を必ず持つ。 */
  manifestError?: string;
}

interface LevelBody {
  depth: number;
  results: PageReport[];
  /** 走った JS の sha256 と、何で・何に向けて変換したか。**必ず載せる** (`crawl/compiled.ts`)。 */
  compiled: CompiledReport;
}

/**
 * `GET /api/crawls/:id` が返すシークレットの形。名前順の列で、値は無い。`archive` は宣言の写しで、`"keep"` なら
 * 値を WARC に残し、`null` なら BrowserHive が隠す (v29.0.0 から)。
 */
const secretsOf = (
  secrets: Readonly<Record<string, CrawlSecret>>,
): {
  name: string;
  path: string;
  editedAt: string | null;
  rotated: CrawlSecret["rotated"];
  archive: "keep" | null;
}[] =>
  Object.entries(secrets)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, secret]) => ({
      name,
      path: secret.path,
      editedAt: secret.editedAt,
      rotated: secret.rotated,
      archive: secret.archive ?? null,
    }));

/**
 * クロール 1 本のページの行と、その取り込みの WACZ の id・撮った時刻・WACZ が最初に入った合本の版。ページの一覧と
 * 1 ページのログのエンドポイントが、同じ形を返すため。
 *
 * **繋ぐのは `task_id`** (`archives.crawl_id` は 027 より前の行で空。`waczCount` と同じ)。uuid 側を text に倒す
 * (`waczCount` と同じ理由 —— 素で繋ぐと `operator does not exist`、逆向きは uuid の形でない値が 1 行でもあると
 * 問い合わせごと落ちる)。
 * 1 つの取り込みの WACZ は 1 本なので行は増えないはずだが、`distinct on` で 1 ページ 1 行に縛る —— 増えれば
 * 一覧の `limit` と `next` がずれる。並びはページの id の昇順 (`crawl_pages` に入った順)。
 */
const pageRows = (db: Kysely<Database>, crawlId: string) =>
  db
    .selectFrom("crawlPages as p")
    .leftJoin("archives as a", (join) =>
      join.onRef("p.taskId", "=", sql<string>`${sql.ref("a.taskId")}::text`),
    )
    .select([
      "p.id",
      "p.url",
      "p.depth",
      "p.state",
      "p.skipReason",
      "p.taskId",
      "p.logCounts",
      "a.id as archiveId",
      "a.capturedAt",
      "a.replayBundleRev as bundledRev",
    ])
    .where("p.crawlId", "=", crawlId)
    .distinctOn("p.id")
    .orderBy("p.id")
    .orderBy("a.createdAt");

interface PageRow {
  id: string;
  url: string;
  depth: number;
  state: CrawlPageState;
  skipReason: string | null;
  taskId: string | null;
  logCounts: LogCounts | null;
  archiveId: string | null;
  capturedAt: Date | null;
  bundledRev: number | null;
}

/**
 * ページ 1 つの答えの形。`state` は行のまま (読み手は字として出すだけ)、`reason` は `skip_reason` ——
 * 取らなかった理由も、取れなかった理由も入る。`logCounts` の null は「この行の取り込みの `.result.json` から
 * 数を読んでいない」(`025`)。
 *
 * `capturedAt` と `bundledRev` は WACZ の物 (無ければ null)。`bundledRev` はその WACZ が最初に入った合本の版で、
 * `bundledRev ≤ replayBundle.rev` なら、そのページは capture-ledger が指す合本の中で開ける (workbench が replay の
 * `#view=replay&url=…&ts=…` を組むのに使う)。
 */
const pageOf = (row: PageRow) => ({
  id: row.id,
  url: row.url,
  depth: row.depth,
  state: row.state,
  reason: row.skipReason,
  taskId: row.taskId,
  archiveId: row.archiveId,
  capturedAt: row.capturedAt,
  bundledRev: row.bundledRev,
  logCounts: row.logCounts,
});

/**
 * クロールの行の合本の欄 (`027`・`028`)。**書けた合本も、書けなかった記録も無ければ null。**
 *
 * 1 度も書けずに失敗だけがあるときは、`error` だけが値を持つ (`key`・`rev`・`pages`・`builtAt` は null)。
 * 書けた後に失敗したときは、capture-ledger が指す (前に書けた) 合本と、その後の失敗の理由が両方出る。
 *
 * 署名 (`028`): `signedRev`・`digestKey` は署名した版のうち最も大きい物と、その `replay-digest.json` の鍵で、
 * **指す版 (`rev`) とは別に動く** —— `signedRev === rev` なら、capture-ledger が指す合本は署名されている。`signError` は
 * 指す版に署名しなかった (できなかった) 理由 (走っているクロールの版と、署名の設定が無い配備では null)。
 */
const replayBundleOf = (
  crawl: Pick<
    Selectable<CrawlsTable>,
    | "replayBundleKey"
    | "replayBundleRev"
    | "replayBundlePages"
    | "replayBundleBuiltAt"
    | "replayBundleError"
    | "replayBundleSignedRev"
    | "replayBundleDigestKey"
    | "replayBundleSignError"
  >,
) =>
  crawl.replayBundleRev === null && crawl.replayBundleError === null
    ? null
    : {
        key: crawl.replayBundleKey,
        rev: crawl.replayBundleRev,
        pages: crawl.replayBundlePages,
        builtAt: crawl.replayBundleBuiltAt,
        error: crawl.replayBundleError,
        signedRev: crawl.replayBundleSignedRev,
        digestKey: crawl.replayBundleDigestKey,
        signError: crawl.replayBundleSignError,
      };

/**
 * 1 ページのログを読めなかった理由。どれも 200 で答える —— ページは在り、読めないことが答え。
 *
 * - `not-captured` 取り込みの答えが無い (`task_id` が無い: pending・skipped・flow が切った・断られた)
 * - `no-manifest` 答えはあるが、`.result.json` の場所が記録されていない (書けなかった・capture-ledger に読めない場所)
 * - `manifest-missing` 保管庫の、記録した場所に `.result.json` が無い
 * - `manifest-invalid` `.result.json` が契約に合わない (JSON でない・`readManifest` が断った)
 * - `no-log` `.result.json` に `log` が無い (BrowserHive v24.0.0 より前の取り込み)
 */
type LogUnreadable =
  "not-captured" | "no-manifest" | "manifest-missing" | "manifest-invalid" | "no-log";

export const registerCrawlRoutes = (app: FastifyInstance, deps: CrawlRouteDeps): void => {
  const { db, fga, resolveIdentity, dispatch, capture, sink, tsCompile, claude, derivations } =
    deps;
  // **投げる係は 1 つ** (CAPTURE-180)。配備では `server.ts` が作り、定期実行の周回と投げる係の時計と分け合う。
  // 渡されなければ (試験) ここで作る
  const { bundleAfterClose, dispatchLevel } =
    deps.levels ??
    levelDispatcher({
      db,
      dispatch,
      writeReplayBundle: deps.writeReplayBundle,
      ...(sink && { sink }),
      ...(deps.dispatchRetryDelaysMs && { retryDelaysMs: deps.dispatchRetryDelaysMs }),
    });

  /**
   * 次の段を送る前に、シークレットの更新時刻を読み直す。**続ける** —— 段の先で解くのは新しい値で、
   * 止める理由は無い。ただし気づいた段と新しい時刻を行に残す (`rotated`)。もう 1 度替われば書き換える。
   * 比べる相手は最後に知った時刻 (始めたときか、前に気づいた物) なので、同じ替わりを段ごとに書き直さない。
   *
   * 訊けなければそのまま送る。flow が解けなければ `fail_crawl` が締めるので、ここで止めない。
   * 消えた変数も書かない (同じ理由で flow が落とす)。
   */
  const noteRotations = async (
    crawlId: string,
    secrets: Readonly<Record<string, CrawlSecret>>,
    depth: number,
  ): Promise<Record<string, CrawlSecret>> => {
    const windmill = deps.windmill;
    const entries = Object.entries(secrets);
    if (windmill === undefined || entries.length === 0) return { ...secrets };
    const next: Record<string, CrawlSecret> = { ...secrets };
    let changed = false;
    try {
      for (const [name, current] of entries) {
        const meta = await windmill.meta(current.path);
        if (meta === undefined) continue;
        const known = current.rotated === null ? current.editedAt : current.rotated.editedAt;
        if (meta.editedAt === known) continue;
        next[name] = { ...current, rotated: { depth, editedAt: meta.editedAt } };
        changed = true;
        log.warn(
          { crawlId, depth, name, editedAt: meta.editedAt },
          "A secret changed while the crawl was running",
        );
      }
    } catch (err) {
      if (!(err instanceof WindmillUnreachable)) throw err;
      log.warn({ err, crawlId, depth }, "Could not re-read the secrets; sending the level anyway");
      return { ...secrets };
    }
    if (changed) {
      await db
        .updateTable("crawls")
        .set({ secrets: JSON.stringify(next) })
        .where("id", "=", crawlId)
        .execute();
    }
    return next;
  };

  /**
   * クロールを 1 本始める。
   *
   * 完了は待たない —— 段を重ねるので、待てる呼び出し元が居ない。受理したことだけを
   * 202 で返し、続きは `crawls` の行が語る。
   */
  app.post<{ Body: CrawlBody | undefined }>(
    "/api/crawls",
    {
      bodyLimit: CRAWL_BODY_LIMIT,
      schema: {
        body: CRAWL_BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);

      if (!(await maySubmit(fga, identity))) {
        log.info({ subject: identity.subject }, "Denied");
        return reply.code(404).send({ error: "not found" });
      }

      // 組織は呼び出し元の 1 つ目。`maySubmit` はどれか 1 つで許されていれば通すので、
      // 許しをくれた組織とは限らない。
      const who = { orgId: identity.organizations[0] ?? "", subject: identity.subject };

      // **鍵は名乗りの後に見る** (CAPTURE-180)。schema の headers に置くと名乗る前に 400 になり、
      // 名乗らずに叩いて 401 を見る点検 (capture-scheduler の doctor の crawl route) が崩れる。
      const key = requestKeyOf(request.headers[REQUEST_KEY_HEADER]);
      if (key === undefined) return reply.code(400).send(MISSING_KEY);
      const asked: RequestKey = { key, sha256: requestDigest(request.body ?? {}) };
      await forgetOldRequests(db);
      const answerRemembered = (remembered: RememberedRequest) => {
        if (remembered.requestSha256 !== asked.sha256) return reply.code(422).send(KEY_REUSED);
        log.info(
          { subject: identity.subject, crawlId: remembered.answer.crawlId },
          "Crawl start repeated with the same Idempotency-Key",
        );
        return reply.code(202).send(remembered.answer);
      };
      const remembered = await findRequest(db, who.orgId, key);
      if (remembered) return answerRemembered(remembered);

      const prepared = await prepareCrawl(
        {
          db,
          tsCompile,
          formats: capture.formats,
          ...(deps.windmill && { windmill: deps.windmill }),
        },
        request.body ?? {},
        who,
      );
      if (prepared.kind === "refused") return reply.code(prepared.status).send(prepared.body);

      const launched = await launchCrawl(
        { db, capture, ...(sink && { sink }), dispatchLevel },
        prepared,
        who,
        asked,
      );
      if (launched.kind === "remembered") return answerRemembered(launched.request);
      if (launched.kind === "busy") {
        log.info({ subject: identity.subject }, "Crawl already in progress");
        return reply.code(409).send(launched.body);
      }

      log.info(
        {
          subject: identity.subject,
          crawlId: launched.crawlId,
          // **何を走らせるかは、始めたときにしか見えない。** 版まで出す ——
          // id だけだと、後から登録済みのスクリプトを書き換えたときに「何が走ったのか」を
          // このログから言えなくなる。
          scripts: prepared.scripts.map((script) => `${script.id}@${String(script.version)}`),
          // 値は出さない。変数は行と WACZ に在り、シークレットの値は capture-ledger を通らない
          variables: Object.keys(prepared.variables),
          secrets: Object.keys(prepared.secrets),
        },
        "Crawl started",
      );
      return reply.code(202).send({ crawlId: launched.crawlId });
    },
  );

  /**
   * クロールの一覧。**workbench のためではなく資源として返す** —— 並べ方も、どの列を
   * 見せるかも、呼ぶ側が決める。doctor も smoke も CLI も同じエンドポイントを使える。
   *
   * ## 絞りは `:id` と同じ `maySubmit`
   *
   * `can_submit` は「取り込みを始めてよい者」で (`fga/model.fga` の `submitter`)、どれか 1 つの
   * 組織で許されていれば通す (`maySubmit`) ので、**組織を跨ぐ信頼**になる。読みだけを狭める規則は
   * 増やさない —— 始められるのに見えない、という食い違いのほうが説明しにくい。
   *
   * 代わりに `orgId` を必ず行に出す。**見えている範囲を、workbench が言えるようにするため。**
   * 組織ごとに絞る必要が出たら、そのときは `crawl` 型を認可モデルに足して
   * `archives` と同じ `batchCheck` で絞ることになる (モデルの変更なので、
   * `fga:deploy` と assertion が一緒に動く)。
   *
   * 権限が無いときは 403 ではなく**空**を返す。`/api/archives` と同じ作法で、
   * 「在るが見せない」と「無い」を呼び出し元に区別させない。
   */
  app.get<{ Querystring: { state?: CrawlState; before?: string } }>(
    "/api/crawls",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["running", "succeeded", "failed"] },
            // カーソルは「いま出した最後の行の startedAt」。`/api/archives` と同じ
            // 綴りにしてある。形式が違えば 400 —— `new Date()` は不正な文字列でも
            // 投げず Invalid Date を返すので、ここで落とさないと SQL のパラメータに
            // なり、Postgres が拒んで 500 になる。
            before: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) return reply.code(200).send({ crawls: [] });

      const { state, before } = request.query;
      let query = db
        .selectFrom("crawls")
        .select([
          "id",
          "state",
          "stopReason",
          "seeds",
          "requestedBy",
          "orgId",
          "startedAt",
          "finishedAt",
          "maxDepth",
          "pagesDiscovered",
          "linksRecordedAt",
          "pagesCaptured",
          "error",
          "lastJobId",
          "lastJobDepth",
          "replayBundleKey",
          "replayBundleRev",
          "replayBundlePages",
          "replayBundleBuiltAt",
          "replayBundleError",
          "replayBundleSignedRev",
          "replayBundleDigestKey",
          "replayBundleSignError",
          waczCount.as("waczCount"),
          pagesFailed.as("pagesFailed"),
          "scheduleId",
          scheduleName.as("scheduleName"),
          "scheduledFor",
          "scheduleMissed",
          dispatchOf.as("dispatch"),
        ])
        .orderBy("startedAt", "desc")
        .limit(CRAWLS_PAGE);
      if (state !== undefined) query = query.where("state", "=", state);
      if (before !== undefined) query = query.where("startedAt", "<", new Date(before));

      const rows = await query.execute();
      return reply.code(200).send({
        crawls: rows.map((crawl) => ({
          crawlId: crawl.id,
          state: crawl.state,
          // **state だけでは足りない。** `succeeded` は「1 枚以上撮れた」なので、切った物があるクロール
          // (`max_depth`・`max_pages`) と全部辿ったクロール (`completed`) の区別が付かない。呼ぶ側が両方を受け取れるようにする。
          stopReason: crawl.stopReason,
          seeds: crawl.seeds,
          requestedBy: crawl.requestedBy,
          orgId: crawl.orgId,
          startedAt: crawl.startedAt,
          finishedAt: crawl.finishedAt,
          // 深さ 0 (辿らないクロール) かどうか。workbench が「このページだけ」と言うのに要る
          maxDepth: crawl.maxDepth,
          // リンクの記録 (`039`) が在れば、規則が通した別々の URL の数 (起点を除く)。無ければ、段ごとに足した延べ
          pagesDiscovered: crawl.pagesDiscovered,
          linksRecorded: crawl.linksRecordedAt !== null,
          pagesCaptured: crawl.pagesCaptured,
          pagesFailed: crawl.pagesFailed,
          error: crawl.error,
          waczCount: crawl.waczCount,
          lastJob:
            crawl.lastJobId === null ? null : { id: crawl.lastJobId, depth: crawl.lastJobDepth },
          dispatch: crawl.dispatch,
          // 合本 (`027`)。workbench は走っているクロールを 2 秒ごとに引くので、欄は行の列から (保管庫を読まない)
          replayBundle: replayBundleOf(crawl),
          ...scheduleOf(crawl),
        })),
      });
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
        .select([scheduleName.as("scheduleName"), dispatchOf.as("dispatch")])
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      if (!crawl) return reply.code(404).send({ error: "not found" });

      // 取れなかったページと、その理由 (`skip_reason` には失敗の理由も入る)。
      // ページの id も返す —— 理由の先 (そのページの取り込みのログ) へ、`/pages/:page/log` で辿れるように。
      // 窓関数は limit の前に数えるので、`total` は 5 件に切る前の全体の数
      const failures = await db
        .selectFrom("crawlPages")
        .select([
          "id",
          "url",
          "depth",
          "skipReason",
          sql<number>`(count(*) over ())::int`.as("total"),
        ])
        .where("crawlId", "=", crawl.id)
        .where("state", "=", "failed")
        .orderBy("id", "desc")
        .limit(FAILURES_SHOWN)
        .execute();

      return reply.code(200).send({
        crawlId: crawl.id,
        seeds: crawl.seeds,
        // 固定した規則。`GET /api/crawls/:id/decisions` の `rule` の番号はこの並びの 1 から
        rules: crawl.rules,
        state: crawl.state,
        stopReason: crawl.stopReason,
        maxDepth: crawl.maxDepth,
        maxPages: crawl.maxPages,
        perHostDelayMs: crawl.perHostDelayMs,
        hostParallelism: crawl.hostParallelism,
        startedAt: crawl.startedAt,
        finishedAt: crawl.finishedAt,
        pagesDiscovered: crawl.pagesDiscovered,
        linksRecorded: crawl.linksRecordedAt !== null,
        pagesCaptured: crawl.pagesCaptured,
        pagesFailed: failures[0]?.total ?? 0,
        error: crawl.error,
        // **登録済みのスクリプトは身元だけ出す。** 何が走っているかを知るのに要るのは「どれの何版か」で、
        // 中身はスクリプトの 1 版のエンドポイント (`GET /api/scripts/:id/versions/:version`)・`pnpm run scripts show`・
        // archive に在る。**その場の TS には頼まれた
        // 要素 (`inline`) を返すが、source は載せない** —— 走行中の行は workbench が 2 秒ごとに引き直すので、
        // 1 MiB の TS なら 2 秒に 1 MiB を運ぶことになる。書いた物を取り戻すのは「欄に戻す」の
        // ときだけで、`GET /api/crawls/:id/inline/:name` から取る。
        // `jsSha256` と `compiledWith` は最初の段の報告で埋まる。それまでは null。
        scripts: crawl.scripts.map((script) => ({
          id: script.id,
          version: script.version,
          phase: script.phase,
          sha256: script.sha256,
          // 対象サイト (`021`)。その場の TS と、対象サイトより前に始めたクロールの行は空
          sites: script.sites ?? [],
          jsSha256: script.jsSha256 ?? null,
          compiledWith: script.compiledWith ?? null,
          ...(isInlineId(script.id) && {
            inline: {
              name: script.id.slice(INLINE_PREFIX.length),
              phase: script.phase,
              bytes: Buffer.byteLength(script.source, "utf8"),
            },
          }),
        })),
        lastJob:
          crawl.lastJobId === null ? null : { id: crawl.lastJobId, depth: crawl.lastJobDepth },
        // 一番新しい段を Windmill に投げた様子 (CAPTURE-180)。一覧と同じ形
        dispatch: crawl.dispatch,
        // capture-ledger が指す合本と、書けなかった理由 (`027`)。一覧と同じ形
        replayBundle: replayBundleOf(crawl),
        ...scheduleOf(crawl),
        failures: failures.map((page) => ({
          page: page.id,
          url: page.url,
          depth: page.depth,
          reason: page.skipReason,
        })),
        // クロールごとの値。変数は値ごと (WACZ の settings.variables にも残る)。シークレットは名前・path・
        // 始めたときの更新時刻と、途中で替わったなら気づいた段と新しい時刻と、WARC に残すか (archive)。値は無い
        variables: crawl.variables,
        secrets: secretsOf(crawl.secrets),
        // 打った字のまま。指定なしは null。解いた字は WACZ の settings.userAgent に在る
        userAgent: crawl.userAgent,
      });
    },
  );

  /**
   * その場の TS 1 本の source。**「欄に戻す」のためのエンドポイント** ——直して撮り直すときに、書いた物を
   * 取り戻せるのはここだけ（archive に在るのは変換後の JS）。登録済みのスクリプトは capture-ledger と archive に在るので
   * 返さない（404）。名前の綴りは`POST /api/crawls` の本文と同じ schema で、合わなければ許可を見る前に 400。
   */
  app.get<{ Params: { id: string; name: string } }>(
    "/api/crawls/:id/inline/:name",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 57 },
          },
          required: ["id", "name"],
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
        .select(["scripts"])
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      const id = INLINE_PREFIX + request.params.name;
      const script = crawl?.scripts.find((s) => s.id === id);
      if (script === undefined) return reply.code(404).send({ error: "not found" });

      return reply.code(200).send({
        name: request.params.name,
        phase: script.phase,
        source: script.source,
        // 行の scripts[] と同じ値。取り戻した物が、走らせた物と同じかを見比べられる
        sha256: script.sha256,
      });
    },
  );

  /**
   * クロール 1 本の組み合わせを、ts-compile-service に送り直した型の誤り。**落ちたクロールの誤りを
   * 行と列で読み直すエンドポイント** —— 行の失敗の文は capture-ledger の上限の 2,000 字で切られ、最初の数件しか無い。
   *
   * 送るのは、始めたときに行へ固定した写しを webhook と同じ形 (`toDispatched`) にした物で、flow の
   * compile の段が送ったのと同じ組み合わせ。だから同じ版のサービスなら、同じ誤りが返る。通る
   * 組み合わせなら `diagnostics` は空。`script` は誤りの在るスクリプトの id (受け皿の型や lib の
   * 誤りは `file` のまま)。Claude は呼ばない —— 読むだけのエンドポイントなので GET。
   */
  app.get<{ Params: { id: string } }>(
    "/api/crawls/:id/diagnostics",
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
        .select(["scripts", "variables"])
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      if (crawl === undefined) return reply.code(404).send({ error: "not found" });

      const scripts = crawl.scripts.map(toDispatched);
      let answer;
      try {
        answer = await tsCompile.compile(scripts, Object.keys(crawl.variables));
      } catch (err) {
        if (!(err instanceof TsCompileUnreachable)) throw err;
        request.log.warn({ err }, "ts-compile-service did not answer");
        return reply.code(503).send({ error: "ts-compile unreachable" });
      }
      if (answer.ok) {
        return reply.code(200).send({
          typescript: answer.typescript,
          hostTypes: answer.hostTypes,
          diagnostics: [],
        });
      }
      return reply.code(200).send({
        typescript: answer.typescript,
        diagnostics: attributeDiagnostics(
          answer.diagnostics,
          scripts.map((s) => s.id),
        ),
      });
    },
  );

  /**
   * クロール 1 本のページ。**`crawl_pages` の行を、入った順に `limit` 本ずつ。** 続きは答えの `next` を
   * `after` に渡して引く。続きを本文で言うのは、workbench の中継が状態・content-type・本文の外のヘッダを
   * 落とすから。
   *
   * 1 行は `pageOf` の形で、取り込みのログの数 (`logCounts`) を持つ —— 数は段の登録が `.result.json` から
   * 写した物で、ここでは保管庫を読まない。行そのものは `GET /api/crawls/:id/pages/:page/log` が読む。
   * 認可と 404 は `GET /api/crawls/:id` と同じ (クロールが無くても 404)。段の報告 (`POST`) と同じ path。
   */
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: number } }>(
    "/api/crawls/:id/pages",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
        querystring: {
          type: "object",
          properties: {
            // 前の答えの `next`。ページの id で、その次から返す
            after: { type: "string", pattern: PAGE_ID },
            limit: { type: "integer", minimum: 1, maximum: PAGES_MAX },
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

      const crawl = await db
        .selectFrom("crawls")
        .select(["id"])
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      if (!crawl) return reply.code(404).send({ error: "not found" });

      // 1 本多く引き、続きが在るかを言う (`GET /api/decisions` の `truncated` と同じ)
      const { after, limit = PAGES_DEFAULT } = request.query;
      let query = pageRows(db, crawl.id).limit(limit + 1);
      if (after !== undefined) query = query.where("p.id", ">", after);
      const rows = await query.execute();

      const shown = rows.slice(0, limit);
      return reply.code(200).send({
        pages: shown.map(pageOf),
        next: rows.length > limit ? (shown[shown.length - 1]?.id ?? null) : null,
      });
    },
  );

  /**
   * ページ 1 つの取り込みのログ。**capture-ledger はログを持たない** —— BrowserHive が答えと一緒に `.result.json` に
   * 書いた `log` を、そのたびに保管庫から読んで返す。行は届いた順のままで、並べ替えも言い換えもしない。
   *
   * 引く順: ページの行 (id とクロールの組 —— 他のクロールのページは 404) → その行の `task_id` →
   * `capture_submissions.manifest_key` (task_id は uuid と text なので、uuid 側を text に倒す) → 保管庫の
   * `.result.json` → 契約に照らす (`readManifest`)。途中で読めなければ、ページと理由 (`LogUnreadable`) を
   * 200 で返す。保管庫に届かないときだけ 502。認可と 404 は `GET /api/crawls/:id` と同じ。
   */
  app.get<{ Params: { id: string; page: string } }>(
    "/api/crawls/:id/pages/:page/log",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            page: { type: "string", pattern: PAGE_ID },
          },
          required: ["id", "page"],
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }

      const { id: crawlId, page: pageId } = request.params;
      const row = await pageRows(db, crawlId)
        .leftJoin("captureSubmissions as s", (join) =>
          join.onRef("p.taskId", "=", sql<string>`${sql.ref("s.taskId")}::text`),
        )
        .select("s.manifestKey")
        .where("p.id", "=", pageId)
        .executeTakeFirst();
      if (!row) return reply.code(404).send({ error: "not found" });

      const page = pageOf(row);
      const unreadable = (reason: LogUnreadable) =>
        reply.code(200).send({ page, log: null, reason });
      if (row.taskId === null) return unreadable("not-captured");
      if (row.manifestKey === null) return unreadable("no-manifest");

      let raw: unknown;
      try {
        raw = await getJsonObject(deps.s3, deps.bucket, row.manifestKey);
      } catch (err) {
        // 中身が JSON でない (`JSON.parse` が投げた) のは、届いたうえで読めない物
        if (err instanceof SyntaxError) {
          log.warn({ err, crawlId, page: pageId, key: row.manifestKey }, "Manifest is not JSON");
          return unreadable("manifest-invalid");
        }
        log.warn(
          { err, crawlId, page: pageId, key: row.manifestKey },
          "Could not read a capture's manifest from the store",
        );
        return reply.code(502).send({ error: "storage unreachable" });
      }
      if (raw === undefined) {
        log.warn(
          { crawlId, page: pageId, key: row.manifestKey },
          "Manifest is not where the capture reported writing it",
        );
        return unreadable("manifest-missing");
      }
      let report;
      try {
        report = readManifest(raw);
      } catch (err) {
        log.warn(
          { err, crawlId, page: pageId, key: row.manifestKey },
          "Manifest is not a report the ledger can read",
        );
        return unreadable("manifest-invalid");
      }
      // `log` は契約で任意の欄 (BrowserHive v24.0.0 より前の取り込みには無い)。在れば、書かれたまま返す
      if (report.log === undefined) return unreadable("no-log");
      return reply.code(200).send({ page, log: report.log, reason: null });
    },
  );

  /**
   * 型で落ちたクロールの、その場の TS の直し方。**Claude の案は、クロールと同じ検査に通った物だけを返す**
   * (`scripts/fix.ts`)。お金の掛かる Claude の前に、ただの検査と上限を済ませる —— 組み合わせが通る (409)・
   * 誤りが登録済みのスクリプトにだけ在る (422)・組織の月の上限に届いた (429) ときは、Claude を呼ばない。
   * Claude を呼んだ回は、答えがどれでも派生の層 (`026`) に残す。本文は `{}` (何も選ばせない)。
   */
  if (claude !== undefined && derivations !== undefined) {
    const budgetUsd = deps.claudeBudgetUsd ?? 0;
    const money = (usd: number) => Number(usd.toFixed(4));
    const usageOf = (r: FixResult) => ({
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      cacheReadTokens: r.usage.cache_read_input_tokens,
      cacheWriteTokens: r.usage.cache_creation_input_tokens,
      usd: money(r.usd),
    });
    const outputOf = (r: FixResult): Record<string, unknown> => {
      switch (r.kind) {
        case "fixed":
          return { kind: r.kind, hunks: r.hunks, notes: r.notes, compiled: r.compiled };
        case "failed":
          return { kind: r.kind, diagnostics: r.diagnostics, refusals: r.refusals };
        case "refused":
          return { kind: r.kind };
        case "unreachable":
        case "unavailable":
          return { kind: r.kind, message: r.message };
      }
    };

    app.post<{ Params: { id: string; name: string }; Body: Record<string, never> }>(
      "/api/crawls/:id/inline/:name/fix",
      {
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 57 },
            },
            required: ["id", "name"],
          },
          body: { type: "object", additionalProperties: false },
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
          .select(["scripts", "orgId", "variables"])
          .where("id", "=", request.params.id)
          .executeTakeFirst();
        const inlineId = INLINE_PREFIX + request.params.name;
        if (!crawl?.scripts.some((s) => s.id === inlineId)) {
          return reply.code(404).send({ error: "not found" });
        }

        const scripts = crawl.scripts.map(toDispatched);
        const variableNames = Object.keys(crawl.variables);
        let checked;
        try {
          checked = await tsCompile.compile(scripts, variableNames);
        } catch (err) {
          if (!(err instanceof TsCompileUnreachable)) throw err;
          request.log.warn({ err }, "ts-compile-service did not answer");
          return reply.code(503).send({ error: "ts-compile unreachable" });
        }
        if (checked.ok) {
          return reply.code(409).send({
            error: "scripts compile",
            typescript: checked.typescript,
            hostTypes: checked.hostTypes,
          });
        }
        const diagnostics = attributeDiagnostics(
          checked.diagnostics,
          scripts.map((s) => s.id),
        );
        // 値が足りないのは TS の誤りではない。Claude に頼むと、通る案は必須を任意にする形だけになる
        if (checked.missingVariables.length > 0) {
          return reply.code(422).send({
            error: "missing variables",
            names: checked.missingVariables,
            diagnostics,
          });
        }
        if (!diagnostics.some((d) => d.script === inlineId)) {
          return reply.code(422).send({ error: "no errors in this inline script", diagnostics });
        }

        // 数えてから呼ぶので、同時の頼みは上限を少し越えうる (同時の頼みの数 × 1 回の費用まで)。止まるのは次の頼みから
        const spent = await derivations.spentThisMonth(crawl.orgId);
        if (spent >= budgetUsd) {
          return reply
            .code(429)
            .send({ error: "claude budget exhausted", spentUsd: money(spent), budgetUsd });
        }

        const host = await readHostTypes(db);
        const result = await fixInline({
          scripts,
          inlineId,
          diagnostics,
          typescript: checked.typescript,
          hostTypes: host?.source ?? "(受け皿の型が登録されていない。scripts import を流すと入る)",
          tsCompile,
          variableNames,
          claude,
        });
        if (result.rounds > 0) {
          await derivations.record({
            kind: "fix",
            orgId: crawl.orgId,
            crawlId: request.params.id,
            target: { crawlId: request.params.id, inline: request.params.name },
            inputSha256: result.inputSha256,
            model: result.models.join(","),
            promptVersion: FIX_PROMPT_VERSION,
            effort: FIX_EFFORT,
            rounds: result.rounds,
            output: outputOf(result),
            usage: { ...result.usage },
            usd: result.usd,
            createdBy: identity.subject,
          });
        }
        request.log.info(
          {
            crawlId: request.params.id,
            inline: inlineId,
            kind: result.kind,
            rounds: result.rounds,
            usd: money(result.usd),
          },
          "Fix proposed",
        );

        switch (result.kind) {
          case "fixed":
            return reply.code(200).send({
              rounds: result.rounds,
              source: result.source,
              edits: result.hunks,
              notes: result.notes,
              compiled: result.compiled,
              usage: usageOf(result),
            });
          case "failed":
            return reply.code(422).send({
              error: "no fix passed the checks",
              rounds: result.rounds,
              diagnostics: result.diagnostics,
              refusals: result.refusals,
              usage: usageOf(result),
            });
          case "refused":
            return reply
              .code(422)
              .send({ error: "claude refused", rounds: result.rounds, usage: usageOf(result) });
          case "unreachable":
            return reply.code(503).send({ error: "ts-compile unreachable" });
          case "unavailable":
            return reply.code(502).send({ error: "claude failed", usage: usageOf(result) });
        }
      },
    );
  }

  /**
   * クロール 1 本で、規則がリンクをどう決めたか。**固定した規則と、段 × 規則 × ホスト名の数と、
   * robots.txt で取らなかったページ**を 1 度に返す —— 「なぜ取らなかったか」を 1 か所で読めるように。
   *
   * `decisions` の `rule` は `rules` の並びの番号 (1 から) で、0 はどれにも当たらずに落とした物。
   * 撮るだけのページのリンクは見ていないので、ここには来ない。認可と 404 は `GET /api/crawls/:id` と同じ。
   */
  app.get<{ Params: { id: string } }>(
    "/api/crawls/:id/decisions",
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
        .select(["id", "rules"])
        .where("id", "=", request.params.id)
        .executeTakeFirst();
      if (!crawl) return reply.code(404).send({ error: "not found" });

      const decisions = await db
        .selectFrom("crawlDecisions")
        .select(["depth", "rule", "action", "hostname", "links", "samples"])
        .where("crawlId", "=", crawl.id)
        .orderBy("depth")
        .orderBy("rule")
        .orderBy("hostname")
        .execute();

      // robots.txt で取らなかったページ。plan の段が見送り、報告が `skipped` と理由 `robots` で閉じた
      // `crawl_pages` の行。ホスト名は `crawl_decisions` と揃えてポートを外す (`crawl_pages.host` は含む)。
      // `count` は int8 で、node-pg は文字列で返すので int に倒す (`waczCount` と同じ)。
      const robots = await sql<{ hostname: string; pages: number; samples: string[] }>`
        select regexp_replace(host, ':[0-9]+$', '') as hostname,
               count(*)::int as pages,
               (array_agg(url order by id))[1:${sql.lit(SAMPLES)}] as samples
          from crawl_pages
         where crawl_id = ${crawl.id} and state = 'skipped' and skip_reason = 'robots'
         group by 1
         order by 1`.execute(db);

      return reply.code(200).send({
        crawlId: crawl.id,
        rules: crawl.rules,
        decisions,
        robots: robots.rows,
      });
    },
  );

  /**
   * クロール 1 本のリンクの構成 (図 1 枚ぶん)。**撮ったページ (親・深さ・結末・題・出入りのリンクの数) と、
   * 見つけた別々の URL がどうなったかの内訳**を 1 度に返す (`crawl/links-read.ts`)。撮らなかった URL は 1 本ずつは
   * 返さず、最初に見つけたページと理由で束ねた数 (`bundles`) と、規則で落とした物のホスト名ごとの数 (`hosts`) に
   * する —— 1 本ずつは `GET /api/crawls/:id/links/:page`。
   *
   * リンクの記録 (`crawl_links`・`039`) が無いクロールは `recorded: false` で、ページと親 (木) だけを返す。
   * 認可と 404 は `GET /api/crawls/:id` と同じ。
   */
  app.get<{ Params: { id: string } }>(
    "/api/crawls/:id/links",
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
      const graph = await readLinkGraph(db, request.params.id);
      if (graph === undefined) return reply.code(404).send({ error: "not found" });
      return reply.code(200).send(graph);
    },
  );

  /**
   * 1 ページの出入りのリンク。`out` はそのページにあったリンクを 1 本ずつ (あった順・どうなったか・行き先の
   * ページの id)、`in` はそのページへのリンクを持つページ。ページはクロールとの組で引く (ほかのクロールのページなら
   * 404)。認可と 404 は `GET /api/crawls/:id` と同じ。
   */
  app.get<{ Params: { id: string; page: string } }>(
    "/api/crawls/:id/links/:page",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            page: { type: "string", pattern: PAGE_ID },
          },
          required: ["id", "page"],
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }
      const links = await readPageLinksOf(db, request.params.id, request.params.page);
      if (links === undefined) return reply.code(404).send({ error: "not found" });
      return reply.code(200).send(links);
    },
  );

  /**
   * そのドメイン (と、その下のサブドメイン) で規則が決めたこと。**クロールを跨いで**、新しい順。
   * 「このドメインを落としたことはあるか。どのクロールの、どの規則で」に答える。
   *
   * ラベルの境目で照らす —— `ads.example.com` で `badads.example.com` は出ない。`domain` は規則の
   * ドメインと同じ式で確かめてから SQL に渡すので、LIKE の特別な字 (`%`・`_`) を含まない。
   * `links` は段ごとの別々の URL を足した数 (同じ URL を 2 つの段で見つければ 2)。
   *
   * 権限が無ければ空。一覧 (`GET /api/crawls`) と同じ作法で、「在るが見せない」と「無い」を区別させない。
   */
  app.get<{ Querystring: { domain: string; days?: number; action?: CrawlRuleAction } }>(
    "/api/decisions",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["domain"],
          properties: {
            domain: { type: "string" },
            days: { type: "integer", minimum: 1, maximum: 3650 },
            action: { type: "string", enum: ["follow", "capture", "skip"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { domain, days = 90, action = "skip" } = request.query;
      // 許可を見る前に断る (`GET /api/crawls/:id/inline/:name` の名前と同じ)。式が規則のドメインと
      // 同じなので、規則に書けるドメインはここでも引ける
      if (!HOSTNAME.test(domain)) return reply.code(400).send({ error: "invalid domain" });

      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(200).send({ decisions: [], truncated: false });
      }

      // 行の上限より 1 本多く引き、超えたかどうかを言う。クロールの列は id で束ねる (主キーなので、
      // 同じ行の started_at・seeds・rules も選べる)
      const result = await sql<{
        crawlId: string;
        startedAt: Date;
        seeds: string[];
        rules: CrawlRule[];
        rule: number;
        action: CrawlRuleAction;
        hostname: string;
        links: number;
      }>`
        select c.id as crawl_id, c.started_at, c.seeds, c.rules,
               d.rule, d.action, d.hostname, sum(d.links)::int as links
          from crawl_decisions d
          join crawls c on c.id = d.crawl_id
         where d.action = ${action}
           and (d.hostname = ${domain} or d.hostname like ${`%.${domain}`})
           and c.started_at >= now() - make_interval(days => ${days})
         group by c.id, d.rule, d.action, d.hostname
         order by c.started_at desc, d.rule, d.hostname
         limit ${sql.lit(DECISIONS_SHOWN + 1)}`.execute(db);

      const rows = result.rows.slice(0, DECISIONS_SHOWN);
      return reply.code(200).send({
        decisions: rows.map((row) => {
          // 当たった規則の当てる物。0 (どれにも当たらない) には無い
          const matched = row.rule === 0 ? undefined : row.rules[row.rule - 1];
          return {
            crawlId: row.crawlId,
            startedAt: row.startedAt,
            seeds: row.seeds,
            rule: row.rule,
            action: row.action,
            pattern: matched === undefined ? null : ruleParts(matched).raw,
            hostname: row.hostname,
            links: row.links,
          };
        }),
        truncated: result.rows.length > DECISIONS_SHOWN,
      });
    },
  );

  /**
   * 規則の並びを、始める前に確かめる。**書かないエンドポイントなので GET** —— workbench は GET の `/api/*` を
   * そのまま通すので、書き込みのエンドポイントを増やさずに載る。何度呼んでも何も変わらない。
   *
   * 規則は `rule=動き:当てる物` を並べる (当てる物の URL の `:` は、最初の 1 つで切るので構わない)。
   * 判定は始めるエンドポイントの 400 と同じ関数 (`checkRules`)。行ごとに読めたか・覆われているか、起点ごとに
   * 撮って辿るかを返す。認可は始めるエンドポイントと同じ。
   */
  app.get<{ Querystring: { seed?: string[]; rule?: string[] } }>(
    "/api/crawl-rules/check",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            // 1 本だけなら文字列で届くが、ajv が配列に直す (fastify の既定の `coerceTypes: "array"`)
            seed: { type: "array", items: { type: "string", minLength: 1 } },
            rule: {
              type: "array",
              maxItems: RULES_MAX,
              items: {
                type: "string",
                pattern: "^(follow|capture|skip):",
                maxLength: "capture:".length + RULE_PATTERN_MAX,
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

      const rawSeeds = request.query.seed ?? [];
      const parsedSeeds = rawSeeds
        .map((raw) => parseHttpUrl(raw))
        .filter((seed) => seed !== undefined);
      const asked = (request.query.rule ?? []).map((text): CrawlRule => {
        const at = text.indexOf(":");
        const pattern = text.slice(at + 1);
        switch (text.slice(0, at)) {
          case "follow":
            return { follow: pattern };
          case "capture":
            return { capture: pattern };
          default:
            return { skip: pattern };
        }
      });
      const checked = checkRules(asked, parsedSeeds);
      const coveredBy = new Map(checked.covered.map((c) => [c.rule, c.coveredBy]));
      const unfollowed = new Set(checked.unfollowedSeeds);

      const seeds = rawSeeds.map((raw) => {
        const parsed = parseHttpUrl(raw);
        return parsed === undefined
          ? { url: raw, valid: false }
          : {
              url: parsed.normalized,
              valid: true,
              site: siteOf(parsed.hostname),
              followed: !unfollowed.has(parsed.normalized),
            };
      });
      const rules = asked.map((rule, i) => {
        const read = checked.read[i];
        const by = coveredBy.get(i + 1);
        return {
          rule: i + 1,
          action: ruleParts(rule).action,
          kind: read === undefined ? "invalid" : read.pattern.kind,
          // 読めた物は書き残す形で (前方一致は正規化した URL)。読めない物は頼まれたまま
          pattern: read === undefined ? ruleParts(rule).raw : ruleParts(ruleOf(read)).raw,
          ...(by === undefined ? {} : { coveredBy: by }),
        };
      });

      return reply.code(200).send({
        seeds,
        rules,
        ok:
          checked.invalid.length === 0 &&
          checked.covered.length === 0 &&
          seeds.every((seed) => seed.valid && seed.followed === true),
      });
    },
  );

  /**
   * 1 段ぶんの報告を受け、次の段を返す。
   *
   * **この 1 往復に判断が全部入っている。** 報告を記録し、帰属を書き、見つけたリンクに
   * 規則を当てて決めたことを残し、重複を index に落とさせ、上限を当て、残ったものを返す。
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
          required: ["depth", "results", "compiled"],
          properties: {
            depth: { type: "integer", minimum: 0 },
            // 走った JS の hash と、何で・何に向けて変換したか。省略可にしない —— 載せ忘れた flow が
            // 黙って通ると、capture-ledger は「どの JS が走ったか」を二度と言えない (`capture_formats` と同じ理由)。
            compiled: {
              type: "object",
              additionalProperties: false,
              required: ["typescript", "hostTypes", "scripts"],
              properties: {
                typescript: { type: "string", minLength: 1 },
                hostTypes: { type: "string", minLength: 1 },
                scripts: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "version", "sha256"],
                    properties: {
                      id: { type: "string", minLength: 1 },
                      version: { type: "integer", minimum: 1 },
                      sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                    },
                  },
                },
              },
            },
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
                // 読みに行く鍵を持たないまま capture-ledger に残り、誰も拾わない。
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

      const { depth, results, compiled } = request.body;

      // ── 段の鍵 (CAPTURE-180) ─────────────────────────────────────────
      // 鍵は段の行の `job_id` で、flow が `level_key` の引数で受けて返す。**同じ段の報告の 2 回目** (応答が切れた
      // 後の report_level の再試行・同じ引数で流し直した flow・worker が止まった後の Windmill のやり直し) には、
      // 最初の答えを返す。数を重ねず、次の段も 2 回投げない。
      const key = requestKeyOf(request.headers[REQUEST_KEY_HEADER]);
      if (key === undefined) return reply.code(400).send(MISSING_LEVEL_KEY);
      const level = await db
        .selectFrom("crawlLevels")
        .select(["jobId", "state", "answer"])
        .where("crawlId", "=", crawlId)
        .where("depth", "=", depth)
        .executeTakeFirst();
      // 段の行の無い段 (段の行を入れる前に始めたクロールか、投げていない深さ) と、鍵の違う報告は 422 ——
      // 待っても通らない。待てば通る「報告中」の 409 と分ける
      if (!level) return reply.code(422).send({ error: "no such level of this crawl" });
      if (level.jobId !== key) {
        return reply.code(422).send({ error: "Idempotency-Key is not the key of this level" });
      }
      if (level.state === "reported" && level.answer !== null) {
        log.info({ crawlId, depth }, "Level reported again; answered as the first time");
        return reply.code(200).send(level.answer);
      }
      // **締めた段・締めたクロールに届いた報告** (CAPTURE-77): ページは記録し (archives にも入る)、次の段は作らない。
      let closedLevel = level.state === "abandoned" || crawl.state !== "running";
      // 報告の試みの印。終わりの commit はこの印が同じときだけ通す —— 期限切れで取り直した 2 本目と、遅れた
      // 1 本目が並んでも、片方しか書けない。1 つのトランザクションにしないのは、途中で保管庫を読むから
      const token = randomUUID();
      /**
       * 報告中の期限を延ばす。保管庫を読む段 (manifest・リンク) の後に呼ぶ —— 頁の多い段の処理が 2 分を超えても、
       * 生きている試みの期限は切れない。取り直されていたら何もしない (終わりの commit が 409 で断る)
       */
      const renewLease = async (): Promise<void> => {
        await db
          .updateTable("crawlLevels")
          .set({ leaseUntil: new Date(Date.now() + LEVEL_REPORT_LEASE_MS).toISOString() })
          .where("crawlId", "=", crawlId)
          .where("depth", "=", depth)
          .where("state", "=", "reporting")
          .where("reportToken", "=", token)
          .execute();
      };
      if (!closedLevel) {
        const at = new Date();
        const claimed = await db
          .updateTable("crawlLevels")
          .set({
            state: "reporting",
            reportToken: token,
            leaseUntil: new Date(at.getTime() + LEVEL_REPORT_LEASE_MS).toISOString(),
          })
          .where("crawlId", "=", crawlId)
          .where("depth", "=", depth)
          // 投げた (受け取りの確認の前) の段にも報告は届きうる
          .where((eb) =>
            eb.or([
              eb("state", "in", ["pending", "sent", "accepted"]),
              eb.and([eb("state", "=", "reporting"), eb("leaseUntil", "<=", at)]),
            ]),
          )
          .returning("depth")
          .executeTakeFirst();
        if (claimed === undefined) {
          const now = await db
            .selectFrom("crawlLevels")
            .select(["state", "answer"])
            .where("crawlId", "=", crawlId)
            .where("depth", "=", depth)
            .executeTakeFirst();
          if (now?.state === "reported" && now.answer !== null) {
            return reply.code(200).send(now.answer);
          }
          if (now?.state !== "abandoned") {
            // 報告中 (期限の内)。flow の再試行に任せる
            return reply.code(409).send({ error: "this level is being reported" });
          }
          closedLevel = true;
        }
      }
      /** 報告を記録する。`token` が無いのは締めた段 (次の段を作らない)。 */
      const recordLevel = async (token: string | undefined) => {
        // ── 0. 走った JS の hash を、固定したスクリプトに写す ────────────
        // capture-ledger の `sha256` は TS の物で、archive に残るのは JS。その間を継ぐ JS の hash は
        // 報告にしか無い。揃っていなければ断る (400/409) —— **capture-ledger と flow の片方だけを新しく
        // すると 1 段目でここに当たる。** 黙って通すより、報告の形が違うことを最初に言う。
        const merge = mergeCompiled(crawl.scripts, compiled);
        if ("status" in merge) {
          log.warn({ crawlId, depth, scriptId: merge.scriptId }, merge.error);
          return reply.code(merge.status).send({ error: merge.error, scriptId: merge.scriptId });
        }
        if (merge.changed) {
          await db
            .updateTable("crawls")
            .set({ scripts: JSON.stringify(merge.scripts) })
            .where("id", "=", crawlId)
            .execute();
        }

        // 起点と規則は投入時に検査しているので、読めない行はここに来ない。**それでも
        // 全部を読み直す** —— 規則を当てるのに要るのは読んだ形で、行に入っているのは
        // 文字列だから。1 本でも読めなければ行が壊れている。
        const parsedSeeds: ParsedUrl[] = [];
        for (const raw of crawl.seeds) {
          const parsed = parseHttpUrl(raw);
          if (parsed === undefined) {
            return reply.code(500).send({ error: "a crawl seed is not a usable url" });
          }
          parsedSeeds.push(parsed);
        }
        const rules = compileRules(crawl.rules);
        if (rules === undefined) {
          return reply.code(500).send({ error: "a crawl rule is not readable" });
        }

        // ── 1. 報告された行を閉じる ────────────────────────────────────────
        // 閉じた行の id は、そのページで見つけたリンクの `discovered_from` に書く (木の形を後から辿れる)。
        const idOf = new Map<string, string>();
        for (const page of results) {
          const closed = await db
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
            .returning("id")
            .executeTakeFirst();
          if (closed !== undefined) idOf.set(page.url, closed.id);
        }

        // ── 2. 帰属を書く ────────────────────────────────────────────────
        // 投げたのが ledger でなくても、記録はここに残す。reconciler はこの行 (帰属と
        // manifest の鍵) だけを読む。
        //
        // **状態は問わない。`taskId` を持つ全件に書く。** 以前は `captured` だけに
        // 書いていたが、それだと失敗と報告された取り込みの帰属が残らない ——
        // 実体が S3 に在っても組織が言えず、capture-ledger に入れようがない。
        // 投入が通っている限り id は在るので、書かない理由が無い。
        const submitted = results.filter(
          (r): r is PageReport & { taskId: string } =>
            typeof r.taskId === "string" && r.taskId !== "",
        );
        // 報告の場所を capture-ledger の形に。**1 度だけ計算し、書き留める値と読みに行く鍵に同じものを使う。**
        const manifests = new Map(
          submitted.map((r) => [r.taskId, manifestOutcome(r, deps.bucket)]),
        );
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

          // ── 2b. capture-ledger に載せる ──────────────────────────────────────────
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
          // **`archives` には在るのにクロールの記録では失敗している、を残さない。**
          // どちらが正しいかを後から言えなくなる。manifest が成功を語っているなら
          // そちらが正 —— 報告のほうは、flow が答えをどう受け取ったかでしかない。
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

          // ── 2d. 取り込みのログの数を、ページの行に写す (`025`) ────────────────
          // WACZ が無く `archives` に入らなかった取り込み (時間切れ・失敗) の数も在る (`crawl/admit-level.ts`)。
          // 引くのはクロールと taskId の組で、上書きなので、同じ段の報告がやり直されても値は変わらない。
          for (const [taskId, counts] of admitted.logCounts) {
            await db
              .updateTable("crawlPages")
              .set({ logCounts: JSON.stringify(counts) })
              .where("crawlId", "=", crawlId)
              .where("taskId", "=", taskId)
              .execute();
          }
        }

        if (token !== undefined) await renewLease();

        // ── 3. 見つけたリンクを読み、規則を当てる ────────────────────────
        // **ページごとに読む。** リンク元が「撮って辿る」でなければ、そのページのリンクは見ない ——
        // 撮るだけの先は辿らない。links はどのページでも取る (`capture-formats.ts`) ので撮るだけのページにも
        // 在るが、取って読まない。
        // `all` は読んだ全部 (`rel="nofollow"` で外した物も)。`crawl_links` (`039`) に 1 本ずつ残す
        const pages: { from: string | null; links: DecidedLink[]; all: PageLink[] }[] = [];
        for (const page of results) {
          if (page.linksLocation === undefined || page.linksLocation === "") continue;
          // 読むか読まないか (撮るだけの先・外へ跳ばされた先は読まない) は `crawl/links-source.ts`
          const read = await readPageLinks(
            { s3: deps.s3, bucket: deps.bucket },
            { url: page.url, linksLocation: page.linksLocation },
            rules,
            parsedSeeds,
          );
          if (read.kind !== "links") continue;
          pages.push({
            from: idOf.get(page.url) ?? null,
            links: decidedOf(read.links),
            all: read.links,
          });
        }

        if (token !== undefined) await renewLease();
        const discovered = acceptLinks(pages);
        const nextDepth = depth + 1;

        // ── 3b. 決めたことを残す ──────────────────────────────────────────
        // 規則 × ホスト名で、別々の URL を数える (`crawl/decisions.ts`)。**同じ段の報告をやり直したら
        // 置き換える** —— 足すと、やり直しのたびに数が増える。
        const decisions = aggregateDecisions(
          pages.flatMap((page) => page.links),
          nextDepth,
        );
        if (decisions.length > 0) {
          await db
            .insertInto("crawlDecisions")
            .values(decisions.map((row) => ({ crawlId, ...row })))
            .onConflict((oc) =>
              oc.columns(["crawlId", "depth", "rule", "hostname"]).doUpdateSet((eb) => ({
                action: eb.ref("excluded.action"),
                links: eb.ref("excluded.links"),
                samples: eb.ref("excluded.samples"),
              })),
            )
            .execute();
        }

        const capturedCount =
          results.filter((r) => r.status === "captured").length + recovered.length;

        // ── 3c. リンクを 1 本ずつ残す (`039`) ─────────────────────────────────
        // 次の段のページを入れた**後**に、同じトランザクションの中で呼ぶ。どうなったかは `crawl_pages` の行
        // (URL → 見つけたページ) から決めるので、報告をやり直しても同じ行になる (`crawl/link-outcomes.ts`)
        const recordLinks = async (trx: Kysely<Database>, closed: boolean): Promise<void> => {
          const read = pages.filter(
            (page): page is typeof page & { from: string } => page.from !== null,
          );
          const { rows, dropped } = linkRows(
            crawlId,
            read.map((page) => ({ from: page.from, links: page.all })),
            await pageParents(trx, crawlId),
            cutOf({ nextDepth, maxDepth: crawl.maxDepth, closed }),
          );
          await replaceLinks(
            trx,
            crawlId,
            read.map((page) => page.from),
            rows,
          );
          if (dropped > 0) {
            log.warn(
              { crawlId, depth, dropped },
              "Links over the per-page limit were not recorded",
            );
          }
        };

        // ── 締めた段・締めたクロール ───────────────────────────────────────
        // ページは上で記録した。段の数を書き、クロールの合計を数え直すだけで、次の段の行は作らない (CAPTURE-77)
        if (token === undefined) {
          await db
            .updateTable("crawlLevels")
            .set({ pagesCaptured: capturedCount, pagesDiscovered: discovered.length })
            .where("crawlId", "=", crawlId)
            .where("depth", "=", depth)
            .execute();
          await db.transaction().execute(async (trx) => {
            // 締めた後に届いた段のリンクも残す。規則が通しても次の段には入らないので `closed` (`039`)
            await recordLinks(trx, true);
            await writeTotals(trx, crawlId);
          });
          log.info(
            { crawlId, depth, reported: results.length },
            "Recorded a level of a closed crawl; no next level",
          );
          return reply.code(200).send({ next: [], stopReason: crawl.stopReason });
        }

        // ── 4. 上限を当てる ──────────────────────────────────────────────
        // **既に行のある URL は候補にしない。** まだ撮っていない候補が無ければ、深さや枚数で切ったとは言えない。
        // 上限より先に除くので、既知の URL が枠を取ることも無い (入れる瞬間の守りは 5 の unique index)。
        // `in` で引かずに行を全部読む —— 行数は `max_pages` で上が決まり、リンクの本数で引数が増えない。
        const knownRows = await db
          .selectFrom("crawlPages")
          .select(["url", "depth", "state"])
          .where("crawlId", "=", crawlId)
          .execute();
        const knownUrls = new Set(knownRows.map((row) => row.url));

        const { toInsert, stopReason } = planNextLevel(
          discovered.filter((link) => !knownUrls.has(link.url)),
          {
            nextDepth,
            maxDepth: crawl.maxDepth,
            maxPages: crawl.maxPages,
            known: knownRows.length,
          },
        );

        // 次の段に載せる物 (ホストごとの最後の時刻と、読み直したシークレット) は、次の段がありうるときだけ引く。
        // 取り直した 2 回目では、前の試みが入れた深さ n+1 の pending の行が次の段になる
        const mayContinue =
          toInsert.length > 0 ||
          knownRows.some((row) => row.depth === nextDepth && row.state === "pending");
        const lastByHost = new Map<string, string>();
        let secrets = crawl.secrets;
        if (mayContinue) {
          // ホストごとの「最後に触り終えた時刻」を引く。段をまたぐ間隔のために要る。
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
          // シークレットが途中で替わっていないかを読み直してから配る (替わっていても続ける)
          secrets = await noteRotations(crawlId, crawl.secrets, nextDepth);
        }

        // ── 5〜7. 終わりの commit ──────────────────────────────────────────
        // 試みの印を照らし、次の段のページを入れ、段を報告済みにし、合計を書き直し、次の段の行を作る。**ここまでを
        // 1 つのトランザクションに** —— 印が違えば (期限切れで取り直された) 何も残さない。
        let answer: LevelAnswer = { next: [], stopReason: null };
        let nextLevel: DispatchedCrawl | undefined;
        await db.transaction().execute(async (trx) => {
          const mine = await trx
            .selectFrom("crawlLevels")
            .select("depth")
            .where("crawlId", "=", crawlId)
            .where("depth", "=", depth)
            .where("state", "=", "reporting")
            .where("reportToken", "=", token)
            .forUpdate()
            .executeTakeFirst();
          if (mine === undefined) throw new Superseded();
          // 締める側 (`/failed`・投げる係) と並ばないよう、クロールの行も取る
          const live = await trx
            .selectFrom("crawls")
            .select(["state", "stopReason"])
            .where("id", "=", crawlId)
            .forUpdate()
            .executeTakeFirstOrThrow();

          // ── 5. 重複を index に落とさせる ──────────────────────────────
          if (toInsert.length > 0) {
            await trx
              .insertInto("crawlPages")
              .values(
                toInsert.map((link) => ({
                  crawlId,
                  url: link.url,
                  depth: nextDepth,
                  host: link.host,
                  discoveredFrom: link.discoveredFrom,
                  state: "pending" as const,
                })),
              )
              .onConflict((oc) => oc.columns(["crawlId", "urlHash"]).doNothing())
              .execute();
          }
          // ── 5b. リンクを 1 本ずつ残す (`039`)。上で入れた行を読んで決める ──────────
          // 行の無いリンクは、上限 (4) が切った物。この道では、締まっていても 5 の行は入っている
          await recordLinks(trx, false);

          // **次の段は「今回入った行」でなく、深さ n+1 の pending の行。** 取り直した 2 回目では入る行が 0 になり、
          // `returning` で決めると途中で完了と読む。走行中のクロールだけ (締めた後に次の段を作らない。CAPTURE-77)
          const next =
            live.state === "running"
              ? await trx
                  .selectFrom("crawlPages")
                  .select(["url", "host"])
                  .where("crawlId", "=", crawlId)
                  .where("depth", "=", nextDepth)
                  .where("state", "=", "pending")
                  .orderBy("id")
                  .execute()
              : [];
          const done = next.length === 0;

          // ── 6. 数を書き、合計を数え直し、終わったなら締める ──────────────────
          // **拾い直したぶんも数える。** 報告だけを数えると、`archives` に入った件数と `pages_captured` が食い違う。
          // 段の数は**書く** (足さない) ので、報告をやり直しても重ならない
          await trx
            .updateTable("crawlLevels")
            .set({ pagesCaptured: capturedCount, pagesDiscovered: discovered.length })
            .where("crawlId", "=", crawlId)
            .where("depth", "=", depth)
            .execute();
          const totals = await writeTotals(trx, crawlId);

          // **最初に効いた理由を残す。上書きしない。**
          //
          // 段の途中で `max_pages` に当たって切っても、そのあと最後の段が `max_depth` で
          // 終われば、素朴に書くと後者で上書きされる。すると「深さの範囲は全部辿った」と
          // 読めてしまうが、実際には切り落としている —— 実測で踏んだ: 50 件見つけて 9 件
          // 入れたクロールが `max_depth` と記録された。
          //
          // `coalesce` で最初の非 NULL を守る。`budget.ts` が深さを件数より優先するのと
          // 同じ考え方で、**先に効いた制約**が理由になる。
          //
          // **締めるのは走行中の行だけ** (CAPTURE-61)。条件は行の更新の中で見る。
          //
          // **辿るよう頼んだのに 1 本もリンクが無ければ `no_links`** (CAPTURE-245)。深さ 1 以上で、規則が通した
          // リンクがこの段までの延べで 0 本のとき (合計は段の行の和)。`completed` (全部辿った) と言うと、frameset の頁の
          // ように 1 ページで黙って終わったクロールが緑に見える。深さ 0 は辿らないと頼んだので、0 本でも `completed`。
          const noLinks = crawl.maxDepth > 0 && totals.pagesDiscovered === 0;
          const reason =
            stopReason ??
            (done ? (noLinks ? ("no_links" as const) : ("completed" as const)) : null);
          // **`succeeded` は 1 枚以上撮れたクロールだけ** (`crawl/close.ts`)
          const nothingCaptured = done && totals.pagesCaptured === 0;
          if (reason !== null || done) {
            await trx
              .updateTable("crawls")
              .set((eb) => ({
                ...(reason === null
                  ? {}
                  : { stopReason: eb.fn.coalesce("stopReason", eb.val(reason)) }),
                ...(done
                  ? {
                      state: eb
                        .case()
                        .when("state", "=", "running")
                        .then(eb.val<CrawlState>(nothingCaptured ? "failed" : "succeeded"))
                        .else(eb.ref("state"))
                        .end(),
                      // 読みの型は Date、書くのは ISO の文字列 (ほかの書き込みと同じ)。式の型を書きの型に寄せる
                      finishedAt: eb
                        .case()
                        .when("state", "=", "running")
                        .then(eb.val(new Date().toISOString()))
                        .else(eb.ref("finishedAt"))
                        .end()
                        .$castTo<string | null>(),
                      ...(nothingCaptured
                        ? {
                            stopReason: eb
                              .case()
                              .when("state", "=", "running")
                              .then(eb.val<CrawlStopReason>("failed"))
                              .else(eb.ref("stopReason"))
                              .end(),
                            error: eb
                              .case()
                              .when("state", "=", "running")
                              .then(eb.val(nothingCapturedError(results)))
                              .else(eb.ref("error"))
                              .end(),
                          }
                        : {}),
                    }
                  : {}),
              }))
              .where("id", "=", crawlId)
              .execute();
          }

          answer = {
            next: next.map((row) => ({ url: row.url, host: row.host, depth: nextDepth })),
            // **行の理由が先** (上の `coalesce`)。枚数で切った後の段で、返事だけ「全部辿った」と言わない
            stopReason: done ? (nothingCaptured ? "failed" : (live.stopReason ?? reason)) : null,
          };
          await trx
            .updateTable("crawlLevels")
            .set({
              state: "reported",
              reportedAt: new Date().toISOString(),
              leaseUntil: null,
              answer: JSON.stringify(answer),
            })
            .where("crawlId", "=", crawlId)
            .where("depth", "=", depth)
            .execute();

          // ── 7. 次の段があるなら、段の行を作る (投げるのは commit の後) ─────────────
          // flow は 1 段を処理して報告するだけ。繰り返しをここに置いたのは、上限の判定
          // (`budget.ts`) と同じ場所に置くため —— そして Windmill の while ループが
          // 止まらなかったため (`DispatchedCrawl` の注記を見ること)。
          if (!done) {
            nextLevel = {
              crawlId,
              depth: nextDepth,
              levelKey: randomUUID(),
              frontier: next.map((row) => ({
                url: row.url,
                host: row.host,
                lastFinishedAt: lastByHost.get(row.host) ?? null,
              })),
              perHostDelayMs: crawl.perHostDelayMs,
              hostParallelism: crawl.hostParallelism,
              captureFormats: capture.formats,
              signing: capture.signing,
              // 登録済みのスクリプトは引き直さない —— 行に固定したものをそのまま配る (報告で写した JS の hash は渡さない)。
              scripts: crawl.scripts.map(toDispatched),
              // 値も行に固定した物をそのまま。変数は値ごと、シークレットは名前 → path と、残す名前 (読み直した写しから)
              variables: crawl.variables,
              ...secretsForFlow(secrets),
              userAgent: crawl.userAgent ?? "",
              ...(sink && { artifactSink: sinkForCrawl(sink, crawlId) }),
            };
            await insertLevel(trx, nextLevel);
          }
        });

        log.info(
          { crawlId, depth, reported: results.length, next: answer.next.length, stopReason },
          "Crawl level recorded",
        );
        if (nextLevel !== undefined) dispatchLevel(nextLevel);
        return reply.code(200).send(answer);
      };

      try {
        return await recordLevel(closedLevel ? undefined : token);
      } catch (err) {
        // 途中で落ちた (保管庫が読めない など)。**取った印を手放す** —— 期限 (2 分) を待たずに、flow の再試行が取り直せる
        if (!closedLevel && !(err instanceof Superseded)) {
          await db
            .updateTable("crawlLevels")
            .set({ leaseUntil: new Date().toISOString() })
            .where("crawlId", "=", crawlId)
            .where("depth", "=", depth)
            .where("reportToken", "=", token)
            .where("state", "=", "reporting")
            .execute()
            .catch(() => undefined);
        }
        if (err instanceof Superseded) {
          return reply.code(409).send({ error: "another attempt took over this level report" });
        }
        throw err;
      }
    },
  );

  /**
   * 段が落ちたことを受け取り、クロールを締める。
   *
   * ## なぜ要るのか
   *
   * flow が段の途中で落ちると `POST /pages` に辿り着かないので、**ledger は何も
   * 知らされない**。行は `running` のまま残り、部分 unique index が以後のクロールを
   * 全部塞ぐ。実測で踏んだ: BrowserHive を止めてクロールを始めると、`crawl_host` が
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
   * ## 締めた後に合本を書く
   *
   * 締めたら、終わった状態 (failed) の合本を 1 本書く (署名の設定が在れば署名する。CAPTURE-61)。flow は落ちた段の
   * 後に合本のエンドポイントを叩かないので、ここで書かないと、クロールの最後の合本は走っている時の物のまま残る。書き終えてから
   * 答える。書けなくても `{closed: true}` は変わらない。
   *
   * ## 落ちた段の取り込みは capture-ledger に入らない
   *
   * 落ちた段でも、そこまでに成功した取り込みの成果物は S3 に在る。けれど報告が来ないので
   * `crawl_pages` は `pending` のまま、`capture_submissions` も書かれない —— 帰属も
   * manifest の鍵も分からないので、`reconcile` もそれを capture-ledger に入れられない。bucket を
   * 一覧していた頃も同じで、見つけても帰属が無く `unattributed` と数えるだけだった。
   * **成果物は残るが、`archives` とクロールの記録からは欠ける。**
   */
  app.post<{
    Params: { id: string };
    Body: { reason?: string; depth?: number; levelKey?: string };
  }>(
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
          properties: {
            reason: { type: "string", maxLength: 2000 },
            // 落ちた段とその鍵 (CAPTURE-180)。flow の fail_crawl が送る。2 つは揃って来る
            depth: { type: "integer", minimum: 0 },
            levelKey: { type: "string", minLength: 1, maxLength: 255 },
          },
          dependencies: { depth: ["levelKey"], levelKey: ["depth"] },
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
      // **一番新しい段の flow の失敗だけが締める** (CAPTURE-180)。古い段の flow (報告の後の合本・索引の段で
      // 落ちた・手で流し直した) の失敗で、次の段を撮っている健全なクロールを締めない。鍵の無い要求は人の「締める」
      const { depth, levelKey } = request.body ?? {};
      if (levelKey !== undefined) {
        const newest = await db
          .selectFrom("crawlLevels")
          .select(["depth", "jobId"])
          .where("crawlId", "=", crawlId)
          .orderBy("depth", "desc")
          .limit(1)
          .executeTakeFirst();
        if (newest === undefined || newest.depth !== depth || newest.jobId !== levelKey) {
          log.info(
            { crawlId, depth, newest: newest?.depth },
            "Not closing: the failure is not from the newest level",
          );
          return reply.code(200).send({ closed: false });
        }
      }
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
      // 一番新しい段を「締めた」に。遅れて届いた報告はページを記録するが、次の段を作らない (CAPTURE-77)
      await db
        .updateTable("crawlLevels")
        .set({ state: "abandoned" })
        .where("crawlId", "=", crawlId)
        .where("state", "not in", ["reported", "abandoned"])
        .where("depth", "=", (eb) =>
          eb
            .selectFrom("crawlLevels as newest")
            .select((e) => e.fn.max("newest.depth").as("depth"))
            .where("newest.crawlId", "=", crawlId),
        )
        .execute();
      log.warn({ crawlId, depth, reason: request.body?.reason }, "Crawl closed");
      // 締めた状態 (failed) の合本を書き、署名の設定が在れば署名する。**待ってから答える** —— 落ちた段の後に
      // 段は来ないので、ここで書かなければ誰も書かない。合本が書けなくても締めたことは変わらない (投げない)
      await bundleAfterClose(crawlId);
      return reply.code(200).send({ closed: true });
    },
  );
};
