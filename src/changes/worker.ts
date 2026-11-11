/**
 * 前回からの変化の周回 (CAPTURE-167)。30 秒ごとに、1 本だけ仕事をする。
 *
 * 1. 比べる (Claude なし): 締まった予定の回を拾い、同じ予定・同じ撮り方の前の回とページの URL で組にする。文字の
 *    digest が同じページは何もしない。違うページだけ前と今の WACZ を保管庫から読み直し、`changeOf` で差分を作る
 * 2. 要約する (Claude を 1 回): 差分のある回を拾い、違ったページの差分をまとめて Claude に読ませ、派生の層に残す。
 *    組織の月の上限に届いていれば待つ (`budget_wait`)。Claude が答えなければ間を空けて 3 回まで、断られたら終える
 *
 * 比べるほうを先にする (安く、次の要約の材料になる)。鍵が無い配備では要約しない (回は「差分あり」で止まる)。
 * 状態の語は `036` に書いた。周回の例外で API を落とさない。
 */
import type { S3Client } from "@aws-sdk/client-s3";

import { getObjectBytes } from "../archive/s3.js";
import { ClaudeUnavailable, type Claude, type ClaudeAttempt } from "../claude/types.js";
import { createChildLogger } from "../logger.js";
import { readWaczFacts } from "../replay-bundle/inspect.js";
import type { PageLine } from "../search/document.js";
import { changeOf } from "./change-of.js";
import type {
  ChangeStore,
  ComparedPage,
  NewPageChange,
  RunToCompare,
  RunToSummarize,
} from "./store.js";
import {
  CHANGE_EFFORT,
  CHANGE_PROMPT_VERSION,
  changeInputSha256,
  heaviest,
  summarizeChanges,
  type ChangeSummary,
} from "./summarize.js";

const log = createChildLogger({ module: "changes" });

export const CHANGE_TICK_INTERVAL_MS = 30_000;
/** 拾った回を持つ時間。保管庫を数本読むか、Claude を 1 回待つ (時間切れは 120 秒) より長く。 */
export const LEASE_MS = 5 * 60_000;
/** Claude が答えなかったときに、やり直すまでの間。3 回目で終える。 */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** 月の上限で待つ回を見直す間。 */
export const BUDGET_RECHECK_MS = 60 * 60_000;
/** 比べられるページが 1 つも無かった回の 1 行 (前の回の WACZ が保管庫に無い)。 */
export const NOTHING_TO_SUMMARIZE = "前の回の WACZ が保管庫に無く、比べられなかった";

export interface ChangeWorkerDeps {
  store: ChangeStore;
  /** 組織がこの月に使った額 (`derivations/store.ts`)。直す係と同じ上限を分け合う。 */
  spentThisMonth: (orgId: string) => Promise<number>;
  s3: S3Client;
  /** 無ければ要約しない。 */
  claude?: Claude;
  budgetUsd: number;
  now: () => Date;
}

export type ChangeTick =
  | { kind: "idle" }
  | { kind: "compared"; crawlId: string; state: string; pagesChanged: number }
  | { kind: "summarized" | "reused" | "deferred" | "failed" | "retry"; crawlId: string };

/** WACZ の比べる行の文字。`ComparedPage` と同じ選び方 (stage の同じ行)。 */
const textOf = (lines: readonly PageLine[], stage: string | null): string => {
  const line =
    stage === null
      ? lines.find((l) => typeof l.stage !== "string" || l.stage === "")
      : lines.find((l) => l.stage === stage);
  return line?.text ?? "";
};

const readText = async (s3: S3Client, page: ComparedPage): Promise<string | undefined> => {
  const zip = await getObjectBytes(s3, page.bucket, page.objectKey);
  if (zip === undefined) return undefined;
  return textOf((await readWaczFacts(zip)).lines, page.stage);
};

const compareRun = async (
  deps: ChangeWorkerDeps,
  run: RunToCompare,
  now: Date,
): Promise<ChangeTick> => {
  const prevCrawlId = await deps.store.previousRun(run);
  if (prevCrawlId === undefined) {
    await deps.store.finishCompare(
      run.crawlId,
      { state: "no_previous", prevCrawlId: null, pagesCompared: 0, pagesChanged: 0, pages: [] },
      now,
    );
    return { kind: "compared", crawlId: run.crawlId, state: "no_previous", pagesChanged: 0 };
  }
  const [current, previous] = await Promise.all([
    deps.store.comparedPages(run.crawlId),
    deps.store.comparedPages(prevCrawlId),
  ]);
  const before = new Map(previous.map((page) => [page.url, page]));
  let compared = 0;
  const pages: NewPageChange[] = [];
  for (const page of current) {
    const prev = before.get(page.url);
    // 伏せた・文字の無いページは比べない
    if (prev === undefined || page.textSha256 === null || prev.textSha256 === null) continue;
    if (page.textWithheld !== null || prev.textWithheld !== null) continue;
    compared += 1;
    if (page.textSha256 === prev.textSha256) continue;
    const base = {
      url: page.url,
      archiveId: page.archiveId,
      prevArchiveId: prev.archiveId,
      stage: page.stage,
    };
    const [afterText, beforeText] = await Promise.all([
      readText(deps.s3, page),
      readText(deps.s3, prev),
    ]);
    if (afterText === undefined || beforeText === undefined) {
      // 保管庫を作り直した後など。差分を作れないので Claude に渡さない
      pages.push({ ...base, state: "prev_missing", added: 0, removed: 0, hunks: [] });
      continue;
    }
    const change = changeOf(beforeText, afterText);
    if (!change.changed) continue; // digest は違うが、空行と字下げだけの違い
    pages.push({
      ...base,
      state: "diffed",
      added: change.added,
      removed: change.removed,
      hunks: change.hunks,
    });
  }
  const state = pages.length > 0 ? "diffed" : "unchanged";
  await deps.store.finishCompare(
    run.crawlId,
    { state, prevCrawlId, pagesCompared: compared, pagesChanged: pages.length, pages },
    now,
  );
  return { kind: "compared", crawlId: run.crawlId, state, pagesChanged: pages.length };
};

const usageOf = (attempts: readonly ClaudeAttempt[]) => ({
  attempts: attempts.map((a) => ({ model: a.model, ...a.usage })),
});

const summarizeRun = async (
  deps: ChangeWorkerDeps,
  claude: Claude,
  job: RunToSummarize,
  now: Date,
): Promise<ChangeTick> => {
  const pages = (await deps.store.pageChangesOf(job.crawlId))
    .filter((change) => change.state === "diffed" && change.hunks.length > 0)
    .map((change) => ({ url: change.url, hunks: change.hunks }));
  if (pages.length === 0) {
    await deps.store.finishSummary(
      job.crawlId,
      { headline: NOTHING_TO_SUMMARIZE, significance: null },
      now,
    );
    return { kind: "summarized", crawlId: job.crawlId };
  }
  const inputSha256 = changeInputSha256(pages);
  const reuse = await deps.store.findSummary(inputSha256, CHANGE_PROMPT_VERSION);
  if (reuse !== undefined) {
    const output = reuse.output as unknown as ChangeSummary;
    await deps.store.finishSummary(
      job.crawlId,
      {
        derivationId: reuse.id,
        headline: output.headline,
        significance: heaviest(output.pages.map((p) => p.significance)),
      },
      now,
    );
    return { kind: "reused", crawlId: job.crawlId };
  }
  if ((await deps.spentThisMonth(job.orgId)) >= deps.budgetUsd) {
    await deps.store.deferForBudget(job.crawlId, new Date(now.getTime() + BUDGET_RECHECK_MS), now);
    return { kind: "deferred", crawlId: job.crawlId };
  }
  const attempt = job.attempts + 1;
  const retryAt = new Date(now.getTime() + (RETRY_DELAYS_MS[job.attempts] ?? 0));
  const terminal = attempt >= RETRY_DELAYS_MS.length;
  const target = { crawlId: job.crawlId, prevCrawlId: job.prevCrawlId };
  let result;
  try {
    result = await summarizeChanges(claude, pages);
  } catch (err) {
    if (!(err instanceof ClaudeUnavailable)) throw err;
    await deps.store.failAttempt(
      job.crawlId,
      { error: err.message, terminal, nextAttemptAt: retryAt },
      now,
    );
    return { kind: terminal ? "failed" : "retry", crawlId: job.crawlId };
  }
  if (result.kind !== "summarized") {
    // 払った試みは月の上限に数える。入力の digest に試みの番号を付け、成功の一意 (`034`) とぶつけない
    await deps.store.recordAttempt({
      orgId: job.orgId,
      crawlId: job.crawlId,
      target: { ...target, attempt },
      inputSha256: `${result.inputSha256}#${String(attempt)}`,
      model: result.model,
      promptVersion: CHANGE_PROMPT_VERSION,
      effort: CHANGE_EFFORT,
      output: { kind: result.kind },
      usage: usageOf(result.attempts),
      usd: result.usd,
    });
    const refused = result.kind === "refused";
    await deps.store.failAttempt(
      job.crawlId,
      {
        error: refused ? "Claude が要約を断った" : "答えが決めた形で読めなかった",
        terminal: refused || terminal,
        nextAttemptAt: retryAt,
      },
      now,
    );
    return { kind: refused || terminal ? "failed" : "retry", crawlId: job.crawlId };
  }
  await deps.store.finishSummary(
    job.crawlId,
    {
      derivation: {
        orgId: job.orgId,
        crawlId: job.crawlId,
        target,
        inputSha256: result.inputSha256,
        model: result.model,
        promptVersion: CHANGE_PROMPT_VERSION,
        effort: CHANGE_EFFORT,
        output: result.summary as unknown as Record<string, unknown>,
        usage: usageOf(result.attempts),
        usd: result.usd,
      },
      headline: result.summary.headline,
      significance: result.significance,
    },
    now,
  );
  return { kind: "summarized", crawlId: job.crawlId };
};

/** 周回の 1 回。比べる仕事が在ればそれを 1 本、無ければ要約を 1 本。 */
export const tickChanges = async (deps: ChangeWorkerDeps): Promise<ChangeTick> => {
  const now = deps.now();
  const run = await deps.store.claimRunToCompare(now, LEASE_MS);
  if (run !== undefined) return compareRun(deps, run, now);
  if (deps.claude === undefined) return { kind: "idle" };
  const job = await deps.store.claimRunToSummarize(now, LEASE_MS);
  if (job === undefined) return { kind: "idle" };
  return summarizeRun(deps, deps.claude, job, now);
};

export interface ChangeClock {
  start(): void;
  stop(): Promise<void>;
}

export const changeClock = (
  deps: ChangeWorkerDeps,
  intervalMs = CHANGE_TICK_INTERVAL_MS,
): ChangeClock => {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const run = (): void => {
    if (running !== undefined) return;
    running = tickChanges(deps)
      .then(
        (result) => {
          if (result.kind !== "idle") log.info(result, "Change worker did one job");
        },
        // **周回の例外で API を落とさない。** 期限の切れた行は次の周回が拾い直す
        (err: unknown) => {
          log.error({ err }, "Change worker tick failed");
        },
      )
      .finally(() => {
        running = undefined;
      });
  };
  return {
    start() {
      timer = setInterval(run, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
};
