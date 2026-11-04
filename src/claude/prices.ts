/**
 * Claude の料金 (USD / 100 万 tokens)。opus-5-5 と fable-5-1 は 2026-10-06、opus-4-8 は 2026-11-04 の表。
 *
 * 組織ごとの月の上限は、派生の層 (`026`) に残した `usd` を足して数える。`input_tokens` には cache の
 * 読み出しと書き込みの tokens は入らない (usage の別の欄) ので、4 つを別々に数える。
 */

export interface Price {
  input: number;
  output: number;
  /** cache の読み出し。 */
  cacheRead: number;
  /** cache の書き込み (5 分の cache。入力の 1.25 倍)。 */
  cacheWrite: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  // `fallbacks: "default"` が cyber の分類の断りを回す先
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/**
 * 表に無い model で数える値。fallbacks が表に無い model で答えたときに当たる。**表でいちばん高い値で数える**
 * —— 安く数えて上限を甘くしないため (多く数えた分は、月の上限が早めに効くだけで済む)。
 */
const UNKNOWN: Price = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** 1 回の答えの費用 (USD)。 */
export const usdOf = (model: string, usage: Usage): number => {
  const price = PRICES[model] ?? UNKNOWN;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.input_tokens * perToken(price.input) +
    usage.output_tokens * perToken(price.output) +
    (usage.cache_read_input_tokens ?? 0) * perToken(price.cacheRead) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(price.cacheWrite)
  );
};
