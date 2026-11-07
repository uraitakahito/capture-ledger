import { describe, expect, it } from "vitest";

import { scheduleStoreOf, type FirePlan, type ScheduleRow } from "../src/schedules/store.js";
import type { PreparedCrawl } from "../src/crawl/prepare.js";
import { recordingDb } from "./recording-db.js";

/**
 * 予定の窓口の SQL の形。**Kysely が実際に組んだ SQL を照らす。** 制約・ロック・rollback は
 * `src/tools/schedules-smoke.ts` が本物の Postgres で見る。
 */
const NOW = new Date("2026-11-07T00:36:00.000Z");
const ID = "11111111-1111-4111-8111-111111111111";
const CRAWL = "33333333-3333-4333-8333-333333333333";

const prepared: PreparedCrawl = {
  kind: "prepared",
  seeds: [
    {
      normalized: "https://site.test/",
      host: "site.test",
      hostname: "site.test",
      origin: "https://site.test",
    },
  ],
  rules: [{ follow: "same-origin" }],
  maxDepth: 0,
  maxPages: 30,
  perHostDelayMs: 2000,
  hostParallelism: 4,
  scripts: [],
  variables: {},
  secrets: {},
  declaredSecrets: [],
  userAgent: "",
};

const plan = (overrides: Partial<FirePlan> = {}): FirePlan => ({
  scheduleId: ID,
  crawlId: CRAWL,
  prepared,
  who: { orgId: "acme", subject: "alice" },
  sink: undefined,
  scheduledFor: new Date("2026-11-03T19:00:00.000Z"),
  missed: 3,
  nextRunAt: new Date("2026-11-07T19:00:00.000Z"),
  now: NOW,
  ...overrides,
});

describe("予定の窓口", () => {
  it("候補は消していない予定のうち、頼みか期限の来た物で、頼みを先に 1 つ", async () => {
    const { db, queries } = recordingDb([[]]);
    await scheduleStoreOf(db).candidate(NOW);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"deleted_at" is null');
    expect(sql).toContain('"run_requested_at" is not null');
    expect(sql).toContain('"enabled" = $1');
    expect(sql).toContain('"next_run_at" <= $2');
    expect(sql).toContain(
      "order by run_requested_at is null, coalesce(run_requested_at, next_run_at)",
    );
    expect(sql).toContain("limit $3");
    expect(parameters).toEqual([true, NOW, 1]);
  });

  it("一覧は消していない予定だけ", async () => {
    const { db, queries } = recordingDb([[]]);
    await scheduleStoreOf(db).list();
    expect(queries[0]!.sql).toContain('"deleted_at" is null');
    expect(queries[0]!.sql).toContain('order by "created_at"');
  });

  it("作るときは jsonb を文字列で書き、次の期限を入れる", async () => {
    const row = { id: ID } as ScheduleRow;
    const { db, queries } = recordingDb([[row]]);
    const answer = await scheduleStoreOf(db).create({
      orgId: "acme",
      name: "毎朝",
      cron: "0 4 * * *",
      nextRunAt: new Date("2026-11-07T19:00:00.000Z"),
      request: { seeds: ["https://site.test/"] },
      recipe: prepared,
      createdBy: "alice",
      now: NOW,
    });
    expect(answer.kind).toBe("created");
    expect(queries[0]!.sql).toContain('insert into "crawl_schedules"');
    expect(queries[0]!.parameters).toContain("2026-11-07T19:00:00.000Z");
    expect(queries[0]!.parameters).toContain('{"seeds":["https://site.test/"]}');
  });

  it("直近の回は予定で絞り、新しい順に 14 本。頁の失敗も数える", async () => {
    const { db, queries } = recordingDb([[]]);
    await scheduleStoreOf(db).recentRuns(ID);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"schedule_id" = $1');
    expect(sql).toContain("p.state = 'failed'");
    expect(sql).toContain('order by "started_at" desc');
    expect(parameters).toEqual([ID, 14]);
  });

  it("走行中の行を引く", async () => {
    const { db, queries } = recordingDb([[]]);
    await scheduleStoreOf(db).runningCrawl();
    expect(queries[0]!.sql).toContain('"state" = $1');
    expect(queries[0]!.parameters).toEqual(["running"]);
  });

  it("スクリプトの版は、名指しの最新と、省いた頼みが選ぶ有効な版の最新の 2 つ", async () => {
    const { db, queries } = recordingDb([
      [
        { id: "autoscroll", latest: 3, latestEnabled: 2 },
        { id: "autofetch", latest: 5, latestEnabled: null },
      ],
    ]);
    const latest = await scheduleStoreOf(db).latestVersions();
    expect(latest.named.get("autoscroll")).toBe(3);
    expect(latest.byDefault.get("autoscroll")).toBe(2);
    expect(latest.named.get("autofetch")).toBe(5);
    expect(latest.byDefault.has("autofetch")).toBe(false);
    expect(queries[0]!.sql).toContain("filter (where enabled)");
    expect(queries[0]!.sql).toContain('group by "id"');
  });

  describe("回を始める", () => {
    const seeded = [{ url: "https://site.test/", host: "site.test" }];

    it("1 つのトランザクションで、予定を掴み・行と起点を足し・次の回へ進める", async () => {
      const { db, queries } = recordingDb([[{ id: ID }], [], seeded, []]);
      const answer = await scheduleStoreOf(db).fire(plan());
      expect(answer).toEqual({ kind: "started", seeded });
      const sqls = queries.map((query) => query.sql);
      expect(sqls[0]).toBe("begin");
      expect(sqls[1]).toContain('from "crawl_schedules"');
      expect(sqls[1]).toContain("for update skip locked");
      expect(sqls[2]).toContain('insert into "crawls"');
      expect(sqls[2]).toContain('"schedule_id"');
      expect(sqls[2]).toContain('"scheduled_for"');
      expect(sqls[2]).toContain('"schedule_missed"');
      expect(sqls[3]).toContain('insert into "crawl_pages"');
      expect(sqls[4]).toContain('update "crawl_schedules"');
      expect(sqls[4]).toContain('"next_run_at" = $1');
      expect(sqls[4]).toContain('"run_requested_at" = $2');
      expect(queries[4]!.parameters.slice(0, 2)).toEqual(["2026-11-07T19:00:00.000Z", null]);
      expect(sqls[5]).toBe("commit");
    });

    it("いま撮る（次の期限が無い）は、期限を書かない", async () => {
      const { db, queries } = recordingDb([[{ id: ID }], [], seeded, []]);
      const manual = plan({ scheduledFor: null, missed: 0 });
      delete manual.nextRunAt;
      await scheduleStoreOf(db).fire(manual);
      const update = queries.find((query) => query.sql.includes('update "crawl_schedules"'))!;
      expect(update.sql).not.toContain('"next_run_at"');
      expect(update.sql).toContain('"run_requested_at"');
    });

    it("掴めなければ何も足さない", async () => {
      const { db, queries } = recordingDb([[]]);
      expect(await scheduleStoreOf(db).fire(plan())).toEqual({ kind: "gone" });
      expect(queries.some((query) => query.sql.includes("insert into"))).toBe(false);
    });

    it("始められなかった回は failed の行にして、次の回へ進める", async () => {
      const { db, queries } = recordingDb([[{ id: ID }], [], []]);
      const answer = await scheduleStoreOf(db).fire(plan({ failure: "unknown secrets: token" }));
      expect(answer).toEqual({ kind: "failed" });
      const insert = queries.find((query) => query.sql.includes('insert into "crawls"'))!;
      expect(insert.parameters).toContain("failed");
      expect(insert.parameters).toContain("unknown secrets: token");
      // 終わりの時刻は DB の時計 (周回の時計だと始まりより前になりうる)
      expect(insert.sql).toContain("now()");
      expect(queries.some((query) => query.sql.includes('insert into "crawl_pages"'))).toBe(false);
      expect(queries.some((query) => query.sql.includes('update "crawl_schedules"'))).toBe(true);
    });
  });

  it("止める・再開・頼み・固定し直す・消すは、消していない行だけ", async () => {
    const { db, queries } = recordingDb([[], [], [], [], []]);
    const store = scheduleStoreOf(db);
    await store.pause(ID);
    await store.resume(ID, NOW);
    await store.requestRun(ID, NOW);
    await store.repin(ID, prepared, NOW);
    expect(await store.softDelete(ID, NOW)).toBe(false);
    expect(queries).toHaveLength(5);
    for (const { sql } of queries) {
      expect(sql).toContain('update "crawl_schedules"');
      expect(sql).toContain('"deleted_at" is null');
    }
  });

  it("止めるときは待っている頼みも消す", async () => {
    const { db, queries } = recordingDb([[]]);
    await scheduleStoreOf(db).pause(ID);
    expect(queries[0]!.sql).toContain('"enabled" = $1');
    expect(queries[0]!.sql).toContain('"run_requested_at" = $2');
    expect(queries[0]!.parameters.slice(0, 2)).toEqual([false, null]);
  });

  it("再開は止めた予定だけを書く", async () => {
    const { db, queries } = recordingDb([[]]);
    await scheduleStoreOf(db).resume(ID, NOW);
    expect(queries[0]!.sql).toMatch(/"enabled" = \$\d+ returning/);
  });

  it("再開は有効にして渡した期限を入れる", async () => {
    const { db, queries } = recordingDb([[]]);
    await scheduleStoreOf(db).resume(ID, new Date("2026-11-07T19:00:00.000Z"));
    expect(queries[0]!.sql).toContain('"enabled" = $1');
    expect(queries[0]!.parameters.slice(0, 2)).toEqual([true, "2026-11-07T19:00:00.000Z"]);
  });

  it("消すときは待っている頼みも消す", async () => {
    const { db, queries } = recordingDb([[{ id: ID }]]);
    expect(await scheduleStoreOf(db).softDelete(ID, NOW)).toBe(true);
    expect(queries[0]!.sql).toContain('"deleted_at" = $1');
    expect(queries[0]!.sql).toContain('"run_requested_at" = $2');
  });
});
