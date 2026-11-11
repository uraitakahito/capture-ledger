import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { ClaudeUnavailable, type Claude, type ClaudeReply } from "../src/claude/types.js";
import type {
  ChangeStore,
  CompareOutcome,
  ComparedPage,
  RunToCompare,
  RunToSummarize,
  StoredPageChange,
} from "../src/changes/store.js";
import { NOTHING_TO_SUMMARIZE, tickChanges, type ChangeWorkerDeps } from "../src/changes/worker.js";
import { storedZip } from "./zip.js";

/**
 * 前回からの変化の周回。DB は偽の store (呼ばれた物を控える)、保管庫は読みに来た鍵を数える偽物、Claude は決めた答えを
 * 返す偽物。**SQL はここでは見ない** (`changes-store.test.ts` と CI の `changes-smoke`)。
 */

const NOW = new Date("2026-11-12T04:05:00.000Z");
const RUN: RunToCompare = {
  crawlId: "11111111-1111-4111-8111-111111111111",
  scheduleId: "22222222-2222-4222-8222-222222222222",
  orgId: "acme",
  startedAt: new Date("2026-11-12T04:00:00.000Z"),
  recipeSha256: "r".repeat(64),
};
const PREV = "33333333-3333-4333-8333-333333333333";

const wacz = (text: string) =>
  storedZip({
    "datapackage.json": "{}",
    "pages/pages.jsonl": [
      JSON.stringify({ format: "json-pages-1.0", id: "pages" }),
      JSON.stringify({ url: "https://site.test/", text }),
      JSON.stringify({
        url: "urn:browserhive:snapshot:after-behaviors:https://site.test/",
        stage: "after-behaviors",
        text,
      }),
    ].join("\n"),
  });

const page = (key: string, sha: string, over: Partial<ComparedPage> = {}): ComparedPage => ({
  archiveId: `${key}-id`,
  bucket: "browserhive",
  objectKey: key,
  url: "https://site.test/",
  stage: "after-behaviors",
  textSha256: sha,
  textWithheld: null,
  ...over,
});

const fakeS3 = (objects: Record<string, Buffer>) => {
  const read: string[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string } }) => {
      read.push(command.input.Key);
      const bytes = objects[command.input.Key];
      if (bytes === undefined) {
        return Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
      }
      return Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)) },
      });
    },
  };
  return { s3: s3 as unknown as S3Client, read };
};

const fakeStore = (opts: {
  run?: RunToCompare;
  prev?: string;
  pages?: Record<string, ComparedPage[]>;
  job?: RunToSummarize;
  changes?: StoredPageChange[];
  reuse?: { id: string; output: Record<string, unknown> };
}) => {
  const calls: { name: string; args: unknown[] }[] = [];
  const note = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const store: ChangeStore = {
    claimRunToCompare: () => Promise.resolve(opts.run),
    previousRun: () => Promise.resolve(opts.prev),
    comparedPages: (crawlId) => Promise.resolve(opts.pages?.[crawlId] ?? []),
    finishCompare: (crawlId, outcome) => (
      note("finishCompare", crawlId, outcome),
      Promise.resolve()
    ),
    claimRunToSummarize: () => Promise.resolve(opts.job),
    pageChangesOf: () => Promise.resolve(opts.changes ?? []),
    findSummary: () => Promise.resolve(opts.reuse),
    finishSummary: (crawlId, result) => (note("finishSummary", crawlId, result), Promise.resolve()),
    recordAttempt: (d) => (note("recordAttempt", d), Promise.resolve()),
    deferForBudget: (crawlId, at) => (note("deferForBudget", crawlId, at), Promise.resolve()),
    failAttempt: (crawlId, failure) => (note("failAttempt", crawlId, failure), Promise.resolve()),
  };
  return { store, calls };
};

const fakeClaude = (answer: (() => Promise<unknown>) | undefined) => {
  let asked = 0;
  const claude: Claude = {
    ask<T>() {
      asked += 1;
      if (answer === undefined) throw new Error("呼ばれないはず");
      return answer() as Promise<ClaudeReply<T>>;
    },
  };
  return { claude, asked: () => asked };
};

const deps = (
  over: Partial<ChangeWorkerDeps> & Pick<ChangeWorkerDeps, "store">,
): ChangeWorkerDeps => ({
  s3: fakeS3({}).s3,
  spentThisMonth: () => Promise.resolve(0),
  budgetUsd: 5,
  now: () => NOW,
  ...over,
});

const outcomeOf = (calls: { name: string; args: unknown[] }[]) =>
  calls.find((c) => c.name === "finishCompare")?.args[1] as CompareOutcome;

describe("前回からの変化の周回: 比べる", () => {
  it("仕事が無ければ何もしない", async () => {
    const { store, calls } = fakeStore({});
    expect(await tickChanges(deps({ store, claude: fakeClaude(undefined).claude }))).toEqual({
      kind: "idle",
    });
    expect(calls).toEqual([]);
  });

  it("同じ予定・同じ撮り方の前の回が無ければ no_previous", async () => {
    const { store, calls } = fakeStore({ run: RUN });
    await tickChanges(deps({ store }));
    expect(outcomeOf(calls)).toMatchObject({ state: "no_previous", prevCrawlId: null, pages: [] });
  });

  it("どのページも digest が同じなら unchanged で、WACZ も Claude も呼ばない ($0)", async () => {
    const { store, calls } = fakeStore({
      run: RUN,
      prev: PREV,
      pages: { [RUN.crawlId]: [page("now.wacz", "a")], [PREV]: [page("prev.wacz", "a")] },
    });
    const { s3, read } = fakeS3({});
    const { claude, asked } = fakeClaude(undefined);
    await tickChanges(deps({ store, s3, claude }));
    expect(outcomeOf(calls)).toMatchObject({
      state: "unchanged",
      pagesCompared: 1,
      pagesChanged: 0,
    });
    expect(read).toEqual([]);
    expect(asked()).toBe(0);
  });

  it("digest が違えば前と今の WACZ を読み、差分を残して diffed (まだ Claude は呼ばない)", async () => {
    const { store, calls } = fakeStore({
      run: RUN,
      prev: PREV,
      pages: { [RUN.crawlId]: [page("now.wacz", "b")], [PREV]: [page("prev.wacz", "a")] },
    });
    const { s3, read } = fakeS3({
      "now.wacz": wacz("お知らせ\n更新: 2026-11-12"),
      "prev.wacz": wacz("お知らせ\n更新: 2026-11-11"),
    });
    const { claude, asked } = fakeClaude(undefined);
    await tickChanges(deps({ store, s3, claude }));
    expect(read.sort()).toEqual(["now.wacz", "prev.wacz"]);
    expect(asked()).toBe(0);
    expect(outcomeOf(calls)).toMatchObject({
      state: "diffed",
      pagesChanged: 1,
      pages: [
        {
          state: "diffed",
          added: 1,
          removed: 1,
          hunks: [[" お知らせ", "-更新: 2026-11-11", "+更新: 2026-11-12"]],
        },
      ],
    });
  });

  it("前の回の WACZ が保管庫に無ければ prev_missing で残す", async () => {
    const { store, calls } = fakeStore({
      run: RUN,
      prev: PREV,
      pages: { [RUN.crawlId]: [page("now.wacz", "b")], [PREV]: [page("gone.wacz", "a")] },
    });
    const { s3 } = fakeS3({ "now.wacz": wacz("x") });
    await tickChanges(deps({ store, s3 }));
    expect(outcomeOf(calls)).toMatchObject({
      state: "diffed",
      pages: [{ state: "prev_missing", hunks: [] }],
    });
  });

  it("伏せたページと、前の回に無いページは比べない", async () => {
    const { store, calls } = fakeStore({
      run: RUN,
      prev: PREV,
      pages: {
        [RUN.crawlId]: [
          page("now.wacz", "b", { textWithheld: "no-archive" }),
          page("new.wacz", "c", { url: "https://site.test/new" }),
        ],
        [PREV]: [page("prev.wacz", "a")],
      },
    });
    await tickChanges(deps({ store }));
    expect(outcomeOf(calls)).toMatchObject({
      state: "unchanged",
      pagesCompared: 0,
      pagesChanged: 0,
    });
  });
});

const JOB: RunToSummarize = { crawlId: RUN.crawlId, orgId: "acme", prevCrawlId: PREV, attempts: 0 };
const CHANGE: StoredPageChange = {
  url: "https://site.test/",
  state: "diffed",
  hunks: [["-更新: 2026-11-11", "+更新: 2026-11-12"]],
};
const ANSWER = {
  output: {
    headline: "中身の変化は無い",
    pages: [
      {
        url: "https://site.test/",
        significance: "none",
        headline: "更新時刻だけ",
        quotes: ["更新: 2026-11-12"],
      },
    ],
  },
  content: [],
  model: "claude-opus-5-5",
  attempts: [{ model: "claude-opus-5-5", usage: { input_tokens: 800, output_tokens: 200 } }],
  stopReason: "end_turn",
};

describe("前回からの変化の周回: 要約する", () => {
  it("鍵が無ければ要約を拾わない (回は差分ありのまま)", async () => {
    const { store, calls } = fakeStore({ job: JOB, changes: [CHANGE] });
    expect(await tickChanges(deps({ store }))).toEqual({ kind: "idle" });
    expect(calls).toEqual([]);
  });

  it("要約を派生の層に残し、回に 1 行と重さを写す", async () => {
    const { store, calls } = fakeStore({ job: JOB, changes: [CHANGE] });
    const { claude, asked } = fakeClaude(() => Promise.resolve(ANSWER));
    expect(await tickChanges(deps({ store, claude }))).toEqual({
      kind: "summarized",
      crawlId: JOB.crawlId,
    });
    expect(asked()).toBe(1);
    const result = calls.find((c) => c.name === "finishSummary")?.args[1] as {
      derivation: {
        usd: number;
        promptVersion: string;
        output: { pages: { quotesUnverified: string[] }[] };
      };
      headline: string;
      significance: string;
    };
    expect(result).toMatchObject({ headline: "中身の変化は無い", significance: "none" });
    expect(result.derivation).toMatchObject({ promptVersion: "change-v1", effort: "low" });
    expect(result.derivation.usd).toBeGreaterThan(0);
    expect(result.derivation.output.pages[0]?.quotesUnverified).toEqual([]);
  });

  it("同じ差分の要約が在れば、Claude を呼ばずにそれを指す", async () => {
    const { store, calls } = fakeStore({
      job: JOB,
      changes: [CHANGE],
      reuse: { id: "d1", output: ANSWER.output as unknown as Record<string, unknown> },
    });
    const { claude, asked } = fakeClaude(undefined);
    expect((await tickChanges(deps({ store, claude }))).kind).toBe("reused");
    expect(asked()).toBe(0);
    expect(calls.find((c) => c.name === "finishSummary")?.args[1]).toMatchObject({
      derivationId: "d1",
    });
  });

  it("月の上限に届いていれば Claude を呼ばずに待つ", async () => {
    const { store, calls } = fakeStore({ job: JOB, changes: [CHANGE] });
    const { claude, asked } = fakeClaude(undefined);
    expect(
      (await tickChanges(deps({ store, claude, spentThisMonth: () => Promise.resolve(5) }))).kind,
    ).toBe("deferred");
    expect(asked()).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(["deferForBudget"]);
  });

  it("Claude に届かなければやり直しを待ち、3 回目で失敗に終える", async () => {
    const unavailable = () => Promise.reject(new ClaudeUnavailable("529 overloaded"));
    for (const [attempts, terminal] of [
      [0, false],
      [1, false],
      [2, true],
    ] as const) {
      const { store, calls } = fakeStore({ job: { ...JOB, attempts }, changes: [CHANGE] });
      await tickChanges(deps({ store, claude: fakeClaude(unavailable).claude }));
      expect(calls.find((c) => c.name === "failAttempt")?.args[1]).toMatchObject({ terminal });
    }
  });

  it("断られたら費用を残して失敗に終える (やり直さない)", async () => {
    const { store, calls } = fakeStore({ job: JOB, changes: [CHANGE] });
    await tickChanges(
      deps({
        store,
        claude: fakeClaude(() =>
          Promise.resolve({ ...ANSWER, output: null, stopReason: "refusal" }),
        ).claude,
      }),
    );
    expect(calls.map((c) => c.name)).toEqual(["recordAttempt", "failAttempt"]);
    expect(calls[0]?.args[0]).toMatchObject({
      inputSha256: expect.stringMatching(/#1$/) as unknown,
    });
    expect(calls[1]?.args[1]).toMatchObject({ terminal: true });
  });

  it("比べられたページが無い回 (前の WACZ が無い) は、Claude を呼ばずに終える", async () => {
    const { store, calls } = fakeStore({
      job: JOB,
      changes: [{ ...CHANGE, state: "prev_missing", hunks: [] }],
    });
    const { claude, asked } = fakeClaude(undefined);
    await tickChanges(deps({ store, claude }));
    expect(asked()).toBe(0);
    expect(calls.find((c) => c.name === "finishSummary")?.args[1]).toEqual({
      headline: NOTHING_TO_SUMMARIZE,
      significance: null,
    });
  });
});
