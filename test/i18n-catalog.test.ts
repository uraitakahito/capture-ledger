/**
 * capture-ledger が自分で訳す文 (`src/i18n/messages.ts`) の、鍵の表と辞書の揃い。
 *
 * - 日本語と英語の辞書が、鍵の表 (`MESSAGE_KEYS`) とちょうど同じ鍵を持つ
 * - どの文も、表の値の名前をちょうど全部埋める (足りない・余る値が無い)
 * - 鍵と値の名前は約束 (DB の行と、答えの `errorKey`・`errorParams` に残る)。足す・消す・替えると、下の表で赤になる
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { LOCALES, MESSAGE_KEYS, message, render, say } from "../src/i18n/messages.js";

const load = (locale: string): Record<string, string> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url)),
      "utf-8",
    ),
  ) as Record<string, string>;

/** 約束した鍵と値の名前。`MESSAGE_KEYS` を変えたら、ここと、保存済みの行の扱いを見直す。 */
const EXPECTED_KEYS: Record<string, readonly string[]> = {
  "crawl.nothingCaptured": ["failed", "skipped"],
  "crawl.nothingCapturedBecause": ["failed", "skipped", "reason"],
  "crawl.nothingCapturedBackfilled": [],
};

/** 雛形が埋める値の名前 (`{name}` と `{name, plural, …}` の頭の名前を拾う)。 */
const namesIn = (pattern: string): string[] =>
  [
    ...new Set(
      [...pattern.matchAll(/\{\s*([A-Za-z][A-Za-z0-9]*)\s*[,}]/gu)].map((m) => m[1] ?? ""),
    ),
  ].sort();

/** どの文も、読み解ける雛形であること (波括弧の閉じ忘れなどは、ここで投げる)。 */
const parses = (pattern: string): boolean => {
  try {
    new IntlMessageFormat(pattern, "en");
    return true;
  } catch {
    return false;
  }
};

describe("文の鍵の表", () => {
  it("約束した鍵と値の名前のまま", () => {
    expect(MESSAGE_KEYS).toEqual(EXPECTED_KEYS);
  });

  it("鍵は <まとまり>.<意味> の形", () => {
    for (const key of Object.keys(MESSAGE_KEYS)) {
      expect(key).toMatch(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/u);
    }
  });
});

describe.each(LOCALES)("辞書 %s", (locale) => {
  const catalog = load(locale);

  it("鍵の表とちょうど同じ鍵を持つ", () => {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(MESSAGE_KEYS).sort());
  });

  it("どの文も、表の値の名前をちょうど全部埋める", () => {
    for (const [key, names] of Object.entries(EXPECTED_KEYS)) {
      expect(parses(catalog[key] ?? "{"), key).toBe(true);
      expect(namesIn(catalog[key] ?? ""), key).toEqual([...names].sort());
    }
  });
});

describe("render", () => {
  it("日本語は、今までの字と 1 字も違わない", () => {
    expect(
      render("crawl.nothingCapturedBecause", { failed: 0, skipped: 1, reason: "robots" }, "ja"),
    ).toBe("1 枚も撮れませんでした（取れず 0・見送り 1）。最初の理由: robots");
    expect(render("crawl.nothingCaptured", { failed: 1234567, skipped: 0 }, "ja")).toBe(
      "1 枚も撮れませんでした（取れず 1234567・見送り 0）。",
    );
    expect(render("crawl.nothingCapturedBackfilled", {}, "ja")).toBe(
      "1 枚も撮れませんでした（030 で直した過去の行）",
    );
  });

  it("英語", () => {
    expect(
      render("crawl.nothingCapturedBecause", { failed: 0, skipped: 1, reason: "robots" }, "en"),
    ).toBe("No pages were captured (0 failed, 1 skipped). First reason: robots");
    expect(render("crawl.nothingCaptured", { failed: 2, skipped: 0 }, "en")).toBe(
      "No pages were captured (2 failed, 0 skipped).",
    );
    expect(render("crawl.nothingCapturedBackfilled", {}, "en")).toBe(
      "No pages were captured (a past row fixed by migration 030).",
    );
  });

  it("理由の字は文として読み解かない (雛形の記号を含んでも、そのまま出る)", () => {
    const reason = "robots {x} 'q' <b>#</b>";
    expect(render("crawl.nothingCapturedBecause", { failed: 1, skipped: 0, reason }, "en")).toBe(
      `No pages were captured (1 failed, 0 skipped). First reason: ${reason}`,
    );
  });

  it("組めなければ undefined (知らない鍵・値が足りない・値の形が違う)", () => {
    expect(render("crawl.unknown", {}, "ja")).toBeUndefined();
    expect(render("crawl.nothingCapturedBecause", { failed: 1 }, "ja")).toBeUndefined();
    expect(render("crawl.nothingCaptured", null, "ja")).toBeUndefined();
    expect(render("crawl.nothingCaptured", [1, 2], "ja")).toBeUndefined();
    expect(render("crawl.nothingCaptured", { failed: {}, skipped: 0 }, "ja")).toBeUndefined();
    // Object の持つ名前 (`toString` など) を鍵と読まない
    expect(render("toString", {}, "ja")).toBeUndefined();
  });

  it("say は message() の文を必ず組む", () => {
    expect(say(message("crawl.nothingCaptured", { failed: 0, skipped: 0 }), "en")).toBe(
      "No pages were captured (0 failed, 0 skipped).",
    );
  });
});
