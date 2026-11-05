import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CrawlScript } from "../src/db/database.js";
import {
  applyEdits,
  ClaudeUnavailable,
  fixInline,
  numbered,
  refusalOf,
  type FixMessage,
  type FixModel,
  type FixOutput,
  type FixReply,
} from "../src/scripts/fix.js";
import type { CompileAnswer, TsCompile } from "../src/scripts/ts-compile.js";

/**
 * 直す係の輪。Claude と ts-compile は偽物で、**Claude の案が検査に通るまで画面に出さない**ことと、
 * **会話を継ぎ足すだけにする**ことを見る。
 */
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const script = (id: string, source: string): CrawlScript => ({
  id,
  version: 1,
  phase: "behavior",
  source,
  sha256: sha256(source),
  options: {},
});

const BROKEN = "(() => {\n  const press = (el) => el.click();\n  void press;\n})();\n";
const INLINE = script("inline-press", BROKEN);
const CATALOG = script("autoscroll", "(async () => {})();\n");
const SCRIPTS = [INLINE, CATALOG];
const DIAGNOSTICS = [
  {
    script: "inline-press",
    line: 2,
    col: 18,
    code: "TS7006",
    message: "Parameter 'el' implicitly has an 'any' type.",
  },
];
const FIXED_LINE = "  const press = (el: HTMLElement) => el.click();";
const GOOD: FixOutput = {
  edits: [{ from: 2, to: 2, text: FIXED_LINE }],
  notes: [{ code: "TS7006", line: 2, why: "引数 el に型を書いた" }],
};
const USAGE = {
  input_tokens: 3000,
  output_tokens: 1000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const reply = (output: FixOutput | null, extra: Partial<FixReply> = {}): FixReply => ({
  output,
  content: [
    { type: "thinking", thinking: "…", signature: "sig" },
    { type: "text", text: JSON.stringify(output) },
  ],
  model: "claude-opus-5-5",
  attempts: [{ model: "claude-opus-5-5", usage: USAGE }],
  stopReason: "end_turn",
  ...extra,
});

/** 決めた答えを順に返す偽の Claude。頼まれた会話を写して控える。 */
const fakeModel = (replies: (FixReply | Error)[]) => {
  const asked: { system: string; messages: FixMessage[] }[] = [];
  const model: FixModel = {
    effort: "medium",
    propose(request) {
      asked.push({ system: request.system, messages: structuredClone([...request.messages]) });
      const next = replies.shift();
      if (next === undefined) throw new Error("頼みが多すぎる");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { asked, model };
};

/** 決めた答えを順に返す偽の ts-compile。頼まれた列を控える。 */
const fakeCompile = (answers: CompileAnswer[]) => {
  const asked: (readonly CrawlScript[])[] = [];
  const tsCompile: TsCompile = {
    compile(scripts) {
      asked.push(scripts);
      const next = answers.shift();
      if (next === undefined) throw new Error("検査が多すぎる");
      return Promise.resolve(next);
    },
  };
  return { asked, tsCompile };
};
const PASSES: CompileAnswer = { ok: true, typescript: "6.0.3", hostTypes: "v0.6.0" };
const STILL_BROKEN: CompileAnswer = {
  ok: false,
  typescript: "6.0.3",
  diagnostics: [
    {
      file: "inline-press.ts",
      line: 2,
      col: 9,
      code: "TS2451",
      message: "Cannot redeclare block-scoped variable 'press'.",
    },
  ],
};

const run = (model: FixModel, tsCompile: TsCompile) =>
  fixInline({
    scripts: SCRIPTS,
    inlineId: INLINE.id,
    diagnostics: DIAGNOSTICS,
    typescript: "6.0.3",
    hostTypes: "declare var __bh: unknown;",
    tsCompile,
    model,
  });

describe("置き換えを当てる", () => {
  it("行の範囲を置き換え、消した行と足した行を返す", () => {
    const applied = applyEdits(BROKEN, GOOD.edits);
    expect(applied).toEqual({
      source: `(() => {\n${FIXED_LINE}\n  void press;\n})();\n`,
      hunks: [
        { from: 2, to: 2, before: ["  const press = (el) => el.click();"], after: [FIXED_LINE] },
      ],
    });
  });

  it("全体を包むのは、最初と最後の行の置き換え 2 つで書ける", () => {
    const applied = applyEdits("const name = 1;\nvoid name;\n", [
      { from: 1, to: 1, text: "(() => {\n  const name = 1;" },
      { from: 2, to: 2, text: "  void name;\n})();" },
    ]);
    expect("source" in applied && applied.source).toBe(
      "(() => {\n  const name = 1;\n  void name;\n})();\n",
    );
  });

  it("範囲の外・逆さま・重なり・空は断る", () => {
    expect(applyEdits(BROKEN, [{ from: 9, to: 9, text: "x" }])).toHaveProperty("refused");
    expect(applyEdits(BROKEN, [{ from: 3, to: 2, text: "x" }])).toHaveProperty("refused");
    expect(
      applyEdits(BROKEN, [
        { from: 1, to: 2, text: "x" },
        { from: 2, to: 3, text: "y" },
      ]),
    ).toHaveProperty("refused");
    expect(applyEdits(BROKEN, [])).toHaveProperty("refused");
  });

  it("行番号つきで書く", () => {
    expect(numbered("a\nb\n")).toBe("1| a\n2| b");
  });
});

describe("断る形", () => {
  const hunk = (before: string, after: string) => [
    { from: 1, to: 1, before: [before], after: [after] },
  ];

  it("@ts-nocheck・@ts-ignore・as any・: any を足した案は断る", () => {
    expect(refusalOf(hunk("x;", "// @ts-nocheck\nx;".split("\n")[0]!), 10)).toContain(
      "型の検査を外す",
    );
    expect(refusalOf(hunk("f(el);", "f(el as any);"), 10)).toContain("any");
    expect(refusalOf(hunk("const f = (el) => 1;", "const f = (el: any) => 1;"), 10)).toContain(
      "any",
    );
  });

  it("import か export を足した案は断る (TS1375 の文が勧める export {} も)", () => {
    expect(refusalOf(hunk("await f();", "export {};"), 10)).toContain("export");
  });

  it("元から在った any は断らない (増えたときだけ)", () => {
    expect(
      refusalOf(hunk("f(el as any); g(el)", "f(el as any); g(el as HTMLElement)"), 10),
    ).toBeUndefined();
  });

  it("書き換えた行が元の半分 (少なくとも 3 行) を超える案は断る", () => {
    const lines = (n: number): string[] => Array.from({ length: n }, () => "x");
    const many = [{ from: 1, to: 6, before: lines(6), after: ["y"] }];
    expect(refusalOf(many, 10)).toContain("多すぎる");
    expect(refusalOf([{ from: 1, to: 3, before: lines(3), after: ["y"] }], 4)).toBeUndefined();
  });
});

describe("直し方を訊く輪", () => {
  it("型の通る案なら 1 往復で返し、その場の TS だけを替えた組み合わせを検査に通す", async () => {
    const { model } = fakeModel([reply(GOOD)]);
    const { asked, tsCompile } = fakeCompile([PASSES]);
    const result = await run(model, tsCompile);
    expect(result.kind).toBe("fixed");
    expect(result.rounds).toBe(1);
    expect(asked).toHaveLength(1);
    const sent = asked[0]!;
    // 並びは元のまま。台帳のスクリプトは変えない。その場の TS は sha256 を打ち直す
    expect(sent.map((s) => s.id)).toEqual(["inline-press", "autoscroll"]);
    expect(sent[1]).toEqual(CATALOG);
    expect(sent[0]!.source).toContain(FIXED_LINE);
    expect(sent[0]!.sha256).toBe(sha256(sent[0]!.source));
  });

  it("1 回目が型で落ちたら、検査の答えを足して 2 回目で通す", async () => {
    const { asked, model } = fakeModel([reply(GOOD), reply(GOOD)]);
    const { tsCompile } = fakeCompile([STILL_BROKEN, PASSES]);
    const result = await run(model, tsCompile);
    expect(result.kind).toBe("fixed");
    expect(result.rounds).toBe(2);
    expect(asked[1]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(String(asked[1]!.messages.at(-1)!.content)).toContain("TS2451");
  });

  it("2 回目の頼みは、1 回目の会話を書き換えずに継ぎ足す (thinking の塊ごと)", async () => {
    const first = reply(GOOD);
    const { asked, model } = fakeModel([first, reply(GOOD)]);
    const { tsCompile } = fakeCompile([STILL_BROKEN, PASSES]);
    await run(model, tsCompile);
    expect(asked[0]!.messages).toHaveLength(1);
    expect(asked[1]!.messages).toHaveLength(3);
    expect(asked[1]!.messages[0]).toEqual(asked[0]!.messages[0]);
    expect(asked[1]!.messages[1]).toEqual({ role: "assistant", content: first.content });
    expect(asked[1]!.system).toBe(asked[0]!.system);
  });

  it("2 回で通らなければ、最後の誤りと断った理由を返す", async () => {
    const silencing: FixOutput = {
      edits: [{ from: 2, to: 2, text: "  // @ts-ignore\n  const press = (el) => el.click();" }],
      notes: [],
    };
    const { model } = fakeModel([reply(silencing), reply(GOOD)]);
    const { asked, tsCompile } = fakeCompile([STILL_BROKEN]);
    const result = await run(model, tsCompile);
    expect(result.kind).toBe("failed");
    expect(result.rounds).toBe(2);
    // 黙らせる案は検査に回さない (検査は 2 回目の 1 度だけ)
    expect(asked).toHaveLength(1);
    expect(result.kind === "failed" && result.refusals[0]).toContain("型の検査を外す");
    expect(result.kind === "failed" && result.diagnostics[0]).toMatchObject({
      script: "inline-press",
      code: "TS2451",
    });
  });

  it("答えが形で読めなければ、検査に回さずにその旨を返して訊き直す", async () => {
    const { asked, model } = fakeModel([reply(null), reply(GOOD)]);
    const { tsCompile } = fakeCompile([PASSES]);
    const result = await run(model, tsCompile);
    expect(result.kind).toBe("fixed");
    expect(String(asked[1]!.messages.at(-1)!.content)).toContain("読めなかった");
  });

  it("安全の判定で断られたら、その場で返す (検査も 2 回目も無い)", async () => {
    const { asked, model } = fakeModel([reply(null, { stopReason: "refusal" })]);
    const { asked: compiled, tsCompile } = fakeCompile([]);
    const result = await run(model, tsCompile);
    expect(result.kind).toBe("refused");
    expect(asked).toHaveLength(1);
    expect(compiled).toHaveLength(0);
  });

  it("Claude に届かなければ、それまでの往復の費用を付けて返す", async () => {
    const { model } = fakeModel([reply(GOOD), new ClaudeUnavailable("529 overloaded")]);
    const { tsCompile } = fakeCompile([STILL_BROKEN]);
    const result = await run(model, tsCompile);
    expect(result.kind).toBe("unavailable");
    expect(result.rounds).toBe(1);
    expect(result.usage.input_tokens).toBe(3000);
    expect(result.usd).toBeGreaterThan(0);
  });

  it("費用は往復ごとに、答えた model の値で足す (fallbacks が答えた回も)", async () => {
    const { model } = fakeModel([
      reply(GOOD),
      reply(GOOD, {
        model: "claude-someday-9",
        attempts: [{ model: "claude-someday-9", usage: USAGE }],
      }),
    ]);
    const { tsCompile } = fakeCompile([STILL_BROKEN, PASSES]);
    const result = await run(model, tsCompile);
    expect(result.models).toEqual(["claude-opus-5-5", "claude-someday-9"]);
    // opus-5-5: 3000×4 + 1000×20 = 0.032 ／ 表に無い model はいちばん高い値: 3000×10 + 1000×50 = 0.08
    expect(result.usd).toBeCloseTo(0.032 + 0.08, 9);
    expect(result.usage.input_tokens).toBe(6000);
  });

  it("fallbacks の前に断った試みも、その model の値で足す", async () => {
    const declined = { input_tokens: 3000, output_tokens: 0 };
    const { model } = fakeModel([
      reply(GOOD, {
        model: "claude-someday-9",
        attempts: [
          { model: "claude-opus-5-5", usage: declined },
          { model: "claude-someday-9", usage: USAGE },
        ],
      }),
    ]);
    const { tsCompile } = fakeCompile([PASSES]);
    const result = await run(model, tsCompile);
    expect(result.kind).toBe("fixed");
    // 断った opus-5-5: 3000×4 = 0.012 ／ 答えた表に無い model: 0.08
    expect(result.usd).toBeCloseTo(0.012 + 0.08, 9);
    expect(result.usage.input_tokens).toBe(6000);
    expect(result.models).toEqual(["claude-someday-9"]);
  });
});
