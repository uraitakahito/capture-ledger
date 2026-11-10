import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseCaptureFormats } from "../src/config/capture-formats.js";
import type { DispatchedCrawl } from "../src/crawl/launch.js";
import { WindmillUnreachable, type WindmillVariables } from "../src/crawl/windmill-variables.js";
import type { CrawlScript, ScheduleRecipe } from "../src/db/database.js";
import type { FirePlan, FireResult, ScheduleRow, ScheduleStore } from "../src/schedules/store.js";
import { scheduleClock, tickSchedules, type TickDeps } from "../src/schedules/tick.js";

const jst = (text: string) => new Date(`${text}+09:00`);
const NOW = jst("2026-11-07T09:36:00");
const minutes = (n: number) => n * 60_000;

const SCRIPT: CrawlScript = {
  id: "autoscroll",
  version: 2,
  phase: "behavior",
  source: "export default () => {};",
  sha256: "a".repeat(64),
  options: {},
  sites: [],
  params: [],
} as unknown as CrawlScript;

const recipe = (overrides: Partial<ScheduleRecipe> = {}): ScheduleRecipe => ({
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
  scripts: [SCRIPT],
  variables: {},
  declaredSecrets: [],
  userAgent: "",
  ...overrides,
});

const schedule = (overrides: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "acme",
  name: "毎朝",
  cron: "0 4 * * *",
  timezone: "Asia/Tokyo",
  enabled: true,
  nextRunAt: jst("2026-11-07T04:00:00"),
  runRequestedAt: null,
  request: { seeds: ["https://site.test/"] },
  recipe: recipe(),
  pinnedAt: jst("2026-11-01T00:00:00"),
  createdBy: "alice",
  createdAt: jst("2026-11-01T00:00:00"),
  deletedAt: null,
  ...overrides,
});

/** 周回が使う所だけの偽物。行の状態を持ち、`fire` の渡した値で進める (本物のトランザクションは smoke が見る)。 */
const fakeStore = (rows: ScheduleRow[]) => {
  const fired: FirePlan[] = [];
  const throws: Error[] = [];
  let running: { crawlId: string; startedAt: Date } | undefined;
  let lastStarted: Date | undefined;
  let nextFire: FireResult | undefined;
  const store = {
    runningCrawl: () => Promise.resolve(running),
    lastCrawlStartedAt: () => Promise.resolve(lastStarted),
    candidate: (now: Date) => {
      const live = rows.filter(
        (row) =>
          row.deletedAt === null &&
          (row.runRequestedAt !== null || (row.enabled && row.nextRunAt <= now)),
      );
      live.sort(
        (a, b) =>
          Number(a.runRequestedAt === null) - Number(b.runRequestedAt === null) ||
          +(a.runRequestedAt ?? a.nextRunAt) - +(b.runRequestedAt ?? b.nextRunAt),
      );
      return Promise.resolve(live[0]);
    },
    fire: (plan: FirePlan): Promise<FireResult> => {
      fired.push(plan);
      const thrown = throws.shift();
      if (thrown !== undefined) return Promise.reject(thrown);
      if (nextFire !== undefined) {
        const answer = nextFire;
        nextFire = undefined;
        return Promise.resolve(answer);
      }
      const row = rows.find((one) => one.id === plan.scheduleId);
      if (row !== undefined) {
        if (plan.nextRunAt !== undefined) row.nextRunAt = plan.nextRunAt;
        row.runRequestedAt = null;
      }
      if (plan.failure !== undefined) return Promise.resolve({ kind: "failed" });
      running = { crawlId: plan.crawlId, startedAt: plan.now };
      lastStarted = plan.now;
      return Promise.resolve({
        kind: "started",
        seeded: plan.prepared.seeds.map((seed) => ({ url: seed.normalized, host: seed.host })),
      });
    },
  } as unknown as ScheduleStore;
  return {
    store,
    fired,
    finish: () => {
      running = undefined;
    },
    setRunning: (value: { crawlId: string; startedAt: Date }) => {
      running = value;
    },
    setLastStarted: (value: Date) => {
      lastStarted = value;
    },
    answerNextFire: (value: FireResult) => {
      nextFire = value;
    },
    throwOnNextFire: (value: Error) => {
      throws.push(value);
    },
  };
};

const depsOf = (store: ScheduleStore, overrides: Partial<TickDeps> = {}) => {
  const levels: DispatchedCrawl[] = [];
  const deps: TickDeps = {
    store,
    capture: parseCaptureFormats("wacz", false),
    dispatchLevel: (level) => {
      levels.push(level);
    },
    startedAt: new Date(NOW.getTime() - minutes(60)),
    quietMs: minutes(10),
    now: () => NOW,
    ...overrides,
  };
  return { deps, levels };
};

describe("定期実行の周回", () => {
  it("期限の来た予定を始め、webhook を 1 回投げる", async () => {
    const fake = fakeStore([schedule()]);
    const { deps, levels } = depsOf(fake.store);
    const result = await tickSchedules(deps);
    expect(result.kind).toBe("started");
    expect(levels).toHaveLength(1);
    expect(levels[0]?.depth).toBe(0);
    expect(levels[0]?.frontier).toEqual([
      { url: "https://site.test/", host: "site.test", lastFinishedAt: null },
    ]);
  });

  it("2 回目の周回は始めない（次の回へ進んでいる）", async () => {
    const fake = fakeStore([schedule()]);
    const { deps, levels } = depsOf(fake.store);
    await tickSchedules(deps);
    fake.finish();
    fake.setLastStarted(new Date(NOW.getTime() - minutes(60)));
    expect(await tickSchedules(deps)).toEqual({ kind: "idle", why: "nothing" });
    expect(levels).toHaveLength(1);
  });

  it("止まっていた間の回は 1 本にまとめ、欠けの数と本来の時刻を渡す", async () => {
    const fake = fakeStore([schedule({ nextRunAt: jst("2026-11-04T04:00:00") })]);
    const { deps, levels } = depsOf(fake.store);
    await tickSchedules(deps);
    expect(levels).toHaveLength(1);
    expect(fake.fired[0]?.scheduledFor).toEqual(jst("2026-11-04T04:00:00"));
    expect(fake.fired[0]?.missed).toBe(3);
    expect(fake.fired[0]?.nextRunAt).toEqual(jst("2026-11-08T04:00:00"));
  });

  it("走行中は何もしない（期限も動かさない）", async () => {
    const row = schedule();
    const fake = fakeStore([row]);
    fake.setRunning({ crawlId: "x", startedAt: NOW });
    const { deps } = depsOf(fake.store);
    expect(await tickSchedules(deps)).toEqual({ kind: "idle", why: "running" });
    expect(fake.fired).toHaveLength(0);
    expect(row.nextRunAt).toEqual(jst("2026-11-07T04:00:00"));
  });

  it("起動の直後は始めない（直近のクロールが古くても）", async () => {
    const fake = fakeStore([schedule()]);
    fake.setLastStarted(new Date(NOW.getTime() - minutes(60)));
    const { deps } = depsOf(fake.store, { startedAt: new Date(NOW.getTime() - minutes(1)) });
    expect(await tickSchedules(deps)).toEqual({ kind: "idle", why: "quiet" });
  });

  it("クロールの直後は始めない（起動が古くても）", async () => {
    const fake = fakeStore([schedule()]);
    fake.setLastStarted(new Date(NOW.getTime() - minutes(1)));
    const { deps } = depsOf(fake.store, { startedAt: new Date(NOW.getTime() - minutes(60)) });
    expect(await tickSchedules(deps)).toEqual({ kind: "idle", why: "quiet" });
  });

  it("起動も直近のクロールも静かな時間より前なら始める", async () => {
    const fake = fakeStore([schedule()]);
    fake.setLastStarted(new Date(NOW.getTime() - minutes(10)));
    const { deps } = depsOf(fake.store, { startedAt: new Date(NOW.getTime() - minutes(10)) });
    expect((await tickSchedules(deps)).kind).toBe("started");
  });

  it("いま撮るは静かな時間を見ない。本来の時刻は null で、期限を動かさない", async () => {
    const next = jst("2026-11-08T04:00:00");
    const fake = fakeStore([schedule({ nextRunAt: next, runRequestedAt: NOW })]);
    const { deps, levels } = depsOf(fake.store, { startedAt: NOW });
    expect((await tickSchedules(deps)).kind).toBe("started");
    expect(levels).toHaveLength(1);
    expect(fake.fired[0]?.scheduledFor).toBeNull();
    expect(fake.fired[0]?.missed).toBe(0);
    expect(fake.fired[0]?.nextRunAt).toBeUndefined();
  });

  it("止めた予定もいま撮るなら始まり、期限は動かない", async () => {
    const stale = jst("2026-11-01T04:00:00");
    const fake = fakeStore([schedule({ enabled: false, nextRunAt: stale, runRequestedAt: NOW })]);
    const { deps } = depsOf(fake.store);
    expect((await tickSchedules(deps)).kind).toBe("started");
    expect(fake.fired[0]?.scheduledFor).toBeNull();
    // 書かない。Windmill を待つ間に再開されても、この古い期限で上書きしない
    expect(fake.fired[0]?.nextRunAt).toBeUndefined();
    expect(stale.getTime()).toBeLessThan(NOW.getTime());
  });

  it("期限の来た予定にいま撮るが重なれば、本来の回として 1 本だけ始める", async () => {
    const row = schedule({ runRequestedAt: NOW });
    const fake = fakeStore([row]);
    const { deps, levels } = depsOf(fake.store);
    await tickSchedules(deps);
    fake.finish();
    fake.setLastStarted(new Date(NOW.getTime() - minutes(60)));
    expect(fake.fired[0]?.scheduledFor).toEqual(jst("2026-11-07T04:00:00"));
    expect(row.runRequestedAt).toBeNull();
    expect(await tickSchedules(deps)).toEqual({ kind: "idle", why: "nothing" });
    expect(levels).toHaveLength(1);
  });

  it("いま撮るの頼みを、期限の古い予定より先に始める", async () => {
    const asked = schedule({
      id: "22222222-2222-4222-8222-222222222222",
      nextRunAt: jst("2026-11-08T04:00:00"),
      runRequestedAt: NOW,
    });
    const fake = fakeStore([schedule(), asked]);
    const { deps } = depsOf(fake.store);
    await tickSchedules(deps);
    expect(fake.fired[0]?.scheduleId).toBe(asked.id);
  });

  it("配るのは固定した撮り方で、行の組織と作った人を名乗る", async () => {
    const fake = fakeStore([schedule()]);
    const { deps, levels } = depsOf(fake.store);
    await tickSchedules(deps);
    expect(levels[0]?.scripts.map((script) => script.sha256)).toEqual(["a".repeat(64)]);
    expect(fake.fired[0]?.prepared.scripts).toEqual([SCRIPT]);
    expect(fake.fired[0]?.who).toEqual({ orgId: "acme", subject: "alice" });
  });

  describe("シークレット", () => {
    const declared = recipe({
      declaredSecrets: [
        { name: "token", path: "f/waggle_secrets/token", required: true, declaredBy: ["login"] },
      ],
    });

    it("在れば行に固定する形で渡す", async () => {
      const windmill: WindmillVariables = {
        exists: () => Promise.resolve(true),
        meta: () => Promise.resolve({ isSecret: true, editedAt: "2026-11-01T00:00:00Z" }),
      };
      const fake = fakeStore([schedule({ recipe: declared })]);
      const { deps, levels } = depsOf(fake.store, { windmill });
      expect((await tickSchedules(deps)).kind).toBe("started");
      expect(levels[0]?.secrets).toEqual({ token: "f/waggle_secrets/token" });
    });

    it("消されていれば failed の行にして、次の回へ進む。webhook は投げない", async () => {
      const windmill: WindmillVariables = {
        exists: () => Promise.resolve(false),
        meta: () => Promise.resolve(undefined),
      };
      const fake = fakeStore([schedule({ recipe: declared })]);
      const { deps, levels } = depsOf(fake.store, { windmill });
      expect(await tickSchedules(deps)).toMatchObject({
        kind: "failed",
        error: "unknown secrets: token",
      });
      expect(levels).toHaveLength(0);
      expect(fake.fired[0]?.nextRunAt).toEqual(jst("2026-11-08T04:00:00"));
    });

    it("keep の宣言は回ごとに行の写しへ archive で写り、段の secret_archive に載る", async () => {
      const windmill: WindmillVariables = {
        exists: () => Promise.resolve(true),
        meta: () => Promise.resolve({ isSecret: true, editedAt: "2026-11-01T00:00:00Z" }),
      };
      const kept = recipe({
        declaredSecrets: [
          {
            name: "note",
            path: "f/waggle_secrets/note",
            required: true,
            declaredBy: ["login"],
            archive: "keep",
          },
          { name: "token", path: "f/waggle_secrets/token", required: true, declaredBy: ["login"] },
        ],
      });
      const fake = fakeStore([schedule({ recipe: kept })]);
      const { deps, levels } = depsOf(fake.store, { windmill });
      expect((await tickSchedules(deps)).kind).toBe("started");
      expect(fake.fired[0]?.prepared.secrets["note"]?.archive).toBe("keep");
      expect(fake.fired[0]?.prepared.secrets["token"]).not.toHaveProperty("archive");
      expect(levels[0]?.secretArchive).toEqual({ note: "keep" });
    });

    it("隠すシークレットが在り、配備の形式が値を置き換えられなければ failed の行にして次の回へ進む。webhook は投げない", async () => {
      const windmill: WindmillVariables = {
        exists: () => Promise.resolve(true),
        meta: () => Promise.resolve({ isSecret: true, editedAt: "2026-11-01T00:00:00Z" }),
      };
      const fake = fakeStore([schedule({ recipe: declared })]);
      const { deps, levels } = depsOf(fake.store, {
        windmill,
        capture: parseCaptureFormats("wacz,html", false),
      });
      expect(await tickSchedules(deps)).toMatchObject({
        kind: "failed",
        error: "formats that cannot hide secrets: token",
      });
      expect(levels).toHaveLength(0);
      expect(fake.fired[0]?.nextRunAt).toEqual(jst("2026-11-08T04:00:00"));
    });

    it("Windmill に届かなければ failed の行にする（順番待ちで塞がない）", async () => {
      const windmill: WindmillVariables = {
        exists: () => Promise.reject(new WindmillUnreachable("down")),
      } as unknown as WindmillVariables;
      const fake = fakeStore([schedule({ recipe: declared })]);
      const { deps } = depsOf(fake.store, { windmill });
      expect(await tickSchedules(deps)).toMatchObject({
        kind: "failed",
        error: "windmill unreachable",
      });
    });
  });

  it("シークレットを訊いて投げられても、failed の行にして次の回へ進む（ほかの予定を止めない）", async () => {
    const windmill = {
      exists: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
    } as unknown as WindmillVariables;
    const declaredSecret = recipe({
      declaredSecrets: [
        { name: "token", path: "f/waggle_secrets/token", required: true, declaredBy: ["login"] },
      ],
    });
    const fake = fakeStore([schedule({ recipe: declaredSecret })]);
    const { deps, levels } = depsOf(fake.store, { windmill });
    expect(await tickSchedules(deps)).toMatchObject({
      kind: "failed",
      error: "could not ask about secrets: Unexpected token < in JSON",
    });
    expect(levels).toHaveLength(0);
    expect(fake.fired[0]?.nextRunAt).toEqual(jst("2026-11-08T04:00:00"));
  });

  it("行を足せずに投げても、failed の行にして次の回へ進む（ほかの予定を止めない）", async () => {
    const fake = fakeStore([schedule()]);
    fake.throwOnNextFire(new Error("bind message has 70000 parameters"));
    const { deps, levels } = depsOf(fake.store);
    expect(await tickSchedules(deps)).toMatchObject({
      kind: "failed",
      error: "could not start: bind message has 70000 parameters",
    });
    expect(levels).toHaveLength(0);
    expect(fake.fired).toHaveLength(2);
    expect(fake.fired[1]?.failure).toBe("could not start: bind message has 70000 parameters");
  });

  it("failed の行も足せなければ投げる（DB が落ちている。次の周回でまた見る）", async () => {
    const fake = fakeStore([schedule()]);
    fake.throwOnNextFire(new Error("db down"));
    fake.throwOnNextFire(new Error("db down"));
    const { deps } = depsOf(fake.store);
    await expect(tickSchedules(deps)).rejects.toThrow("db down");
  });

  it("走行中の行とぶつかれば webhook を投げない", async () => {
    const fake = fakeStore([schedule()]);
    fake.answerNextFire({ kind: "busy" });
    const { deps, levels } = depsOf(fake.store);
    expect((await tickSchedules(deps)).kind).toBe("busy");
    expect(levels).toHaveLength(0);
  });

  it("候補を選んだ後に消されていれば webhook を投げない", async () => {
    const fake = fakeStore([schedule()]);
    fake.answerNextFire({ kind: "gone" });
    const { deps, levels } = depsOf(fake.store);
    expect((await tickSchedules(deps)).kind).toBe("gone");
    expect(levels).toHaveLength(0);
  });
});

describe("周回の時計", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("周回の例外で落ちず、次の周回でまた見る", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const candidate = vi.fn(() => Promise.reject(new Error("db down")));
    const store = {
      runningCrawl: () => Promise.resolve(undefined),
      candidate,
    } as unknown as ScheduleStore;
    const { deps } = depsOf(store);
    const clock = scheduleClock(deps, 1000);
    clock.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(candidate).toHaveBeenCalledTimes(2);
    await clock.stop();
    vi.useRealTimers();
  });

  it("周回が走っている間に呼ばれても二重に走らない", async () => {
    let release: (() => void) | undefined;
    const runningCrawl = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            resolve(undefined);
          };
        }),
    );
    const store = {
      runningCrawl,
      candidate: () => Promise.resolve(undefined),
    } as unknown as ScheduleStore;
    const { deps } = depsOf(store);
    const clock = scheduleClock(deps, 60_000);
    clock.poke();
    clock.poke();
    expect(runningCrawl).toHaveBeenCalledTimes(1);
    const stopped = clock.stop();
    release?.();
    await stopped;
  });

  it("止めると、走っている周回の終わりを待つ", async () => {
    let finished = false;
    let release: (() => void) | undefined;
    const store = {
      runningCrawl: () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            finished = true;
            resolve(undefined);
          };
        }),
      candidate: () => Promise.resolve(undefined),
    } as unknown as ScheduleStore;
    const { deps } = depsOf(store);
    const clock = scheduleClock(deps, 60_000);
    clock.poke();
    const stopped = clock.stop();
    release?.();
    await stopped;
    expect(finished).toBe(true);
  });
});
