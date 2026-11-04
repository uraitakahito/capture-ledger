import { describe, expect, it } from "vitest";

import { usdOf } from "../src/claude/prices.js";

describe("Claude の費用の数え方", () => {
  it("入力・出力・cache の読み出し・書き込みを、別々の値で数える", () => {
    // claude-opus-5-5: 入力 $4・出力 $20・cache の読み出し $0.20・書き込み $5 (100 万 tokens あたり)
    const usd = usdOf("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 200_000,
    });
    expect(usd).toBeCloseTo(4 + 2 + 0.2 + 1, 9);
  });

  it("cache の欄が null でも数えられる", () => {
    expect(
      usdOf("claude-opus-5-5", {
        input_tokens: 3100,
        output_tokens: 900,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toBeCloseTo(0.0304, 9);
  });

  it("表に無い model (fallbacks が答えたとき) は、表でいちばん高い値で数える", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(usdOf("claude-someday-9", usage)).toBeCloseTo(10, 9);
    expect(usdOf("claude-someday-9", usage)).toBeGreaterThan(usdOf("claude-opus-5-5", usage));
  });
});
