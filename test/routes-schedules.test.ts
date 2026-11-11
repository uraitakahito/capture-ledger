import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";

import { registerScheduleRoutes, type ScheduleRouteDeps } from "../src/api/schedules.js";
import type { PreparedCrawl, RefusedCrawl } from "../src/crawl/prepare.js";
import type { ScheduleRecipe } from "../src/db/database.js";
import type {
  CreateResult,
  NewSchedule,
  ScheduleRow,
  ScheduleRun,
  ScheduleStore,
} from "../src/schedules/store.js";

const jst = (text: string) => new Date(`${text}+09:00`);
const NOW = jst("2026-11-07T14:10:00");
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

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
  scripts: [
    {
      id: "autoscroll",
      version: 2,
      phase: "behavior",
      source: "x",
      sha256: "a".repeat(64),
      options: {},
      sites: [],
      params: [],
    } as unknown as PreparedCrawl["scripts"][number],
  ],
  variables: {},
  secrets: { token: { path: "f/waggle_secrets/token", editedAt: "t", rotated: null } },
  declaredSecrets: [
    { name: "token", path: "f/waggle_secrets/token", required: true, declaredBy: ["x"] },
  ],
  userAgent: "",
};

const recipe: ScheduleRecipe = {
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
};

const rowOf = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: ID,
  orgId: "acme",
  name: "毎朝",
  cron: "0 4 * * *",
  timezone: "Asia/Tokyo",
  enabled: true,
  nextRunAt: jst("2026-11-08T04:00:00"),
  runRequestedAt: null,
  request: { seeds: ["https://site.test/"] },
  recipe,
  pinnedAt: NOW,
  createdBy: "alice",
  createdAt: NOW,
  deletedAt: null,
  ...overrides,
});

const runOf = (overrides: Partial<ScheduleRun> = {}): ScheduleRun => ({
  crawlId: OTHER,
  state: "succeeded",
  scheduledFor: jst("2026-11-07T04:00:00"),
  startedAt: jst("2026-11-07T04:00:10"),
  finishedAt: jst("2026-11-07T04:01:10"),
  scheduleMissed: 0,
  pagesCaptured: 5,
  pagesFailed: 0,
  error: null,
  change: null,
  ...overrides,
});

const fakeStore = () => {
  const rows = new Map<string, ScheduleRow>();
  const created: NewSchedule[] = [];
  let runs: ScheduleRun[] = [];
  let running: { crawlId: string; startedAt: Date } | undefined;
  let createAnswer: CreateResult | undefined;
  const latestNamed = new Map([["autoscroll", 2]]);
  const latestByDefault = new Map([["autoscroll", 2]]);
  const store = {
    create: (schedule: NewSchedule) => {
      created.push(schedule);
      if (createAnswer !== undefined) return Promise.resolve(createAnswer);
      const row = rowOf({ nextRunAt: schedule.nextRunAt, name: schedule.name });
      rows.set(row.id, row);
      return Promise.resolve({ kind: "created", row });
    },
    list: () => Promise.resolve([...rows.values()]),
    get: (id: string) => Promise.resolve(rows.get(id)),
    recentRuns: () => Promise.resolve(runs),
    runningCrawl: () => Promise.resolve(running),
    latestVersions: () => Promise.resolve({ named: latestNamed, byDefault: latestByDefault }),
    pause: (id: string) => {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(undefined);
      row.enabled = false;
      return Promise.resolve(row);
    },
    resume: (id: string, nextRunAt: Date) => {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(undefined);
      row.enabled = true;
      row.nextRunAt = nextRunAt;
      return Promise.resolve(row);
    },
    requestRun: (id: string, now: Date) => {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(undefined);
      row.runRequestedAt = now;
      return Promise.resolve(row);
    },
    repin: (id: string, next: ScheduleRecipe, now: Date) => {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(undefined);
      row.recipe = next;
      row.pinnedAt = now;
      return Promise.resolve(row);
    },
    softDelete: (id: string) => Promise.resolve(rows.delete(id)),
  } as unknown as ScheduleStore;
  return {
    store,
    rows,
    created,
    setRuns: (value: ScheduleRun[]) => {
      runs = value;
    },
    setRunning: (value: { crawlId: string; startedAt: Date }) => {
      running = value;
    },
    answerCreate: (value: CreateResult) => {
      createAnswer = value;
    },
    latestNamed,
    latestByDefault,
  };
};

const VALID = { name: "毎朝", cron: "0 4 * * *", request: { seeds: ["https://site.test/"] } };

describe("定期実行のエンドポイント", () => {
  let app: FastifyInstance;
  let fake: ReturnType<typeof fakeStore>;
  let poke: ReturnType<typeof vi.fn>;
  let prepare: ReturnType<typeof vi.fn>;
  let allowed: boolean;
  let named: boolean;

  beforeEach(async () => {
    fake = fakeStore();
    poke = vi.fn();
    prepare = vi.fn(() => Promise.resolve<PreparedCrawl | RefusedCrawl>(prepared));
    allowed = true;
    named = true;
    app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    const deps: ScheduleRouteDeps = {
      fga: {
        check: () => Promise.resolve({ allowed }),
      } as unknown as OpenFgaClient,
      resolveIdentity: () =>
        Promise.resolve(named ? { subject: "alice", organizations: ["acme"] } : undefined),
      store: fake.store,
      prepare: prepare as unknown as ScheduleRouteDeps["prepare"],
      poke: poke as unknown as () => void,
      minIntervalMinutes: 60,
      now: () => NOW,
    };
    registerScheduleRoutes(app, deps);
    await app.ready();
  });

  const post = (url: string, payload?: object) =>
    app.inject({ method: "POST", url, ...(payload && { payload }) });

  describe("許可", () => {
    it("名乗らなければ 401", async () => {
      named = false;
      expect((await post("/api/schedules", VALID)).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/schedules" })).statusCode).toBe(401);
    });

    it("許されていなければ、作るのも操作も 404", async () => {
      allowed = false;
      fake.rows.set(ID, rowOf());
      expect((await post("/api/schedules", VALID)).statusCode).toBe(404);
      for (const action of ["pause", "resume", "run", "repin", "delete"]) {
        expect((await post(`/api/schedules/${ID}/${action}`)).statusCode).toBe(404);
      }
      expect(fake.rows.get(ID)?.enabled).toBe(true);
      expect(poke).not.toHaveBeenCalled();
    });

    it("許されていなければ、一覧は 200 の空", async () => {
      allowed = false;
      fake.rows.set(ID, rowOf());
      const res = await app.inject({ url: "/api/schedules" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ schedules: [] });
    });
  });

  describe("作る", () => {
    it("確かめを通して、次の回と固定した撮り方で作る", async () => {
      const res = await post("/api/schedules", VALID);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        name: "毎朝",
        health: "ok",
        nextRunAt: jst("2026-11-08T04:00:00").toISOString(),
      });
      expect(prepare).toHaveBeenCalledWith(VALID.request, { orgId: "acme", subject: "alice" });
      const created = fake.created[0];
      expect(created?.nextRunAt).toEqual(jst("2026-11-08T04:00:00"));
      expect(created?.recipe.declaredSecrets).toEqual(prepared.declaredSecrets);
      // シークレットの更新時刻は回ごとに訊き直すので、行に残さない
      expect(created?.recipe).not.toHaveProperty("secrets");
      expect(created?.recipe).not.toHaveProperty("kind");
    });

    it("名前の前後の空白は落とし、空白だけなら 400", async () => {
      await post("/api/schedules", { ...VALID, name: "  毎朝  " });
      expect(fake.created[0]?.name).toBe("毎朝");
      const blank = await post("/api/schedules", { ...VALID, name: "   " });
      expect(blank.statusCode).toBe(400);
      expect(blank.json()).toEqual({ error: "name must not be blank" });
    });

    it("読めない cron は 400 で、確かめまで行かない", async () => {
      const res = await post("/api/schedules", { ...VALID, cron: "61 4 * * *" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid cron" });
      expect(prepare).not.toHaveBeenCalled();
    });

    it("6 欄の cron は 400", async () => {
      const res = await post("/api/schedules", { ...VALID, cron: "0 0 4 * * *" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid cron" });
    });

    it("周期の下限より短い cron は 400 で、間隔と下限を言う", async () => {
      const res = await post("/api/schedules", { ...VALID, cron: "*/5 * * * *" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "cron runs too often",
        gapMinutes: 5,
        minIntervalMinutes: 60,
      });
    });

    it("頼みの確かめに断られたら、同じ状態と本文を返す", async () => {
      prepare.mockResolvedValueOnce({
        kind: "refused",
        status: 400,
        body: { error: "every seed must be an http(s) URL" },
      });
      const res = await post("/api/schedules", VALID);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "every seed must be an http(s) URL" });
      expect(fake.created).toHaveLength(0);
    });

    it("型の検査が答えなければ 503 のまま返す", async () => {
      prepare.mockResolvedValueOnce({
        kind: "refused",
        status: 503,
        body: { error: "ts-compile unreachable" },
      });
      expect((await post("/api/schedules", VALID)).statusCode).toBe(503);
    });

    it("同じ名前は 409", async () => {
      fake.answerCreate({ kind: "duplicate-name" });
      const res = await post("/api/schedules", VALID);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "a schedule with this name already exists" });
    });

    it("知らない鍵は 400（頼みの中も）", async () => {
      expect((await post("/api/schedules", { ...VALID, extra: 1 })).statusCode).toBe(400);
      expect(
        (await post("/api/schedules", { ...VALID, request: { seeds: ["x"], nope: true } }))
          .statusCode,
      ).toBe(400);
    });

    it("cron が無ければ 400", async () => {
      expect((await post("/api/schedules", { name: "x", request: {} })).statusCode).toBe(400);
    });
  });

  describe("読む", () => {
    it("一覧は状態と回と撮り方を返す", async () => {
      fake.rows.set(ID, rowOf());
      fake.setRuns([runOf({ pagesFailed: 1 })]);
      const res = await app.inject({ url: "/api/schedules" });
      expect(res.statusCode).toBe(200);
      const { schedules } = res.json<{ schedules: Record<string, unknown>[] }>();
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        id: ID,
        name: "毎朝",
        cron: "0 4 * * *",
        timezone: "Asia/Tokyo",
        enabled: true,
        health: "ok",
        blockedBy: null,
        seeds: ["https://site.test/"],
        maxDepth: 0,
        maxPages: 30,
        scripts: [{ id: "autoscroll", version: 2, latest: 2 }],
        outdated: false,
        createdBy: "alice",
      });
      expect(schedules[0]?.["recentRuns"]).toMatchObject([
        { crawlId: OTHER, state: "succeeded", pagesCaptured: 5, pagesFailed: 1 },
      ]);
      // 本文もシークレットの path も、この答えには載せない
      expect(JSON.stringify(schedules[0])).not.toContain("f/waggle_secrets/token");
    });

    it("新しい版が出ていれば outdated", async () => {
      fake.rows.set(
        ID,
        rowOf({
          recipe: {
            ...recipe,
            scripts: [{ ...recipe.scripts[0], version: 1 } as (typeof recipe.scripts)[number]],
          },
        }),
      );
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({
        outdated: true,
        scripts: [{ id: "autoscroll", version: 1, latest: 2 }],
      });
    });

    it("省いた頼みは有効な版と比べる（新しい版を無効にしたら outdated にしない）", async () => {
      fake.latestNamed.set("autoscroll", 3);
      fake.rows.set(ID, rowOf());
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({
        outdated: false,
        scripts: [{ id: "autoscroll", version: 2, latest: 2 }],
      });
    });

    it("名指しの頼みは有効かを見ずに最新と比べる", async () => {
      fake.latestNamed.set("autoscroll", 3);
      fake.rows.set(
        ID,
        rowOf({ request: { seeds: ["https://site.test/"], scripts: [{ catalog: "autoscroll" }] } }),
      );
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({
        outdated: true,
        scripts: [{ id: "autoscroll", version: 2, latest: 3 }],
      });
    });

    it("登録されていないスクリプト（その場の TS）は latest が null で、outdated にしない", async () => {
      fake.rows.set(
        ID,
        rowOf({
          recipe: {
            ...recipe,
            scripts: [{ ...recipe.scripts[0], id: "inline-x" } as (typeof recipe.scripts)[number]],
          },
        }),
      );
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({
        outdated: false,
        scripts: [{ id: "inline-x", latest: null }],
      });
    });

    it("直近の回が失敗なら failing", async () => {
      fake.rows.set(ID, rowOf());
      fake.setRuns([runOf({ state: "failed", error: "boom" })]);
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({ health: "failing", blockedBy: null });
    });

    it("期限が過ぎて走行中の行があれば、塞いでいる行を名指す", async () => {
      fake.rows.set(ID, rowOf({ nextRunAt: new Date(NOW.getTime() - 2 * 3_600_000) }));
      fake.setRunning({ crawlId: OTHER, startedAt: new Date(NOW.getTime() - 3 * 3_600_000) });
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({ health: "overdue", blockedBy: { crawlId: OTHER } });
    });

    it("直近の回が失敗でも、順番を待っていれば塞いでいる行を名指す", async () => {
      fake.rows.set(ID, rowOf({ nextRunAt: new Date(NOW.getTime() - 60_000) }));
      fake.setRuns([runOf({ state: "failed" })]);
      fake.setRunning({ crawlId: OTHER, startedAt: new Date(NOW.getTime() - 60_000) });
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({ health: "failing", blockedBy: { crawlId: OTHER } });
    });

    it("止めた予定のいま撮るが待っていれば、塞いでいる行を名指す", async () => {
      fake.rows.set(ID, rowOf({ enabled: false, runRequestedAt: NOW }));
      fake.setRunning({ crawlId: OTHER, startedAt: NOW });
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({ health: "paused", blockedBy: { crawlId: OTHER } });
    });

    it("走行中の行が在っても、待っていなければ名指さない", async () => {
      fake.rows.set(ID, rowOf());
      fake.setRunning({ crawlId: OTHER, startedAt: NOW });
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({ health: "ok", blockedBy: null });
    });

    it("回が走ったままなら stuck で、その行を名指す", async () => {
      fake.rows.set(ID, rowOf());
      const startedAt = new Date(NOW.getTime() - 2 * 3_600_000);
      fake.setRuns([runOf({ state: "running", startedAt, finishedAt: null })]);
      fake.setRunning({ crawlId: OTHER, startedAt });
      const res = await app.inject({ url: `/api/schedules/${ID}` });
      expect(res.json()).toMatchObject({ health: "stuck", blockedBy: { crawlId: OTHER } });
    });

    it("無い予定は 404、形の違う id は 400", async () => {
      expect((await app.inject({ url: `/api/schedules/${ID}` })).statusCode).toBe(404);
      expect((await app.inject({ url: "/api/schedules/nope" })).statusCode).toBe(400);
    });
  });

  describe("操作", () => {
    beforeEach(() => {
      fake.rows.set(ID, rowOf());
    });

    it("止める", async () => {
      const res = await post(`/api/schedules/${ID}/pause`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ enabled: false, health: "paused" });
    });

    it("再開は次の期限を今から計算し直す（古い期限のまま戻さない）", async () => {
      fake.rows.set(ID, rowOf({ enabled: false, nextRunAt: jst("2026-11-01T04:00:00") }));
      const res = await post(`/api/schedules/${ID}/resume`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        enabled: true,
        health: "ok",
        nextRunAt: jst("2026-11-08T04:00:00").toISOString(),
      });
    });

    it("動いている予定の再開は何も変えない（順番待ちの回を消さない）", async () => {
      const due = new Date(NOW.getTime() - 60_000);
      fake.rows.set(ID, rowOf({ nextRunAt: due }));
      const res = await post(`/api/schedules/${ID}/resume`);
      expect(res.statusCode).toBe(200);
      expect(fake.rows.get(ID)?.nextRunAt).toEqual(due);
    });

    it("いま撮るは頼みを立てて周回を呼び、202", async () => {
      const res = await post(`/api/schedules/${ID}/run`);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ runRequestedAt: NOW.toISOString(), health: "blocked" });
      expect(poke).toHaveBeenCalledTimes(1);
    });

    it("固定し直すは頼みをいま解決し直す", async () => {
      const newer = {
        ...prepared,
        scripts: [{ ...prepared.scripts[0], version: 3 } as PreparedCrawl["scripts"][number]],
      };
      prepare.mockResolvedValueOnce(newer);
      const res = await post(`/api/schedules/${ID}/repin`);
      expect(res.statusCode).toBe(200);
      expect(prepare).toHaveBeenCalledWith(
        { seeds: ["https://site.test/"] },
        { orgId: "acme", subject: "alice" },
      );
      expect(fake.rows.get(ID)?.recipe.scripts[0]?.version).toBe(3);
    });

    it("固定し直して断られたら、同じ本文を返して何も変えない", async () => {
      prepare.mockResolvedValueOnce({
        kind: "refused",
        status: 400,
        body: { error: "unknown script ids", ids: ["gone"] },
      });
      const res = await post(`/api/schedules/${ID}/repin`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "unknown script ids", ids: ["gone"] });
      expect(fake.rows.get(ID)?.recipe).toBe(recipe);
    });

    it("消すと 200 で、次からは 404", async () => {
      const res = await post(`/api/schedules/${ID}/delete`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });
      expect((await post(`/api/schedules/${ID}/delete`)).statusCode).toBe(404);
      expect((await post(`/api/schedules/${ID}/run`)).statusCode).toBe(404);
    });

    it("無い予定の操作は 404", async () => {
      for (const action of ["pause", "resume", "run", "repin", "delete"]) {
        expect((await post(`/api/schedules/${OTHER}/${action}`)).statusCode).toBe(404);
      }
      expect(poke).not.toHaveBeenCalled();
    });
  });
});
