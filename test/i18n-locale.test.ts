/**
 * 頼みの言語の決め方 (`src/i18n/locale.ts`)。capture-ledger が自分で訳す文を、どの言語で返すか。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, localeOf } from "../src/i18n/locale.js";

describe("localeOf", () => {
  it("言語の付かない頼みには英語", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(localeOf(undefined)).toBe("en");
    expect(localeOf("")).toBe("en");
  });

  it.each([
    ["ja", "ja"],
    ["en", "en"],
    ["JA", "ja"],
    // 頭の subtag だけを見る
    ["ja-JP", "ja"],
    ["en-US", "en"],
    // browser が付ける形。重みの大きい順
    ["ja,en-US;q=0.9,en;q=0.8", "ja"],
    ["en-US,en;q=0.9,ja;q=0.8", "en"],
    ["ja;q=0.1,en", "en"],
    ["en;q=0.3, ja;q=0.7", "ja"],
    // 同じ重みなら、書いた順
    ["en,ja", "en"],
    ["ja,en", "ja"],
    // 辞書の無い言語は飛ばす
    ["fr,ja;q=0.2", "ja"],
    ["fr-FR, de;q=0.9, en;q=0.1", "en"],
  ])("%s → %s", (header, expected) => {
    expect(localeOf(header)).toBe(expected);
  });

  it("q=0 は「受けない」。外して、残りから選ぶ", () => {
    expect(localeOf("en;q=0, ja")).toBe("ja");
    expect(localeOf("ja;q=0, en;q=0.1")).toBe("en");
    // 受ける言語が残らなければ、既定
    expect(localeOf("ja;q=0")).toBe("en");
  });

  it.each(["fr", "*", "*;q=0.5", "x", ",,,", "ja;q=abc", "ja;q=2", "ja;q=-1", "日本語", ";q=1"])(
    "当たる言語が無い・読めない値は既定の英語: %j",
    (header) => {
      expect(localeOf(header)).toBe("en");
    },
  );
});
