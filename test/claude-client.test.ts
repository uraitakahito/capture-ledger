import { describe, expect, it } from "vitest";

import { attemptsOf, CLAUDE_MODEL } from "../src/claude/client.js";

const SERVED = {
  input_tokens: 3000,
  output_tokens: 1000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe("試みごとの usage (attemptsOf)", () => {
  it("iterations が無ければ、top-level の usage を答えた model で数える", () => {
    expect(
      attemptsOf({ model: "claude-opus-5-5", usage: { ...SERVED, iterations: null } }),
    ).toEqual([{ model: "claude-opus-5-5", usage: { ...SERVED, iterations: null } }]);
    expect(
      attemptsOf({ model: "claude-opus-5-5", usage: { ...SERVED, iterations: [] } }),
    ).toHaveLength(1);
  });

  it("fallbacks が答えたら、断った試みと答えた試みを、それぞれの model で並べる (top-level は答えた分だけ)", () => {
    const declined = { input_tokens: 3000, output_tokens: 0, model: "claude-opus-5-5" };
    const served = { ...SERVED, model: "claude-opus-4-8" };
    const attempts = attemptsOf({
      model: "claude-opus-4-8",
      usage: { ...SERVED, iterations: [declined, served] },
    });
    expect(attempts.map((a) => a.model)).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);
    expect(attempts.map((a) => a.usage.input_tokens)).toEqual([3000, 3000]);
  });

  it("model の無い試みは、頼んだ model の物として数える", () => {
    const attempts = attemptsOf({
      model: "claude-opus-5-5",
      usage: { ...SERVED, iterations: [{ ...SERVED, model: null }] },
    });
    expect(attempts).toEqual([{ model: CLAUDE_MODEL, usage: { ...SERVED, model: null } }]);
  });
});
