#!/usr/bin/env node
/**
 * 定期実行の窓口と周回を、本物の Postgres に当てる。
 *
 * 試験は DB を立てない。`test/recording-db.ts` は Kysely が組んだ SQL を記録するが、次のことは見られない。
 * **それを見るのは、ここだけ。**
 *
 *   - 走行中の 1 本の一意の索引 (`crawls_single_active`) とぶつかったときに、トランザクションごと戻ること
 *   - `FOR UPDATE SKIP LOCKED` が、別の者の持っている予定を飛ばすこと
 *   - 名前の部分 unique index (消した名前は使い直せる)
 *   - jsonb と timestamptz と `::int` が、読み返して同じ形であること
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build:tools && DATABASE_URL=postgres://… node dist/tools/schedules-smoke.js
 *
 * **向ける DB は使い捨てのものにすること。** 走行中の 1 本を自分で立てるので、共有の DB に向けると本物のクロールと
 * ぶつかる。走行中の行が既に在れば何もせずに止まる。自分の予定 (`smoke-<pid>`) とその回だけを足して最後に消す。
 *
 * どれか 1 つでも期待と違えば、全部を並べてから終了コード 1。
 */
import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { PreparedCrawl } from "../crawl/prepare.js";
import { parseCaptureFormats } from "../config/capture-formats.js";
import type { ScheduleRecipe } from "../db/database.js";
import { createKyselyClient } from "../db/kysely.js";
import { scheduleHealth } from "../schedules/health.js";
import { scheduleStoreOf, type FirePlan, type ScheduleRow } from "../schedules/store.js";
import { tickSchedules, type TickDeps } from "../schedules/tick.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

const db = createKyselyClient(databaseUrl);
const store = scheduleStoreOf(db);
const org = `smoke-${String(process.pid)}`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

const running = await store.runningCrawl();
if (running !== undefined) {
  console.error(`走行中のクロール ${running.crawlId} が在る。使い捨ての DB を指して走らせること`);
  await db.destroy();
  process.exit(1);
}

const SEED = "https://site.test/";
const recipe = (): ScheduleRecipe => ({
  seeds: [
    {
      normalized: SEED,
      host: "site.test",
      hostname: "site.test",
      origin: "https://site.test",
    },
  ],
  rules: [{ follow: "same-origin" }],
  maxDepth: 0,
  maxPages: 30,
  perHostDelayMs: 0,
  hostParallelism: 1,
  scripts: [],
  // `_` を含む鍵が読み返して化けないこと (kysely.ts の CamelCasePlugin の注)
  variables: { api_token_name: "値" },
  declaredSecrets: [],
  userAgent: "",
});

const create = async (name: string, nextRunAt: Date, now: Date): Promise<ScheduleRow> => {
  const created = await store.create({
    orgId: org,
    name,
    cron: "0 4 * * *",
    nextRunAt,
    request: { seeds: [SEED], maxDepth: 0, scripts: [] },
    recipe: recipe(),
    createdBy: org,
    now,
  });
  if (created.kind !== "created") throw new Error(`作れなかった: ${name}`);
  return created.row;
};

const dispatched: string[] = [];
const tickDeps = (now: Date, overrides: Partial<TickDeps> = {}): TickDeps => ({
  store,
  capture: parseCaptureFormats("wacz", false),
  dispatchLevel: (level) => {
    dispatched.push(level.crawlId);
  },
  startedAt: new Date(now.getTime() - 3_600_000),
  quietMs: 0,
  now: () => now,
  ...overrides,
});

const crawlOf = async (id: string) =>
  id === ""
    ? undefined
    : db.selectFrom("crawls").selectAll().where("id", "=", id).executeTakeFirst();
const closeCrawl = async (id: string) => {
  await db
    .updateTable("crawls")
    .set({ state: "succeeded", stopReason: "completed", finishedAt: new Date().toISOString() })
    .where("id", "=", id)
    .execute();
};
const iso = (date: Date | null | undefined) => date?.toISOString() ?? String(date);

const preparedOf = (row: ScheduleRow): PreparedCrawl => ({
  ...row.recipe,
  kind: "prepared",
  secrets: {},
});
const planOf = (row: ScheduleRow, now: Date, overrides: Partial<FirePlan> = {}): FirePlan => ({
  scheduleId: row.id,
  crawlId: randomUUID(),
  prepared: preparedOf(row),
  who: { orgId: row.orgId, subject: row.createdBy },
  sink: undefined,
  scheduledFor: row.nextRunAt,
  missed: 0,
  nextRunAt: new Date(now.getTime() + 86_400_000),
  now,
  ...overrides,
});

try {
  // 周回の時計は渡した値で動くが、`crawls.started_at` は DB の時計。遠い未来に置けば、行が「たったいま」に見えない
  const now = new Date("2099-11-07T00:36:00.000Z"); // 09:36 JST
  const day = 86_400_000;

  // ── 名前 ───────────────────────────────────────────────
  const first = await create(`${org}-a`, new Date(now.getTime() + day), now);
  const again = await store.create({
    orgId: org,
    name: `${org}-a`,
    cron: "0 4 * * *",
    nextRunAt: now,
    request: { seeds: [SEED] },
    recipe: recipe(),
    createdBy: org,
    now,
  });
  check("同じ組織に同じ名前は作れない", again.kind === "duplicate-name", again.kind);

  // ── 読み返し ───────────────────────────────────────────
  const read = await store.get(first.id);
  check(
    "jsonb の鍵は読み返しても化けない",
    read?.recipe.variables["api_token_name"] === "値",
    JSON.stringify(read?.recipe.variables),
  );
  check("timezone の既定は Asia/Tokyo", read?.timezone === "Asia/Tokyo", String(read?.timezone));

  // ── 候補 ───────────────────────────────────────────────
  check("期限の前は候補にならない", (await store.candidate(now)) === undefined);
  const due = await create(`${org}-due`, new Date("2099-11-03T19:00:00.000Z"), now); // 11-04 04:00 JST
  const picked = await store.candidate(now);
  check("期限の来た予定は候補になる", picked?.id === due.id, String(picked?.id));

  // ── SKIP LOCKED ────────────────────────────────────────
  const locked = await db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("crawlSchedules")
      .select("id")
      .where("id", "=", due.id)
      .forUpdate()
      .execute();
    return store.fire(planOf(due, now));
  });
  check("別の者が持っている予定は飛ばす (gone)", locked.kind === "gone", locked.kind);

  // ── 周回が始める ───────────────────────────────────────
  const started = await tickSchedules(tickDeps(now));
  check("周回が期限の来た予定を始める", started.kind === "started", JSON.stringify(started));
  if (started.kind !== "started") throw new Error(`始まらなかった: ${JSON.stringify(started)}`);
  const crawlId = started.crawlId;
  const crawl = await crawlOf(crawlId);
  check("行に予定の id が入る", crawl?.scheduleId === due.id, String(crawl?.scheduleId));
  check(
    "本来の時刻が残る",
    iso(crawl?.scheduledFor) === "2099-11-03T19:00:00.000Z",
    iso(crawl?.scheduledFor),
  );
  check(
    "欠けの数が残る (11-05・11-06・11-07)",
    crawl?.scheduleMissed === 3,
    String(crawl?.scheduleMissed),
  );
  const advanced = await store.get(due.id);
  check(
    "次の回へ進む (11-08 04:00 JST)",
    iso(advanced?.nextRunAt) === "2099-11-07T19:00:00.000Z",
    iso(advanced?.nextRunAt),
  );
  const pages = await db
    .selectFrom("crawlPages")
    .select(["url", "depth", "state"])
    .where("crawlId", "=", crawlId)
    .execute();
  check(
    "起点のページが足される",
    pages.length === 1 && pages[0]?.url === SEED,
    JSON.stringify(pages),
  );
  check("webhook は commit の後に投げる", dispatched.includes(crawlId));

  // ── 順番待ち ───────────────────────────────────────────
  const waiting = await create(`${org}-waiting`, new Date(now.getTime() - 60_000), now);
  const tickWhileRunning = await tickSchedules(tickDeps(now));
  check(
    "走行中は周回が何もしない",
    tickWhileRunning.kind === "idle" && tickWhileRunning.why === "running",
    JSON.stringify(tickWhileRunning),
  );
  // 手前の確かめをすり抜けた形。索引とぶつかったら、トランザクションごと戻ること
  const planned = planOf(waiting, now);
  const busy = await store.fire(planned);
  check("走行中の行とぶつかると busy", busy.kind === "busy", busy.kind);
  const unchanged = await store.get(waiting.id);
  check(
    "ぶつかった予定の期限は動かない",
    iso(unchanged?.nextRunAt) === iso(waiting.nextRunAt),
    iso(unchanged?.nextRunAt),
  );
  check("ぶつかった回の行は残らない", (await crawlOf(planned.crawlId)) === undefined);

  // ── 直近の回 ───────────────────────────────────────────
  const runs = await store.recentRuns(due.id);
  check("回を読める", runs.length === 1 && runs[0]?.crawlId === crawlId, JSON.stringify(runs));
  check("頁の失敗の数は数で返る", runs[0]?.pagesFailed === 0, JSON.stringify(runs[0]?.pagesFailed));
  const failedPage = await db
    .selectFrom("crawlPages")
    .select("id")
    .where("crawlId", "=", crawlId)
    .executeTakeFirst();
  if (failedPage !== undefined) {
    await db
      .updateTable("crawlPages")
      .set({ state: "failed" })
      .where("id", "=", failedPage.id)
      .execute();
  }
  const runsAfter = await store.recentRuns(due.id);
  check("頁の失敗を数える", runsAfter[0]?.pagesFailed === 1, String(runsAfter[0]?.pagesFailed));

  await closeCrawl(crawlId);

  // ── 順番待ちが解けたら始まる ───────────────────────────
  const after = await tickSchedules(tickDeps(now));
  check(
    "走行中の行が終われば、待っていた予定が始まる",
    after.kind === "started" && after.scheduleId === waiting.id,
    JSON.stringify(after),
  );
  if (after.kind === "started") await closeCrawl(after.crawlId);

  // ── いま撮る ───────────────────────────────────────────
  const manual = await create(`${org}-manual`, new Date(now.getTime() + day), now);
  await store.requestRun(manual.id, now);
  const quiet = tickDeps(now, { quietMs: 86_400_000, startedAt: now });
  const manualTick = await tickSchedules(quiet);
  check("いま撮るは静かな時間を見ない", manualTick.kind === "started", JSON.stringify(manualTick));
  const manualId = manualTick.kind === "started" ? manualTick.crawlId : "";
  const manualCrawl = await crawlOf(manualId);
  check(
    "いま撮るの回は本来の時刻が null",
    manualCrawl?.scheduledFor === null,
    iso(manualCrawl?.scheduledFor),
  );
  const manualAfter = await store.get(manual.id);
  check("いま撮るは期限を動かさない", iso(manualAfter?.nextRunAt) === iso(manual.nextRunAt));
  check("いま撮るの頼みは消える", manualAfter?.runRequestedAt === null);
  await closeCrawl(manualId);

  // ── 静かな時間 ─────────────────────────────────────────
  const calm = await create(`${org}-calm`, new Date(now.getTime() - 60_000), now);
  const quietTick = await tickSchedules(
    tickDeps(now, { quietMs: 600_000, startedAt: new Date(now.getTime() - 60_000) }),
  );
  check(
    "静かな時間の間は始めない",
    quietTick.kind === "idle" && quietTick.why === "quiet",
    JSON.stringify(quietTick),
  );

  // ── 止める ─────────────────────────────────────────────
  await store.pause(calm.id);
  check("止めた予定は期限が来ても候補にならない", (await store.candidate(now)) === undefined);
  await store.requestRun(calm.id, now);
  const pausedPick = await store.candidate(now);
  check("止めた予定もいま撮るなら候補になる", pausedPick?.id === calm.id, String(pausedPick?.id));
  const pausedTick = await tickSchedules(tickDeps(now));
  check("止めた予定をいま撮ると始まる", pausedTick.kind === "started", JSON.stringify(pausedTick));
  const pausedAfter = await store.get(calm.id);
  check("止めた予定の回は期限を動かさない", iso(pausedAfter?.nextRunAt) === iso(calm.nextRunAt));
  if (pausedTick.kind === "started") await closeCrawl(pausedTick.crawlId);
  const nextRun = new Date(now.getTime() + day);
  const resumed = await store.resume(calm.id, nextRun);
  check(
    "再開は渡した期限で動き出す",
    resumed?.enabled === true && iso(resumed.nextRunAt) === iso(nextRun),
  );

  // ── シークレットが足りない ─────────────────────────────
  const secret = await create(`${org}-secret`, new Date(now.getTime() - 60_000), now);
  await db
    .updateTable("crawlSchedules")
    .set({
      recipe: JSON.stringify({
        ...recipe(),
        declaredSecrets: [
          { name: "token", path: "f/waggle_secrets/token", required: true, declaredBy: ["a"] },
        ],
      }),
    })
    .where("id", "=", secret.id)
    .execute();
  const failedTick = await tickSchedules(tickDeps(now));
  check(
    "シークレットを訊けなければ failed の行を足す",
    failedTick.kind === "failed",
    JSON.stringify(failedTick),
  );
  const failedId = failedTick.kind === "failed" ? failedTick.crawlId : "";
  const failedRow = await crawlOf(failedId);
  check(
    "failed の行に理由が残る",
    failedRow?.state === "failed" && (failedRow.error ?? "") !== "",
    String(failedRow?.error),
  );
  const secretAfter = await store.get(secret.id);
  check(
    "始められなくても次の回へ進む",
    (secretAfter?.nextRunAt.getTime() ?? 0) > now.getTime(),
    iso(secretAfter?.nextRunAt),
  );
  const secretRuns = await store.recentRuns(secret.id);
  const health = scheduleHealth({
    enabled: true,
    nextRunAt: secretAfter?.nextRunAt ?? now,
    runRequestedAt: null,
    lastRun:
      secretRuns[0] === undefined
        ? null
        : { state: secretRuns[0].state, startedAt: secretRuns[0].startedAt },
    now,
  });
  check("その予定の状態は failing", health === "failing", health);

  // ── 撮り方の固定 ───────────────────────────────────────
  const pinned = recipe();
  pinned.maxPages = 99;
  const repinned = await store.repin(manual.id, pinned, now);
  check(
    "固定し直すと撮り方が替わる",
    repinned?.recipe.maxPages === 99 && iso(repinned.pinnedAt) === iso(now),
  );

  // ── 消す ───────────────────────────────────────────────
  check("消すと true", await store.softDelete(first.id, now));
  check("消した予定は読めない", (await store.get(first.id)) === undefined);
  check("消した予定をもう 1 度消すと false", !(await store.softDelete(first.id, now)));
  const reused = await create(`${org}-a`, new Date(now.getTime() + day), now);
  check("消した名前は使い直せる", reused.name === `${org}-a`);

  // ── 版 ─────────────────────────────────────────────────
  const latest = await store.latestVersions();
  check(
    "スクリプトの版は数で返る",
    [...latest.values()].every((version) => typeof version === "number"),
  );
} finally {
  // 回 → 予定の順に消す (参照がある)。自分の組織の物だけ
  await sql`delete from crawl_pages where crawl_id in (select id from crawls where org_id = ${org})`.execute(
    db,
  );
  await sql`delete from crawls where org_id = ${org}`.execute(db);
  await sql`delete from crawl_schedules where org_id = ${org}`.execute(db);
  await db.destroy();
}

for (const { name, ok, detail } of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` —— ${detail}`}`);
}
const failed = results.filter((result) => !result.ok).length;
if (failed > 0) {
  console.error(`\n${String(failed)} 件が期待と違う (${String(results.length)} 件中)`);
  process.exit(1);
}
console.log(
  `✓ schedules smoke: ${String(results.length)} 件とも期待どおり (組織 ${org} の行は消した)`,
);
