import { describe, it, expect } from "vitest";
import { describeGrant, type GrantReport } from "../src/fga/grant-report.js";

/**
 * `fga:grant` / `fga:revoke` の 1 文。
 *
 * 主文は訊き直した答え (`canSubmit`) で決まり、書いた内容では決まらない —— それを見るため、
 * 同じ書き込みに別の答えを渡す組を並べてある。
 */
const base: GrantReport = {
  user: "windmill",
  relation: "submitter",
  org: "acme",
  remove: false,
  changed: true,
  canSubmit: true,
};

describe("describeGrant", () => {
  it("書いて、起こせるようになった", () => {
    expect(describeGrant(base)).toBe(
      "windmill は acme のクロールを起こせます (書いた: user:windmill submitter organization:acme)",
    );
  });

  it("もう在った", () => {
    expect(describeGrant({ ...base, changed: false })).toBe(
      "windmill は acme のクロールを起こせます (もう在った: user:windmill submitter organization:acme)",
    );
  });

  it("消して、起こせなくなった", () => {
    expect(describeGrant({ ...base, remove: true, canSubmit: false })).toBe(
      "windmill は acme のクロールを起こせません (消した: user:windmill submitter organization:acme)",
    );
  });

  it("もう無かった", () => {
    expect(describeGrant({ ...base, remove: true, changed: false, canSubmit: false })).toBe(
      "windmill は acme のクロールを起こせません (もう無かった: user:windmill submitter organization:acme)",
    );
  });

  it("消しても、ほかの関係で起こせるなら、そう言う（消えたと読ませない）", () => {
    expect(describeGrant({ ...base, remove: true, canSubmit: true })).toBe(
      "windmill は acme のクロールを起こせます (消した: user:windmill submitter organization:acme。ほかの関係で許されています)",
    );
  });

  it("書いたのに起こせないなら、model ID を疑わせる", () => {
    expect(describeGrant({ ...base, canSubmit: false })).toBe(
      "windmill は acme のクロールを起こせません (書いた: user:windmill submitter organization:acme。" +
        "書いたのに Check が通りません —— CAPTURE_LEDGER_FGA_MODEL_ID が古い model を指していないか)",
    );
  });

  it("admin を書いても、主文は同じ問いの答え", () => {
    expect(describeGrant({ ...base, relation: "admin" })).toBe(
      "windmill は acme のクロールを起こせます (書いた: user:windmill admin organization:acme)",
    );
  });
});
