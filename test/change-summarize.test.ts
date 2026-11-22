import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Claude, ClaudeReply } from "../src/claude/types.js";
import type { DiffLine } from "../src/changes/change-of.js";
import {
  CHANGE_RUBRIC,
  changeInputOf,
  changeInputSha256,
  heaviest,
  PAIR_PROMPT,
  PAIR_RUBRIC,
  summarizeChanges,
  unverifiedQuotes,
  type ChangeOutput,
} from "../src/changes/summarize.js";
import { canonicalJson } from "../src/crawl/recipe-digest.js";

const USAGE = {
  input_tokens: 771,
  output_tokens: 335,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 1043,
};

const DATADOG: DiffLine[][] = [
  [
    " Platform",
    "-THE FORRESTER WAVE™: AIOPS PLATFORMS, Q4 2026",
    "+EBOOK: MIGRATE TO GOOGLE CLOUD WITHOUT DISRUPTION",
    " Read",
  ],
];
const CLOUDFLARE: DiffLine[][] = [["-Updated 11.10.26, 13:42", "+Updated 11.10.26, 19:00"]];
const PAGES = [
  { url: "https://www.datadoghq.com/", hunks: DATADOG },
  { url: "https://www.cloudflare.com/", hunks: CLOUDFLARE },
];

const fakeClaude = (reply: Partial<ClaudeReply<ChangeOutput>>) => {
  const asked: Parameters<Claude["ask"]>[0][] = [];
  const claude: Claude = {
    ask<T>(request: Parameters<Claude["ask"]>[0]) {
      asked.push(request);
      return Promise.resolve({
        output: null,
        content: [],
        model: "claude-opus-5-5",
        attempts: [{ model: "claude-opus-5-5", usage: USAGE }],
        stopReason: "end_turn",
        ...reply,
      } as unknown as ClaudeReply<T>);
    },
  };
  return { claude, asked };
};

describe("引用の照合 (unverifiedQuotes)", () => {
  it("変わった行の一部なら通し、文脈の行・ほかのページの行・空の引用は印を付ける", () => {
    expect(unverifiedQuotes(["EBOOK: MIGRATE TO GOOGLE CLOUD"], DATADOG)).toEqual([]);
    expect(unverifiedQuotes(["Platform"], DATADOG)).toEqual(["Platform"]);
    expect(unverifiedQuotes(["Updated 11.10.26, 19:00"], DATADOG)).toEqual([
      "Updated 11.10.26, 19:00",
    ]);
    expect(unverifiedQuotes(["  "], DATADOG)).toEqual(["  "]);
  });
});

describe("回の要約 (summarizeChanges)", () => {
  it("差分と前後の行だけを渡し、答えのページに照らせなかった引用を足し、一番重い重さを返す", async () => {
    const { claude, asked } = fakeClaude({
      output: {
        headline: "中身の変化は無い。宣伝と更新時刻が入れ替わった",
        pages: [
          {
            url: "https://www.datadoghq.com/",
            significance: "minor",
            headline: "広告の枠",
            quotes: ["EBOOK: MIGRATE TO GOOGLE CLOUD WITHOUT DISRUPTION", "ok"],
          },
          {
            url: "https://www.cloudflare.com/",
            significance: "none",
            headline: "更新時刻だけ",
            quotes: ["Updated 11.10.26, 19:00"],
          },
        ],
      },
    });
    const result = await summarizeChanges(claude, PAGES);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.effort).toBe("low");
    expect(JSON.parse(asked[0]?.messages[0]?.content as string)).toEqual({
      pages: [
        { url: "https://www.datadoghq.com/", diff: DATADOG[0] },
        { url: "https://www.cloudflare.com/", diff: CLOUDFLARE[0] },
      ],
    });
    if (result.kind !== "summarized") throw new Error(result.kind);
    expect(result.significance).toBe("minor");
    // 差分に無い引用 ("ok") に印。照合を外すとここが赤になる
    expect(result.summary.pages[0]?.quotesUnverified).toEqual(["ok"]);
    expect(result.summary.pages[1]?.quotesUnverified).toEqual([]);
    expect(result.usd).toBeGreaterThan(0);
  });

  it("断られたら refused、決めた形で読めなければ unreadable (費用は返す)", async () => {
    expect((await summarizeChanges(fakeClaude({ stopReason: "refusal" }).claude, PAGES)).kind).toBe(
      "refused",
    );
    const unreadable = await summarizeChanges(fakeClaude({ output: null }).claude, PAGES);
    expect(unreadable.kind).toBe("unreadable");
    expect(unreadable.usd).toBeGreaterThan(0);
  });

  it("入力の digest は同じ差分なら同じ、1 行違えば違う", () => {
    expect(changeInputSha256(PAGES)).toBe(changeInputSha256(structuredClone(PAGES)));
    expect(changeInputSha256([PAGES[0]!])).not.toBe(changeInputSha256(PAGES));
  });

  it("周回の入力と digest は、手の比較の決まりの文を足しても変わらない（capture の欄を持たない）", () => {
    expect(changeInputOf(PAGES)).toEqual({
      pages: PAGES.map((page) => ({ url: page.url, diff: page.hunks.flat() })),
    });
    expect(changeInputSha256(PAGES)).toBe(
      createHash("sha256")
        .update(
          canonicalJson({ v: "change-v1", rubric: CHANGE_RUBRIC, input: changeInputOf(PAGES) }),
        )
        .digest("hex"),
    );
  });

  it("手の比較の digest は、同じ差分でも周回の digest と違い、撮り方の違いでも変わる", () => {
    const same = { recipeDiffers: false, stageDiffers: false };
    const pair = changeInputSha256(PAGES, PAIR_PROMPT, same);
    expect(pair).not.toBe(changeInputSha256(PAGES));
    expect(pair).not.toBe(changeInputSha256(PAGES, PAIR_PROMPT, { ...same, recipeDiffers: true }));
    expect(pair).not.toBe(changeInputSha256(PAGES, PAIR_PROMPT, { ...same, stageDiffers: true }));
    expect(changeInputOf(PAGES, same)).toMatchObject({ capture: same });
  });

  it("手の比較の決まりの文で頼むと、Claude にはその文と capture つきの入力が渡る", async () => {
    const { claude, asked } = fakeClaude({ output: { headline: "x", pages: [] } });
    const capture = { recipeDiffers: true, stageDiffers: false };
    const result = await summarizeChanges(claude, PAGES, PAIR_PROMPT, capture);
    expect(asked[0]?.system).toBe(PAIR_RUBRIC);
    expect(JSON.parse(asked[0]?.messages[0]?.content as string)).toMatchObject({ capture });
    expect(result.inputSha256).toBe(changeInputSha256(PAGES, PAIR_PROMPT, capture));
  });

  it("一番重い重さ: none < minor < content", () => {
    expect(heaviest([])).toBe("none");
    expect(heaviest(["minor", "none"])).toBe("minor");
    expect(heaviest(["minor", "content", "none"])).toBe("content");
  });
});
