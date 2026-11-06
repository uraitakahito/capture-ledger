/**
 * 型で落ちたクロールの、その場の TS の直し方を Claude に訊く係 (CAPTURE-49)。
 *
 * **Claude の案は、クロールと同じ検査に通った物だけを返す。** 輪は 1 回の頼みで 2 往復まで:
 *
 *   1. その場の TS (行番号つき)・一緒に走るスクリプト・型の誤り・受け皿の型を渡す
 *   2. Claude は行の範囲の置き換え (`edits`) と、誤りごとの理由 (`notes`) を返す
 *   3. 置き換えを当てる (重なり・範囲の外は断る) → 黙らせる形・module の形・書き直しすぎを断る
 *      → 一緒に走るスクリプトと同じ組み合わせで ts-compile-service に通す
 *   4. 通らなければ、検査の答えを足してもう 1 度。**会話は継ぎ足すだけ** —— Claude Opus 5.5 は
 *      thinking の塊をその会話に結び付けるので、前の turn を書き換えない
 *
 * 直してよいのはその場の TS だけで、台帳のスクリプトは読ませるが変えさせない。送るのは書いた source・
 * 一緒に走るスクリプト・型の誤り・受け皿の型だけ (頁の文字・変数の値・シークレットは送らない)。
 * 確かめられるのは型が通ることだけで、動きが正しいかは人が差分を読み、試し撮りで確かめる。
 *
 * この module は env も SDK も持たない (Claude は `FixModel` で、検査は `TsCompile` で渡す) ので、
 * 試験と評価の道具 (`src/tools/fix-eval.ts`) が同じ物を使える。
 */
import { createHash } from "node:crypto";

import type { CrawlScript } from "../db/database.js";
import { usdOf, type Usage } from "../claude/prices.js";
import { attributeDiagnostics, TsCompileUnreachable, type TsCompile } from "./ts-compile.js";

/** 決まりの文の版。派生の層に残し、文を変えたら上げる。 */
export const FIX_PROMPT_VERSION = "fix/3";
/** 1 回の頼みの往復の上限。 */
export const FIX_ROUNDS = 2;

export interface FixEdit {
  /** 置き換える最初の行 (1 から)。 */
  from: number;
  /** 置き換える最後の行 (両端を含む)。 */
  to: number;
  text: string;
}

export interface FixNote {
  code: string;
  line: number;
  why: string;
}

export interface FixOutput {
  edits: FixEdit[];
  notes: FixNote[];
}

/** structured outputs に渡す答えの形。 */
export const FIX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      description: "直す TS の行の範囲の置き換え。最初に渡した source の行番号で書く",
      items: {
        type: "object",
        properties: {
          from: { type: "integer", description: "置き換える最初の行 (1 から)" },
          to: { type: "integer", description: "置き換える最後の行 (両端を含む)" },
          text: {
            type: "string",
            description: "置き換えた後の行。改行で複数行にしてよい。行番号は書かない",
          },
        },
        required: ["from", "to", "text"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "array",
      description: "直した誤りごとの理由",
      items: {
        type: "object",
        properties: {
          code: { type: "string", description: "誤りの code (TS7006 など)" },
          line: { type: "integer", description: "誤りの在った行" },
          why: { type: "string", description: "どう直したかを日本語で 1 文" },
        },
        required: ["code", "line", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["edits", "notes"],
  additionalProperties: false,
} as const;

/** 会話の 1 turn。assistant の content は API の答えをそのまま継ぎ足す (thinking の塊を含む)。 */
export type FixMessage =
  { role: "user"; content: string } | { role: "assistant"; content: unknown[] };

/** 1 往復の中の試み 1 つ (fallbacks の前に断った試みも 1 つ)。費用は試みごとに、その model の値で数える。 */
export interface FixAttempt {
  model: string;
  usage: Usage;
}

export interface FixReply {
  /** structured outputs で読めた答え。読めなければ null。 */
  output: FixOutput | null;
  /** 次の往復にそのまま継ぎ足す、assistant の content。 */
  content: unknown[];
  /** 答えた model。fallbacks で別の model が答えることがある。 */
  model: string;
  /** この往復の試み。答えた試みだけでなく、断った試みも並ぶ (`src/claude/client.ts` の `attemptsOf`)。 */
  attempts: readonly FixAttempt[];
  stopReason: string | null;
}

/** Claude の API に届かなかった・断られた以外の誤りで答えが無かった。窓口 (`src/claude/client.ts`) が SDK の誤りを包む。 */
export class ClaudeUnavailable extends Error {
  override name = "ClaudeUnavailable";
}

export interface FixModel {
  /** 派生の層に残す effort。 */
  readonly effort: string;
  propose(request: { system: string; messages: readonly FixMessage[] }): Promise<FixReply>;
}

/** 置き換えた範囲。dashboard が差分 (消した行と足した行) を描く。 */
export interface FixHunk {
  from: number;
  to: number;
  before: string[];
  after: string[];
}

type Attributed = ReturnType<typeof attributeDiagnostics>[number];

/** 往復を足した usage。cache の 2 欄も数で持つ (答えの usage では null のことがある)。 */
export interface UsageTotal {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface Common {
  rounds: number;
  usage: UsageTotal;
  usd: number;
  /** 答えた model (往復ごと)。 */
  models: string[];
  inputSha256: string;
}

export type FixResult =
  | (Common & {
      kind: "fixed";
      source: string;
      hunks: FixHunk[];
      notes: FixNote[];
      compiled: { typescript: string; hostTypes: string };
    })
  | (Common & { kind: "failed"; diagnostics: Attributed[]; refusals: string[] })
  | (Common & { kind: "refused" })
  | (Common & { kind: "unreachable"; message: string })
  | (Common & { kind: "unavailable"; message: string });

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const linesOf = (source: string): { lines: string[]; trailingNewline: boolean } => {
  const trailingNewline = source.endsWith("\n");
  return { lines: (trailingNewline ? source.slice(0, -1) : source).split("\n"), trailingNewline };
};

/** source を行番号つきで書く (`  1| …`)。Claude が行を名指せるように。 */
export const numbered = (source: string): string => {
  const { lines } = linesOf(source);
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}| ${line}`).join("\n");
};

/**
 * 置き換えを当てる。**範囲の外・逆さま・重なりは断る** —— どれも「どこを直したか」が読めない答えなので、
 * 当てて検査に回さない。
 */
export const applyEdits = (
  source: string,
  edits: readonly FixEdit[],
): { source: string; hunks: FixHunk[] } | { refused: string } => {
  if (edits.length === 0) return { refused: "置き換えが 1 つも無い" };
  const { lines, trailingNewline } = linesOf(source);
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  for (const [i, e] of sorted.entries()) {
    if (!Number.isInteger(e.from) || !Number.isInteger(e.to) || e.from < 1 || e.to < e.from) {
      return { refused: `置き換えの範囲が読めない (${String(e.from)}〜${String(e.to)})` };
    }
    if (e.to > lines.length) {
      return {
        refused: `置き換えが source の外 (${String(e.to)} 行目。source は ${String(lines.length)} 行)`,
      };
    }
    const prev = sorted[i - 1];
    if (prev !== undefined && prev.to >= e.from) {
      return {
        refused: `置き換えが重なっている (${String(prev.from)}〜${String(prev.to)} と ${String(e.from)}〜${String(e.to)})`,
      };
    }
  }
  const hunks = sorted.map((e) => ({
    from: e.from,
    to: e.to,
    before: lines.slice(e.from - 1, e.to),
    after: (e.text.endsWith("\n") ? e.text.slice(0, -1) : e.text).split("\n"),
  }));
  const out = [...lines];
  for (const h of [...hunks].reverse()) out.splice(h.from - 1, h.to - h.from + 1, ...h.after);
  return { source: out.join("\n") + (trailingNewline ? "\n" : ""), hunks };
};

const count = (lines: readonly string[], pattern: RegExp): number =>
  lines.reduce((n, line) => n + (line.match(new RegExp(pattern.source, "g"))?.length ?? 0), 0);

/** 黙らせる形と module の形。**置き換えの前より増えたときだけ**断る (元から在る物は Claude のせいではない)。 */
const FORBIDDEN: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /@ts-nocheck|@ts-ignore|@ts-expect-error/, reason: "型の検査を外す注記を足した" },
  { pattern: /\bas\s+any\b|:\s*any\b|<any>/, reason: "any で型の誤りを黙らせた" },
  {
    pattern: /^\s*(?:import|export)\b/,
    reason: "import か export を足した (module になり、BrowserHive では走らない)",
  },
];

/** 断る理由。無ければ undefined。書き換えた行が元の半分 (少なくとも 3 行) を超える案も断る。 */
export const refusalOf = (hunks: readonly FixHunk[], lineCount: number): string | undefined => {
  for (const { pattern, reason } of FORBIDDEN) {
    if (hunks.some((h) => count(h.after, pattern) > count(h.before, pattern))) return reason;
  }
  const changed = hunks.reduce((n, h) => n + (h.to - h.from + 1), 0);
  const limit = Math.max(3, Math.ceil(lineCount / 2));
  if (changed > limit) {
    return `書き換えた行が多すぎる (${String(changed)} 行。上限は ${String(limit)} 行)`;
  }
  return undefined;
};

const describe = (d: Attributed): string =>
  `- ${d.script ?? d.file ?? "?"}:${String(d.line ?? "?")}:${String(d.col ?? "?")} ${d.code} ${d.message}`;

/** 決まりの文。受け皿の型は台帳の写し (`host_types` のいちばん新しい版)。 */
export const systemPrompt = ({
  typescript,
  hostTypes,
}: {
  typescript: string;
  hostTypes: string;
}): string =>
  [
    "あなたは、BrowserHive が取り込みのページで走らせるスクリプト (TypeScript) の、型の誤りを直す。",
    "",
    "## 直してよい物",
    "- 直すのは「直す TS」だけ。「一緒に走るスクリプト」は読むだけで、変えない。名前の重なりは、直す TS の側で避ける。",
    "- 直すのは、型の誤りに要る所だけ。動きを変えない。新しい処理を足さない。",
    "",
    "## 型の検査の条件",
    `- TypeScript ${typescript}、strict。lib は ES の最新と DOM で、dom.iterable は無い (NodeList は Array.from で配列にする)。`,
    "- 一緒に走るスクリプトと 1 つの program として検査される。top-level の名前は互いにぶつかり、DOM の大域 (name・close・status・origin・length など) ともぶつかる。全体を IIFE で包むのがいちばん安全。",
    '- classic script として評価される。import は zod の 2 形 (import { z } from "zod" と import * as z from "zod/mini") だけで、在る物は消さず、足さない。export は書かない (module になり、ページでは黙って走らない)。',
    "- top-level の await (TS1375) には、TypeScript の文が「空の export {} を足せ」と勧めるが、従わない。全体を async の IIFE で包む。",
    "- phase が preload のスクリプトには、受け皿 __bh は無い。",
    "",
    "## 使ってはいけない形",
    "- // @ts-nocheck・@ts-ignore・@ts-expect-error・as any・: any。型の誤りは、型を正しく書くか、null を確かめて直す。",
    "",
    "## 答えの形",
    "- edits: 直す TS の行番号 (1 から) で、from〜to (両端を含む) を text で置き換える。text に行番号を書かない。text は改行で複数行にしてよい。置き換えを重ねない。",
    "- いつも、最初に渡した source に対する置き換えを全部返す (前の答えに足すのではない)。",
    "- notes: 直した誤りごとに、code・行・どう直したか (日本語で 1 文)。",
    "",
    "## 受け皿の型 (host.d.ts)",
    "```ts",
    hostTypes.trimEnd(),
    "```",
  ].join("\n");

const firstRequest = ({
  inline,
  others,
  diagnostics,
}: {
  inline: CrawlScript;
  others: readonly CrawlScript[];
  diagnostics: readonly Attributed[];
}): string =>
  [
    `直す TS: ${inline.id} (phase: ${inline.phase})`,
    "行番号つきの source:",
    numbered(inline.source),
    "",
    "型の誤り (ts-compile-service の答え。ほかのスクリプトや lib の誤りも参考に載せる):",
    ...diagnostics.map(describe),
    "",
    "一緒に走るスクリプト (読むだけ。変えない):",
    ...(others.length === 0
      ? ["(無い)"]
      : others.flatMap((s) => [`--- ${s.id} (phase: ${s.phase})`, s.source.trimEnd()])),
  ].join("\n");

const ZERO: UsageTotal = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const add = (a: UsageTotal, b: Usage): UsageTotal => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + (b.cache_read_input_tokens ?? 0),
  cache_creation_input_tokens: a.cache_creation_input_tokens + (b.cache_creation_input_tokens ?? 0),
});

/**
 * 直し方を訊く。`scripts` は webhook と同じ形の組み合わせ (並びも同じ)、`inlineId` はその中の直す TS。
 * Claude を呼んだ分の usage と費用は、答えがどれでも結果に載る (呼ぶ側が派生の層に残す)。
 */
export const fixInline = async ({
  scripts,
  inlineId,
  diagnostics,
  typescript,
  hostTypes,
  tsCompile,
  model,
  rounds = FIX_ROUNDS,
}: {
  scripts: readonly CrawlScript[];
  inlineId: string;
  diagnostics: readonly Attributed[];
  typescript: string;
  hostTypes: string;
  tsCompile: TsCompile;
  model: FixModel;
  rounds?: number;
}): Promise<FixResult> => {
  const inline = scripts.find((s) => s.id === inlineId);
  if (inline === undefined) throw new Error(`${inlineId} is not among the scripts`);
  const others = scripts.filter((s) => s.id !== inlineId);
  const system = systemPrompt({ typescript, hostTypes });
  const first = firstRequest({ inline, others, diagnostics });
  const messages: FixMessage[] = [{ role: "user", content: first }];
  const { lines } = linesOf(inline.source);

  let usage = ZERO;
  let usd = 0;
  const models: string[] = [];
  const refusals: string[] = [];
  let lastDiagnostics: Attributed[] = [...diagnostics];
  const common = (round: number): Common => ({
    rounds: round,
    usage,
    usd,
    models,
    inputSha256: sha256([FIX_PROMPT_VERSION, system, first].join("\n\n")),
  });

  for (let round = 1; round <= rounds; round++) {
    let reply: FixReply;
    try {
      reply = await model.propose({ system, messages });
    } catch (err) {
      if (!(err instanceof ClaudeUnavailable)) throw err;
      // 前の往復の分の usage は、ここまでに使った額として返す (呼ぶ側が派生の層に残す)
      return { ...common(round - 1), kind: "unavailable", message: err.message };
    }
    for (const attempt of reply.attempts) {
      usage = add(usage, attempt.usage);
      usd += usdOf(attempt.model, attempt.usage);
    }
    models.push(reply.model);
    if (reply.stopReason === "refusal") return { ...common(round), kind: "refused" };

    let feedback: string;
    if (reply.output === null) {
      feedback = "答えが決めた形 (edits と notes) で読めなかった。";
      refusals.push(feedback);
    } else {
      const applied = applyEdits(inline.source, reply.output.edits);
      const refused =
        "refused" in applied ? applied.refused : refusalOf(applied.hunks, lines.length);
      if ("refused" in applied || refused !== undefined) {
        const reason = refused ?? "";
        feedback = `置き換えを断った: ${reason}`;
        refusals.push(reason);
      } else {
        const candidate = { ...inline, source: applied.source, sha256: sha256(applied.source) };
        let answer;
        try {
          answer = await tsCompile.compile(scripts.map((s) => (s.id === inlineId ? candidate : s)));
        } catch (err) {
          if (!(err instanceof TsCompileUnreachable)) throw err;
          return { ...common(round), kind: "unreachable", message: err.message };
        }
        if (answer.ok) {
          return {
            ...common(round),
            kind: "fixed",
            source: applied.source,
            hunks: applied.hunks,
            notes: reply.output.notes,
            compiled: { typescript: answer.typescript, hostTypes: answer.hostTypes },
          };
        }
        lastDiagnostics = attributeDiagnostics(
          answer.diagnostics,
          scripts.map((s) => s.id),
        );
        feedback = [
          "置き換えを当てて検査したが、まだ型の誤りがある:",
          ...lastDiagnostics.map(describe),
        ].join("\n");
      }
    }
    messages.push(
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content: `${feedback}\n最初の source に対する置き換えを、全部、返し直してください。`,
      },
    );
  }
  return { ...common(rounds), kind: "failed", diagnostics: lastDiagnostics, refusals };
};
