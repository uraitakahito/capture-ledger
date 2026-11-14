/**
 * 定期実行の周回。**時計は capture-ledger の中に在る。**
 *
 * 30 秒ごとに予定の表を見て、始めてよい予定を 1 つだけ始める。走れるクロールは全体で 1 本なので、1 度に 1 つで
 * 足りる。待っている間は期限を動かさず、「見送り」という結末を作らない。終わった後の周回で始まる。
 *
 * ## 静かな時間
 *
 * API の起動と直近のクロールから `quietMs` が過ぎるまで、期限の来た予定を始めない。`dev:up` は API の後に
 * トークンを発行し直すので、起動の直後に始めると古いトークンで走る。e2e の間も、直近のクロールが新しいので割り込まない。
 * 「いま撮る」は人の頼みなので、静けさを見ない。
 *
 * ## 順番
 *
 * 秘密を解く (Windmill に訊く) → 1 つのトランザクションで行を足して期限を進める → commit の後で webhook。
 * 行のロックを持ったまま外へ訊きに行かないため、秘密が先。投げられなければ行を failed で閉じる (`levelDispatcher`)。
 *
 * ## 走ったまま止まった行
 *
 * 勝手に閉じない。本当に走っている回を閉じないため。`health.ts` の `stuck` と画面の「締める」に任せる。
 */
import { randomUUID } from "node:crypto";

import type { SinkConfig } from "../api/sink.js";
import type { CaptureSettings } from "../config/capture-formats.js";
import type { DispatchedCrawl } from "../crawl/launch.js";
import { resolveSecrets, type PreparedCrawl, type RefusedCrawl } from "../crawl/prepare.js";
import type { WindmillVariables } from "../crawl/windmill-variables.js";
import type { CrawlSecret } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import { missedSince, nextRunAfter } from "./cron.js";
import type { FirePlan, FireResult, ScheduleStore } from "./store.js";

const log = createChildLogger({ module: "schedules" });

/** 周回の間隔。予定の周期の下限 (既定 60 分) より十分短ければよい。 */
export const TICK_INTERVAL_MS = 30_000;

export interface TickDeps {
  store: ScheduleStore;
  capture: CaptureSettings;
  sink?: SinkConfig;
  windmill?: WindmillVariables;
  dispatchLevel: (level: DispatchedCrawl) => void;
  /** API が起動した時刻。 */
  startedAt: Date;
  quietMs: number;
  now: () => Date;
}

export type TickResult =
  | { kind: "idle"; why: "running" | "nothing" | "quiet" }
  | { kind: "started"; scheduleId: string; crawlId: string }
  | { kind: "failed"; scheduleId: string; crawlId: string; error: string }
  | { kind: "busy"; scheduleId: string }
  | { kind: "gone"; scheduleId: string };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 断られた答えを、行の `error` に残す 1 行にする。 */
const refusalText = ({ status, body }: RefusedCrawl): string => {
  const secrets = body["secrets"];
  const names = body["names"];
  const named = Array.isArray(secrets)
    ? secrets.map((secret: { name?: unknown }) => String(secret.name))
    : Array.isArray(names)
      ? names.map(String)
      : [];
  const error = typeof body["error"] === "string" ? body["error"] : `refused (${String(status)})`;
  return named.length > 0 ? `${error}: ${named.join(", ")}` : error;
};

/** 周回の 1 回。試験はこれを 1 回ずつ呼ぶ。 */
export const tickSchedules = async (deps: TickDeps): Promise<TickResult> => {
  const { store, sink } = deps;
  const now = deps.now();

  // 本当の守りは一意の索引。ここは毎回トランザクションを開いて rollback しないための手前の確かめ
  if ((await store.runningCrawl()) !== undefined) return { kind: "idle", why: "running" };

  const row = await store.candidate(now);
  if (row === undefined) return { kind: "idle", why: "nothing" };

  if (row.runRequestedAt === null) {
    const last = await store.lastCrawlStartedAt();
    const calmSince = Math.max(deps.startedAt.getTime(), last?.getTime() ?? 0);
    if (now.getTime() - calmSince < deps.quietMs) return { kind: "idle", why: "quiet" };
  }

  // 期限が来ているなら、頼みがあっても本来の回として始める (頼みの回と期限の回が続けて 2 本走らないように)
  const isDue = row.enabled && row.nextRunAt.getTime() <= now.getTime();
  const who = { orgId: row.orgId, subject: row.createdBy };
  const crawlId = randomUUID();

  // **この予定の問題で、周回を止めない。** Windmill の変な答えや大きすぎる行で投げたまま次の周回へ渡すと、同じ予定を
  // 選び続けて、ほかの予定も始まらない。どれも failed の行にして次の回へ進める
  let secrets: Record<string, CrawlSecret> = {};
  let failure: string | undefined;
  try {
    // 隠すシークレットと配備の形式の組み合わせも、ここで回ごとに見る (Windmill に置かれたシークレットは回で変わる)
    const answer = await resolveSecrets(
      deps.windmill,
      row.recipe.declaredSecrets,
      who.subject,
      deps.capture.formats,
    );
    if (answer.kind === "resolved") secrets = answer.secrets;
    else failure = refusalText(answer);
  } catch (err) {
    failure = `could not ask about secrets: ${messageOf(err)}`;
  }
  // `040` より前に作った予定の撮り方には `recordRandom` が無い。頼んでいないので false
  const prepared: PreparedCrawl = {
    ...row.recipe,
    kind: "prepared",
    secrets,
    recordRandom: row.recipe.recordRandom ?? false,
  };

  const plan: FirePlan = {
    scheduleId: row.id,
    crawlId,
    prepared,
    who,
    capture: deps.capture,
    sink,
    scheduledFor: isDue ? row.nextRunAt : null,
    missed: isDue ? missedSince(row.cron, row.timezone, row.nextRunAt, now) : 0,
    // 「いま撮る」は書かない。止めた予定の古い期限で、その間の再開を上書きしないため
    ...(isDue && { nextRunAt: nextRunAfter(row.cron, row.timezone, now) }),
    ...(failure !== undefined && { failure }),
    now,
  };
  let result: FireResult;
  try {
    result = await store.fire(plan);
  } catch (err) {
    if (failure !== undefined) throw err;
    failure = `could not start: ${messageOf(err)}`;
    log.error({ err, scheduleId: row.id, crawlId }, "Schedule could not add its crawl");
    result = await store.fire({ ...plan, failure });
  }

  switch (result.kind) {
    case "started":
      deps.dispatchLevel(result.level);
      log.info(
        { scheduleId: row.id, crawlId, scheduledFor: isDue ? row.nextRunAt : null },
        "Schedule started a crawl",
      );
      return { kind: "started", scheduleId: row.id, crawlId };
    case "failed":
      log.warn({ scheduleId: row.id, crawlId, error: failure }, "Schedule could not start a crawl");
      return { kind: "failed", scheduleId: row.id, crawlId, error: failure ?? "" };
    case "busy":
      return { kind: "busy", scheduleId: row.id };
    case "gone":
      return { kind: "gone", scheduleId: row.id };
  }
};

export interface ScheduleClock {
  /** `listen` の後に呼ぶ。 */
  start(): void;
  /** 「いま撮る」の後に、次の周回を待たずに 1 回回す。走っている最中なら次の周回に任せる。 */
  poke(): void;
  /** 止めて、走っている周回の終わりを待つ。 */
  stop(): Promise<void>;
}

export const scheduleClock = (deps: TickDeps, intervalMs = TICK_INTERVAL_MS): ScheduleClock => {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const run = (): void => {
    if (running !== undefined) return;
    running = tickSchedules(deps)
      .then(
        (result) => {
          if (result.kind === "busy" || result.kind === "gone") {
            log.info(result, "Schedule was not started");
          }
        },
        // **周回の例外で API を落とさない。** 次の周回でまた見る
        (err: unknown) => {
          log.error({ err }, "Schedule tick failed");
        },
      )
      .finally(() => {
        running = undefined;
      });
  };

  return {
    start() {
      timer = setInterval(run, intervalMs);
      // タイマーのためだけに event loop を開いたままにしない
      timer.unref();
    },
    poke: run,
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
};
