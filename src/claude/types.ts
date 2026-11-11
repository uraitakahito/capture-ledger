/**
 * Claude のクライアントの型 (CAPTURE-167)。**SDK を読まない** —— 直す係 (`src/scripts/fix.ts`) や前回からの変化の係は、
 * この型だけを知り、試験は SDK なしで偽の `Claude` を渡せる。SDK で答えるのは `src/claude/client.ts` の `claudeOf`。
 */
import type { Usage } from "./prices.js";

/** Claude に渡す深さ。capture-ledger の係が使うのはこの 3 つ。 */
export type ClaudeEffort = "low" | "medium" | "high";

/** 会話の 1 turn。assistant の content は API の答えをそのまま継ぎ足す (thinking の塊を含む)。 */
export type ClaudeMessage =
  { role: "user"; content: string } | { role: "assistant"; content: unknown[] };

/** 1 往復の中の試み 1 つ (fallbacks の前に断った試みも 1 つ)。費用は試みごとに、その model の値で数える。 */
export interface ClaudeAttempt {
  model: string;
  usage: Usage;
}

export interface ClaudeRequest {
  /** 決まりの文。cache に載せる。 */
  system: string;
  messages: readonly ClaudeMessage[];
  /** 答えの形 (JSON Schema)。structured outputs で縛る。 */
  schema: Record<string, unknown>;
  effort: ClaudeEffort;
  /** 1 往復の出力の上限 (thinking を含む)。 */
  maxTokens: number;
}

export interface ClaudeReply<T = unknown> {
  /** structured outputs で読めた答え。読めなければ null。 */
  output: T | null;
  /** 次の往復にそのまま継ぎ足す、assistant の content。 */
  content: unknown[];
  /** 答えた model。fallbacks で別の model が答えることがある。 */
  model: string;
  /** この往復の試み。答えた試みだけでなく、断った試みも並ぶ (`attemptsOf`)。 */
  attempts: readonly ClaudeAttempt[];
  stopReason: string | null;
}

export interface Claude {
  /** 答えの形は `schema` で縛られるので、`T` はそれと同じ形を書く。 */
  ask<T>(request: ClaudeRequest): Promise<ClaudeReply<T>>;
}

/** Claude の API に届かなかった・断られた以外の誤りで答えが無かった。クライアントが SDK の誤りを包む。 */
export class ClaudeUnavailable extends Error {
  override name = "ClaudeUnavailable";
}
