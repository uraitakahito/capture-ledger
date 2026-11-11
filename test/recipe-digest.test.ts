import { describe, expect, it } from "vitest";

import { canonicalJson, recipeDigestOf, type RecipeParts } from "../src/crawl/recipe-digest.js";

const BASE: RecipeParts = {
  scripts: [
    {
      id: "autoscroll",
      version: 2,
      phase: "behavior",
      sha256: "a".repeat(64),
      options: { steps: 3, wait: 100 },
    },
    { id: "egov-law-search", version: 1, phase: "behavior", sha256: "b".repeat(64), options: {} },
  ],
  variables: { query: "民法", page: "1" },
  userAgent: "",
  secretNames: ["token", "cookie"],
};

describe("撮り方の digest (recipeDigestOf)", () => {
  it("鍵の並びは問わない (jsonb から読み戻した物でも同じ値)", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const reordered: RecipeParts = {
      ...BASE,
      scripts: [{ ...BASE.scripts[0]!, options: { wait: 100, steps: 3 } }, BASE.scripts[1]!],
      variables: { page: "1", query: "民法" },
      secretNames: ["cookie", "token"],
    };
    expect(recipeDigestOf(reordered)).toBe(recipeDigestOf(BASE));
  });

  it("同じ起点でも変数の値が違えば違う (e-Gov の「25 件」と「4 件」の形)", () => {
    expect(recipeDigestOf({ ...BASE, variables: { query: "商法", page: "1" } })).not.toBe(
      recipeDigestOf(BASE),
    );
  });

  it("スクリプトの版・sha256・並び・User-Agent・シークレットの名前が違えば違う", () => {
    const d = recipeDigestOf(BASE);
    expect(
      recipeDigestOf({ ...BASE, scripts: [{ ...BASE.scripts[0]!, version: 3 }, BASE.scripts[1]!] }),
    ).not.toBe(d);
    expect(
      recipeDigestOf({
        ...BASE,
        scripts: [{ ...BASE.scripts[0]!, sha256: "c".repeat(64) }, BASE.scripts[1]!],
      }),
    ).not.toBe(d);
    expect(recipeDigestOf({ ...BASE, scripts: [BASE.scripts[1]!, BASE.scripts[0]!] })).not.toBe(d);
    expect(recipeDigestOf({ ...BASE, userAgent: "Mozilla/5.0 BrowserHive" })).not.toBe(d);
    expect(recipeDigestOf({ ...BASE, secretNames: ["token"] })).not.toBe(d);
  });

  it("スクリプトの写しに付く source や compiled は入れない", () => {
    const withExtra = {
      ...BASE,
      scripts: BASE.scripts.map((s) => ({
        ...s,
        source: "// 本文",
        compiled: { sha256: "d".repeat(64) },
      })),
    };
    expect(recipeDigestOf(withExtra)).toBe(recipeDigestOf(BASE));
  });
});
