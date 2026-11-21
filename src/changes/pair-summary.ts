/**
 * 好きな 2 本の差分の要約 (CAPTURE-462)。人が押した時だけ、Claude を 1 回呼ぶ。
 *
 * 周回の要約 (`changes/worker.ts`) と同じ物を使う: 同じ関数 (`summarizeChanges`)・同じ決まりの文 (版
 * `CHANGE_PROMPT_VERSION`)・同じ置き場 (派生の層。`derivations` の `kind = 'change'`)。**同じ差分に 2 度払わない** ——
 * 差分から作る入力の digest と決まりの文の版が同じ行が在れば、Claude を呼ばずにそれを返す (`034` の部分の一意)。
 * 周回が残した要約でも、同じ入力なら当たる (入力は URL と差分の行だけ)。
 *
 * 予定の回の状態 (`crawl_changes`) は使わない (手の比較には回が無い)。周回のような自動のやり直しもしない (押し直す)。
 * 費用は「今」の取り込みを撮ったクロールの組織に数え、月の上限は周回・直す係と分け合う。
 *
 * **要約は証拠ではない。** 答えには `evidence: false` と model・決まりの文の版・費用を必ず付ける。
 */
import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import { ClaudeUnavailable, type Claude } from "../claude/types.js";
import type { ChangeSignificance, Database } from "../db/database.js";
import type { DerivationStore, NewDerivation } from "../derivations/store.js";
import type { PairComparison } from "./compare.js";
import type { HistoryArchive } from "./history.js";
import {
  attemptsUsageOf,
  CHANGE_EFFORT,
  CHANGE_PROMPT_VERSION,
  changeInputSha256,
  summarizeChanges,
  type ChangeSummary,
} from "./summarize.js";

/** `034` の部分の一意の索引。同じ入力・同じ版の 2 行目がこれにぶつかる。 */
const CHANGE_INPUT_INDEX = "derivations_change_input_idx";

/** 派生の層に在る要約 1 行。`usd` は numeric なので文字列。 */
export interface StoredPairSummary {
  model: string;
  promptVersion: string;
  usd: string;
  output: Record<string, unknown>;
}

export interface PairSummaryReads {
  /** 同じ入力・同じ決まりの文の版の要約が在れば、その行。 */
  find(inputSha256: string, promptVersion: string): Promise<StoredPairSummary | undefined>;
}

export const pairSummaryReadsOf = (db: Kysely<Database>): PairSummaryReads => ({
  find(inputSha256, promptVersion) {
    return db
      .selectFrom("derivations")
      .select(["model", "promptVersion", "usd", "output"])
      .where("kind", "=", "change")
      .where("inputSha256", "=", inputSha256)
      .where("promptVersion", "=", promptVersion)
      .executeTakeFirst();
  },
});

/** 答えに載せる要約の欄。差分を読む答えと、要約させる答えが同じ形で載せる。 */
export interface PairSummaryFields {
  summary: { evidence: false; model: string; promptVersion: string; usd: number } | null;
  significance: ChangeSignificance | null;
  headline: string | null;
  quotes: { text: string; verified: boolean }[];
}

export const NO_SUMMARY: PairSummaryFields = {
  summary: null,
  significance: null,
  headline: null,
  quotes: [],
};

/** 要約の行から、このページの欄を作る。重さ・1 行・引用は、要約の `pages` のうち URL が同じ物から取る。 */
const fieldsOf = (url: string, stored: StoredPairSummary): PairSummaryFields => {
  const output = stored.output as unknown as ChangeSummary;
  const said = output.pages.find((page) => page.url === url);
  return {
    summary: {
      evidence: false,
      model: stored.model,
      promptVersion: stored.promptVersion,
      usd: Number(stored.usd),
    },
    significance: said?.significance ?? null,
    headline: said?.headline ?? null,
    quotes: (said?.quotes ?? []).map((text) => ({
      text,
      verified: !said?.quotesUnverified.includes(text),
    })),
  };
};

/** 差分 1 組を Claude に渡す形 (周回の 1 ページと同じ)。 */
const inputOf = (comparison: PairComparison) => [{ url: comparison.url, hunks: comparison.hunks }];

/** 在る要約を読む。差分の無い 2 本と、要約がまだ無い 2 本は `NO_SUMMARY`。**Claude は呼ばない。** */
export const existingSummaryOf = async (
  reads: PairSummaryReads,
  comparison: PairComparison,
): Promise<PairSummaryFields> => {
  if (comparison.state !== "diffed") return NO_SUMMARY;
  const stored = await reads.find(changeInputSha256(inputOf(comparison)), CHANGE_PROMPT_VERSION);
  return stored === undefined ? NO_SUMMARY : fieldsOf(comparison.url, stored);
};

export interface PairSummaryDeps {
  reads: PairSummaryReads;
  derivations: DerivationStore;
  claude: Claude;
  /** 組織ごとの月の上限 (USD)。 */
  budgetUsd: number;
}

export type PairSummaryResult =
  | { kind: "summarized"; reused: boolean; fields: PairSummaryFields }
  /** 差分が無い (同じ・比べられない)。 */
  | { kind: "nothing_to_summarize" }
  /** 「今」の取り込みがクロールに繋がらず、費用を数える組織が無い。 */
  | { kind: "no_organization" }
  | { kind: "budget_exhausted"; spentUsd: number; budgetUsd: number }
  /** Claude が断った。 */
  | { kind: "refused" }
  /** Claude が答えなかったか、答えが決めた形で読めなかった。 */
  | { kind: "failed" };

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: string }).code === "23505" &&
  String((err as { constraint?: string }).constraint ?? "").includes(CHANGE_INPUT_INDEX);

/**
 * 差分 1 組を要約させる。お金の掛かる Claude の前に、ただの検査と上限を済ませる。
 *
 * 数えてから呼ぶので、同時の頼みは上限を少し越えうる (止まるのは次の頼みから。直す係と同じ)。
 */
export const summarizePair = async (
  deps: PairSummaryDeps,
  pair: {
    comparison: PairComparison;
    after: HistoryArchive;
    before: HistoryArchive;
    /** 頼んだ人の subject。 */
    requestedBy: string;
  },
): Promise<PairSummaryResult> => {
  const { comparison, after, before } = pair;
  if (comparison.state !== "diffed") return { kind: "nothing_to_summarize" };
  if (after.crawlId === null || after.orgId === null) return { kind: "no_organization" };

  const input = inputOf(comparison);
  const inputSha256 = changeInputSha256(input);
  const stored = await deps.reads.find(inputSha256, CHANGE_PROMPT_VERSION);
  if (stored !== undefined) {
    return { kind: "summarized", reused: true, fields: fieldsOf(comparison.url, stored) };
  }

  const spent = await deps.derivations.spentThisMonth(after.orgId);
  if (spent >= deps.budgetUsd) {
    return {
      kind: "budget_exhausted",
      spentUsd: Number(spent.toFixed(4)),
      budgetUsd: deps.budgetUsd,
    };
  }

  let result;
  try {
    result = await summarizeChanges(deps.claude, input);
  } catch (err) {
    // 答えが無かった試みは、費用が分からないので残さない
    if (!(err instanceof ClaudeUnavailable)) throw err;
    return { kind: "failed" };
  }
  const row: Omit<NewDerivation, "target" | "inputSha256" | "output"> = {
    kind: "change",
    orgId: after.orgId,
    crawlId: after.crawlId,
    archiveId: after.id,
    model: result.model,
    promptVersion: CHANGE_PROMPT_VERSION,
    effort: CHANGE_EFFORT,
    rounds: 1,
    usage: attemptsUsageOf(result.attempts),
    usd: result.usd,
    createdBy: pair.requestedBy,
  };
  const target = { archiveId: after.id, prevArchiveId: before.id };
  if (result.kind !== "summarized") {
    // 払った試みは月の上限に数える。入力の digest に試みの印を付け、成功の一意 (`034`) とぶつけない
    if (result.usd > 0) {
      const attempt = randomUUID();
      await deps.derivations.record({
        ...row,
        target: { ...target, attempt },
        inputSha256: `${result.inputSha256}#${attempt}`,
        output: { kind: result.kind },
      });
    }
    return { kind: result.kind === "refused" ? "refused" : "failed" };
  }

  const output = result.summary as unknown as Record<string, unknown>;
  try {
    await deps.derivations.record({ ...row, target, inputSha256: result.inputSha256, output });
  } catch (err) {
    // 同じ 2 本を同時に頼まれ、先の頼みが残した。先の行を返す (周回が同じ入力で先に残したときも同じ)
    if (!isUniqueViolation(err)) throw err;
    const first = await deps.reads.find(result.inputSha256, CHANGE_PROMPT_VERSION);
    if (first === undefined) throw err;
    return { kind: "summarized", reused: true, fields: fieldsOf(comparison.url, first) };
  }
  return {
    kind: "summarized",
    reused: false,
    fields: fieldsOf(comparison.url, {
      model: result.model,
      promptVersion: CHANGE_PROMPT_VERSION,
      usd: result.usd.toFixed(6),
      output,
    }),
  };
};
