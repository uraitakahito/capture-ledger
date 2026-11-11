/**
 * 直す係の Claude を、env から作る。**API の起動時に読む** (`src/api/server.ts`)。クライアントそのものは
 * `src/claude/client.ts` で、env を読まない。
 *
 * **鍵は capture-ledger の名前 (`CAPTURE_LEDGER_ANTHROPIC_API_KEY`) で読んで渡す。** SDK は、渡さなければ自分で
 * `ANTHROPIC_API_KEY` を読むが、それでは `src/tools/check-env.ts` にも起動の 1 行目の名前の一覧にも
 * 載らない。
 */
import Anthropic from "@anthropic-ai/sdk";

import { optional } from "./env.js";
import { fixModelOf } from "../claude/client.js";
import type { FixModel } from "../scripts/fix.js";

/** 1 往復を待つ時間。effort medium の 1 往復は数十秒かかりうる。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 組織ごとの月の上限 (USD)。 */
const DEFAULT_BUDGET_USD = 5;

/** 鍵が無ければ `undefined` —— その配備に直す係は無く、エンドポイントを出さない。 */
export const createFixModel = (): FixModel | undefined => {
  const apiKey = optional("CAPTURE_LEDGER_ANTHROPIC_API_KEY", "");
  if (apiKey === "") return undefined;
  const timeout = Number(optional("CAPTURE_LEDGER_CLAUDE_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)));
  return fixModelOf(new Anthropic({ apiKey, timeout }));
};

/** 組織ごとの月の上限 (USD)。負の数や数でない値は起動で止める (上限が黙って効かなくならないように)。 */
export const claudeBudgetUsd = (): number => {
  const raw = optional("CAPTURE_LEDGER_CLAUDE_BUDGET_USD", String(DEFAULT_BUDGET_USD));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`CAPTURE_LEDGER_CLAUDE_BUDGET_USD must be a number of dollars, not "${raw}"`);
  }
  return value;
};
