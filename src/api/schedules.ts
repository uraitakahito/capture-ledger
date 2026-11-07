/**
 * 定期実行の予定の口。**台帳が持つ資源として返す** —— 文を作るのは workbench で、ここは状態の語だけを返す。
 *
 * 絞りは `/api/crawls` と同じ `maySubmit`。一覧は 200 の空、1 本と操作は 404 で答える。消した予定は無い物と同じ。
 *
 * 操作はどれも POST にする。capture-workbench の中継の書き込みは POST だけで、消すのも同じ形にしておくと、
 * 中継の形を 1 本の正規表現で絞れる。
 */
import type { OpenFgaClient } from "@openfga/sdk";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { CrawlRequester, CrawlBody, PreparedCrawl, RefusedCrawl } from "../crawl/prepare.js";
import { CRAWL_BODY_LIMIT, CRAWL_BODY_SCHEMA } from "../crawl/prepare.js";
import type { ScheduleRecipe } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import { checkCron, nextRunAfter } from "../schedules/cron.js";
import { scheduleHealth } from "../schedules/health.js";
import type {
  LatestVersions,
  ScheduleRow,
  ScheduleRun,
  ScheduleStore,
} from "../schedules/store.js";
import { maySubmit, unauthorized } from "./authorization.js";
import type { IdentityResolver } from "./identity.js";

const log = createChildLogger({ module: "api" });

const NAME_MAX = 100;
const CRON_MAX = 200;
/** `crawl_schedules.timezone` の既定と同じ。画面には欄を出さない。 */
const TIMEZONE = "Asia/Tokyo";

export interface ScheduleRouteDeps {
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
  store: ScheduleStore;
  /** 確かめと解決。`POST /api/crawls` と同じ `prepareCrawl` を、配備の窓口で包んだ物。 */
  prepare: (body: CrawlBody, who: CrawlRequester) => Promise<PreparedCrawl | RefusedCrawl>;
  /** 次の周回を待たずに 1 回回す。 */
  poke: () => void;
  minIntervalMinutes: number;
  now: () => Date;
}

interface CreateBody {
  name: string;
  cron: string;
  request: CrawlBody;
}

/** 行に残す撮り方。シークレットは宣言だけを持ち、回ごとに Windmill へ訊き直す。 */
const recipeOf = (prepared: PreparedCrawl): ScheduleRecipe => ({
  seeds: prepared.seeds,
  rules: prepared.rules,
  maxDepth: prepared.maxDepth,
  maxPages: prepared.maxPages,
  perHostDelayMs: prepared.perHostDelayMs,
  hostParallelism: prepared.hostParallelism,
  scripts: prepared.scripts,
  variables: prepared.variables,
  declaredSecrets: prepared.declaredSecrets,
  userAgent: prepared.userAgent,
});

/** 予定 1 つの答え。一覧と 1 本で同じ形にする。 */
const answerOf = (
  row: ScheduleRow,
  runs: readonly ScheduleRun[],
  running: { crawlId: string; startedAt: Date } | undefined,
  latest: LatestVersions,
  now: Date,
) => {
  const last = runs[0];
  const health = scheduleHealth({
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    runRequestedAt: row.runRequestedAt,
    lastRun: last === undefined ? null : { state: last.state, startedAt: last.startedAt },
    now,
  });
  const versions = row.request.scripts === undefined ? latest.byDefault : latest.named;
  const scripts = row.recipe.scripts.map((script) => ({
    id: script.id,
    version: script.version,
    // その場の TS は台帳に行が無いので null。新しい版の有無を言えない
    latest: versions.get(script.id) ?? null,
  }));
  // 待っている物があるか。状態の語は 1 つだけなので、語からは読まない (直近の回の失敗でも順番を待っていることがある)
  const waiting =
    row.runRequestedAt !== null || (row.enabled && row.nextRunAt.getTime() <= now.getTime());
  return {
    id: row.id,
    name: row.name,
    orgId: row.orgId,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    health,
    // 塞いでいる行。走ったままの回そのものか、この予定を待たせている走行中のクロール
    blockedBy: (health === "stuck" || waiting) && running !== undefined ? running : null,
    nextRunAt: row.nextRunAt,
    runRequestedAt: row.runRequestedAt,
    seeds: row.recipe.seeds.map((seed) => seed.normalized),
    maxDepth: row.recipe.maxDepth,
    maxPages: row.recipe.maxPages,
    scripts,
    outdated: scripts.some((script) => script.latest !== null && script.latest > script.version),
    pinnedAt: row.pinnedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    recentRuns: runs,
  };
};

const uuidParams = {
  type: "object",
  properties: { id: { type: "string", format: "uuid" } },
  required: ["id"],
} as const;

export const registerScheduleRoutes = (app: FastifyInstance, deps: ScheduleRouteDeps): void => {
  const { fga, resolveIdentity, store } = deps;

  const answerFor = async (row: ScheduleRow) => {
    const [runs, running, latest] = await Promise.all([
      store.recentRuns(row.id),
      store.runningCrawl(),
      store.latestVersions(),
    ]);
    return answerOf(row, runs, running, latest, deps.now());
  };

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });

  /** 名乗りと許可を見る。通らなければ答えを送って null を返す。 */
  const allowed = async (request: Parameters<IdentityResolver>[0], reply: FastifyReply) => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      await unauthorized(reply);
      return null;
    }
    if (!(await maySubmit(fga, identity))) {
      await notFound(reply);
      return null;
    }
    return identity;
  };

  /** 予定を作る。**頼みは `POST /api/crawls` と同じ確かめを通す** —— 断る理由も同じ本文で返す。 */
  app.post<{ Body: CreateBody }>(
    "/api/schedules",
    {
      bodyLimit: CRAWL_BODY_LIMIT,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "cron", "request"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: NAME_MAX },
            cron: { type: "string", minLength: 1, maxLength: CRON_MAX },
            request: CRAWL_BODY_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      const identity = await allowed(request, reply);
      if (identity === null) return reply;

      const name = request.body.name.trim();
      if (name === "") return reply.code(400).send({ error: "name must not be blank" });

      const now = deps.now();
      const cron = request.body.cron.trim();
      const checked = checkCron(cron, TIMEZONE, now, deps.minIntervalMinutes);
      if (checked.kind === "invalid") {
        return reply.code(400).send({ error: "invalid cron", hint: checked.reason });
      }
      if (checked.kind === "too-often") {
        return reply.code(400).send({
          error: "cron runs too often",
          gapMinutes: checked.gapMinutes,
          minIntervalMinutes: deps.minIntervalMinutes,
        });
      }

      const who = { orgId: identity.organizations[0] ?? "", subject: identity.subject };
      const prepared = await deps.prepare(request.body.request, who);
      if (prepared.kind === "refused") return reply.code(prepared.status).send(prepared.body);

      const created = await store.create({
        orgId: who.orgId,
        name,
        cron,
        nextRunAt: checked.next,
        request: request.body.request,
        recipe: recipeOf(prepared),
        createdBy: who.subject,
        now,
      });
      if (created.kind === "duplicate-name") {
        return reply.code(409).send({ error: "a schedule with this name already exists" });
      }
      log.info(
        { subject: who.subject, scheduleId: created.row.id, cron, next: checked.next },
        "Schedule created",
      );
      return reply.code(201).send(await answerFor(created.row));
    },
  );

  app.get("/api/schedules", async (request, reply) => {
    const identity = await resolveIdentity(request);
    if (!identity) return unauthorized(reply);
    if (!(await maySubmit(fga, identity))) return reply.code(200).send({ schedules: [] });

    const [rows, running, latest] = await Promise.all([
      store.list(),
      store.runningCrawl(),
      store.latestVersions(),
    ]);
    const now = deps.now();
    const schedules = await Promise.all(
      rows.map(async (row) => answerOf(row, await store.recentRuns(row.id), running, latest, now)),
    );
    return reply.code(200).send({ schedules });
  });

  app.get<{ Params: { id: string } }>(
    "/api/schedules/:id",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const identity = await allowed(request, reply);
      if (identity === null) return reply;
      const row = await store.get(request.params.id);
      if (row === undefined) return notFound(reply);
      return reply.code(200).send(await answerFor(row));
    },
  );

  /** 止める。走っている回はそのまま。 */
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/pause",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const identity = await allowed(request, reply);
      if (identity === null) return reply;
      const row = await store.pause(request.params.id);
      if (row === undefined) return notFound(reply);
      log.info({ subject: identity.subject, scheduleId: row.id }, "Schedule paused");
      return reply.code(200).send(await answerFor(row));
    },
  );

  /** 再開。次の期限を今から計算し直す。止めていた間は欠けに数えない。 */
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/resume",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const identity = await allowed(request, reply);
      if (identity === null) return reply;
      const current = await store.get(request.params.id);
      if (current === undefined) return notFound(reply);
      // 動いている予定は何も変えない (期限を計算し直すと順番待ちの回が消える)
      if (current.enabled) return reply.code(200).send(await answerFor(current));
      const row = await store.resume(
        current.id,
        nextRunAfter(current.cron, current.timezone, deps.now()),
      );
      if (row === undefined) return notFound(reply);
      log.info({ subject: identity.subject, scheduleId: row.id }, "Schedule resumed");
      return reply.code(200).send(await answerFor(row));
    },
  );

  /**
   * いま撮る。頼みを立てて周回を呼ぶだけで、始める道は 1 本。静かな時間は見ない。走行中なら順番待ちになる。
   * 止めた予定でも撮れる (人の頼みなので)。
   */
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/run",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const identity = await allowed(request, reply);
      if (identity === null) return reply;
      const row = await store.requestRun(request.params.id, deps.now());
      if (row === undefined) return notFound(reply);
      deps.poke();
      log.info({ subject: identity.subject, scheduleId: row.id }, "Schedule run requested");
      return reply.code(202).send(await answerFor(row));
    },
  );

  /** 固定し直す。頼みをいまの台帳で解決し直す。スクリプトが消えていれば、同じ理由で断る。 */
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/repin",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const identity = await allowed(request, reply);
      if (identity === null) return reply;
      const current = await store.get(request.params.id);
      if (current === undefined) return notFound(reply);
      const prepared = await deps.prepare(current.request, {
        orgId: current.orgId,
        subject: identity.subject,
      });
      if (prepared.kind === "refused") return reply.code(prepared.status).send(prepared.body);
      const row = await store.repin(current.id, recipeOf(prepared), deps.now());
      if (row === undefined) return notFound(reply);
      log.info({ subject: identity.subject, scheduleId: row.id }, "Schedule pinned again");
      return reply.code(200).send(await answerFor(row));
    },
  );

  /** 消す。行は残す (クロールの行に名前を出すため)。走っている回はそのまま。 */
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/delete",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const identity = await allowed(request, reply);
      if (identity === null) return reply;
      if (!(await store.softDelete(request.params.id, deps.now()))) return notFound(reply);
      log.info({ subject: identity.subject, scheduleId: request.params.id }, "Schedule deleted");
      return reply.code(200).send({ deleted: true });
    },
  );
};
