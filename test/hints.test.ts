import { describe, expect, it } from "vitest";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import { INLINE_PARAMS_SECRETS_ONLY } from "../src/crawl/prepare.js";
import { checkValues, formatsRefusal } from "../src/crawl/values.js";
import type { CrawlScript, ParamSchema } from "../src/db/database.js";
import { applyEdits, refusalOf, UNREADABLE_ANSWER, type FixEdit } from "../src/scripts/fix.js";
import { readParams } from "../src/scripts/store.js";
import { hint, HINT_KEYS, quoted, type Hint, type HintValue } from "../src/types/hint.js";

/**
 * 断りの文に添える鍵と値の組 (`src/types/hint.ts`)。
 *
 * **鍵と値の名前は、読む側 (capture-workbench の訳の表) との約束。** ここの表は、コードの表 (`HINT_KEYS`) の写しを
 * わざと手で持つ —— 鍵を足す・消す・名前を替えると赤になり、読む側と揃える機会になる。
 */
const EXPECTED_KEYS: Record<string, string[]> = {
  "params.notArray": [],
  "params.tooMany": ["max"],
  "params.entryNotObject": [],
  "params.invalidName": ["name", "max"],
  "params.invalidKind": ["name", "kind"],
  "params.requiredNotBoolean": ["name"],
  "params.summaryNotString": ["name"],
  "params.summaryEmpty": ["name"],
  "params.unknownKeys": ["name", "keys"],
  "params.duplicateName": ["name"],
  "params.schemaOnlyForVariable": ["name"],
  "params.archiveOnlyForSecret": ["name"],
  "params.invalidArchive": ["name", "value"],
  "params.schemaMissing": ["name"],
  "params.schemaUnknownKeys": ["name", "keys"],
  "params.schemaTypeNotString": ["name"],
  "params.schemaInvalidLength": ["name"],
  "params.schemaInvalidEnum": ["name"],
  "variables.notInEnum": ["name", "values"],
  "variables.tooShort": ["name", "min"],
  "variables.tooLong": ["name", "max"],
  "formats.cannotHideSecrets": ["formats"],
  "inlineParams.secretsOnly": [],
  "fix.noEdits": [],
  "fix.invalidRange": ["from", "to"],
  "fix.outOfRange": ["line", "lines"],
  "fix.overlappingEdits": ["firstFrom", "firstTo", "secondFrom", "secondTo"],
  "fix.suppressedCheck": [],
  "fix.usedAny": [],
  "fix.addedModuleSyntax": [],
  "fix.tooManyLines": ["lines", "max"],
  "fix.unreadableAnswer": [],
};

/** 宣言 (`params`) を読ませて、断りの組を取り出す。読めたなら undefined */
const declared = (raw: unknown, summaryRequired = false): Hint | undefined => {
  const read = readParams(raw, { summaryRequired });
  return "refused" in read ? read.refused : undefined;
};
const secret = (extra: Record<string, unknown> = {}) => [
  { name: "token", kind: "secret", ...extra },
];
const variable = (schema: unknown, extra: Record<string, unknown> = {}) => [
  { name: "query", kind: "variable", schema, ...extra },
];

/** 頼みの変数 `lang` の値を、宣言の形に照らさせて、断りの組を取り出す */
const misfit = (schema: ParamSchema, value: string): Hint | undefined => {
  const script: CrawlScript = {
    id: "a",
    version: 1,
    phase: "behavior",
    source: "// a",
    sha256: "a".repeat(64),
    options: {},
    params: [{ name: "lang", kind: "variable", required: false, schema }],
  };
  const checked = checkValues([script], { lang: value });
  return checked.kind === "refused"
    ? (checked.body["hints"] as Hint[] | undefined)?.[0]
    : undefined;
};

const EIGHT_LINES = "1\n2\n3\n4\n5\n6\n7\n8\n";
const edited = (edits: FixEdit[]): Hint | undefined => {
  const applied = applyEdits(EIGHT_LINES, edits);
  return "refused" in applied ? applied.refused : undefined;
};
const replaced = (after: string, lines = 1): Hint | undefined =>
  refusalOf(
    [{ from: 1, to: lines, before: Array.from({ length: lines }, () => "x;"), after: [after] }],
    10,
  );

/**
 * 鍵ごとに 1 つ、**本物の関数に断らせて**組を取り出す。`params` は、その入力で埋まるはずの値。
 * 値は、文のほかの字と紛れない物を選ぶ (名前が 1 字だと、文のどこかに必ず出てしまう)。
 */
const CASES: { key: string; from: () => Hint | undefined; params?: Record<string, HintValue> }[] = [
  { key: "params.notArray", from: () => declared({ name: "token" }) },
  {
    key: "params.tooMany",
    from: () =>
      declared(Array.from({ length: 33 }, (_, i) => ({ name: `p${String(i)}`, kind: "secret" }))),
    params: { max: 32 },
  },
  { key: "params.entryNotObject", from: () => declared(["token"]) },
  {
    key: "params.invalidName",
    from: () => declared([{ name: "Bad-Name", kind: "secret" }]),
    params: { name: '"Bad-Name"', max: 64 },
  },
  {
    key: "params.invalidKind",
    from: () => declared([{ name: "token", kind: "cookie" }]),
    params: { name: "token", kind: "cookie" },
  },
  {
    key: "params.requiredNotBoolean",
    from: () => declared(secret({ required: "yes" })),
    params: { name: "token" },
  },
  {
    key: "params.summaryNotString",
    from: () => declared(secret({ summary: 1 })),
    params: { name: "token" },
  },
  { key: "params.summaryEmpty", from: () => declared(secret(), true), params: { name: "token" } },
  {
    key: "params.unknownKeys",
    from: () => declared(secret({ default: "x", pattern: "y" })),
    params: { name: "token", keys: ["default", "pattern"] },
  },
  {
    key: "params.duplicateName",
    from: () => declared([...secret(), ...secret()]),
    params: { name: "token" },
  },
  {
    key: "params.schemaOnlyForVariable",
    from: () => declared(secret({ schema: { type: "string" } })),
    params: { name: "token" },
  },
  {
    key: "params.archiveOnlyForSecret",
    from: () => declared(variable({ type: "string" }, { archive: "keep" })),
    params: { name: "query" },
  },
  {
    key: "params.invalidArchive",
    from: () => declared(secret({ archive: "hide" })),
    params: { name: "token", value: '"hide"' },
  },
  {
    key: "params.schemaMissing",
    from: () => declared(variable(undefined)),
    params: { name: "query" },
  },
  {
    key: "params.schemaUnknownKeys",
    from: () => declared(variable({ type: "string", pattern: "x", format: "y" })),
    params: { name: "query", keys: ["pattern", "format"] },
  },
  {
    key: "params.schemaTypeNotString",
    from: () => declared(variable({ type: "number" })),
    params: { name: "query" },
  },
  {
    key: "params.schemaInvalidLength",
    from: () => declared(variable({ type: "string", minLength: -1 })),
    params: { name: "query" },
  },
  {
    key: "params.schemaInvalidEnum",
    from: () => declared(variable({ type: "string", enum: [] })),
    params: { name: "query" },
  },
  {
    key: "variables.notInEnum",
    from: () => misfit({ type: "string", enum: ["ja", "en"] }, "fr"),
    params: { name: "lang", values: ["ja", "en"] },
  },
  {
    key: "variables.tooShort",
    from: () => misfit({ type: "string", minLength: 7 }, "fr"),
    params: { name: "lang", min: 7 },
  },
  {
    key: "variables.tooLong",
    from: () => misfit({ type: "string", maxLength: 3 }, "français"),
    params: { name: "lang", max: 3 },
  },
  {
    key: "formats.cannotHideSecrets",
    from: () => {
      const body = formatsRefusal(parseCaptureFormats("wacz,png,html", false).formats, {
        password: { path: "f/waggle_secrets/password", editedAt: null, rotated: null },
      });
      return (body?.["hints"] as Hint[] | undefined)?.[0];
    },
    params: { formats: ["png", "html"] },
  },
  { key: "inlineParams.secretsOnly", from: () => INLINE_PARAMS_SECRETS_ONLY },
  { key: "fix.noEdits", from: () => edited([]) },
  {
    key: "fix.invalidRange",
    from: () => edited([{ from: 3, to: 2, text: "x" }]),
    params: { from: 3, to: 2 },
  },
  {
    key: "fix.outOfRange",
    from: () => edited([{ from: 9, to: 9, text: "x" }]),
    params: { line: 9, lines: 8 },
  },
  {
    key: "fix.overlappingEdits",
    from: () =>
      edited([
        { from: 4, to: 7, text: "y" },
        { from: 2, to: 5, text: "x" },
      ]),
    params: { firstFrom: 2, firstTo: 5, secondFrom: 4, secondTo: 7 },
  },
  { key: "fix.suppressedCheck", from: () => replaced("// @ts-ignore") },
  { key: "fix.usedAny", from: () => replaced("f(el as any);") },
  { key: "fix.addedModuleSyntax", from: () => replaced("export {};") },
  { key: "fix.tooManyLines", from: () => replaced("y;", 6), params: { lines: 6, max: 5 } },
  { key: "fix.unreadableAnswer", from: () => UNREADABLE_ANSWER },
];

describe("断りの文の鍵の一覧（読む側との約束）", () => {
  it("鍵と、鍵ごとの値の名前は、この表のとおり（足す・消す・名前を替えるなら、読む側の訳の表と揃える）", () => {
    expect(HINT_KEYS).toEqual(EXPECTED_KEYS);
  });

  it("鍵は <まとまり>.<意味> の camelCase 2 語で、値の名前も camelCase", () => {
    const word = "[a-z][a-zA-Z0-9]*";
    for (const [key, names] of Object.entries(HINT_KEYS)) {
      expect(key).toMatch(new RegExp(`^${word}\\.${word}$`));
      for (const name of names) expect(name).toMatch(new RegExp(`^${word}$`));
    }
  });

  it("どの鍵にも、下で本物の関数に断らせる場面が 1 つある", () => {
    expect(CASES.map(({ key }) => key).sort()).toEqual(Object.keys(HINT_KEYS).sort());
  });
});

describe("文 (text) と値 (params) は食い違わない", () => {
  it.each(CASES)("$key: 表の名前の値をちょうど全部持ち、どの値も文に出ている", (scene) => {
    const refused = scene.from();
    expect(refused).toBeDefined();
    const { key, params, text } = refused!;
    expect(key).toBe(scene.key);
    // 埋めた値の無い文は、欄ごと付けない
    expect(params).toEqual(scene.params);
    expect(Object.keys(params ?? {}).sort()).toEqual([...(EXPECTED_KEYS[scene.key] ?? [])].sort());
    for (const value of Object.values(params ?? {})) {
      for (const part of Array.isArray(value) ? value : [value]) {
        expect(text).toContain(String(part));
      }
    }
  });
});

describe("鍵つきの組を作る", () => {
  it("値を埋めない鍵は key と text だけ、埋める鍵は params も持つ", () => {
    expect(hint("params.notArray", "params は宣言の配列")).toEqual({
      key: "params.notArray",
      text: "params は宣言の配列",
    });
    expect(hint("params.tooMany", "params は 32 個まで", { max: 32 })).toEqual({
      key: "params.tooMany",
      params: { max: 32 },
      text: "params は 32 個まで",
    });
  });

  it("表に無い鍵・足りない値・表に無い値の名前は、型で落ちる", () => {
    // @ts-expect-error 表に無い鍵
    hint("params.unknown", "x");
    // @ts-expect-error 値を埋める鍵に値を渡していない
    hint("params.tooMany", "x");
    // @ts-expect-error 表と違う値の名前
    hint("params.tooMany", "x", { limit: 32 });
    // @ts-expect-error 値を埋めない鍵に値を渡した
    hint("params.notArray", "x", { max: 32 });
    expect(Object.keys(HINT_KEYS)).not.toContain("params.unknown");
  });

  it("JSON.stringify して埋める値は、雛形が埋めるのと同じ字（引用符つき。undefined は undefined）", () => {
    for (const value of ["Query", 1, null, undefined, { a: 1 }]) {
      expect(quoted(value)).toBe(`${JSON.stringify(value)}`);
    }
    expect(quoted("Query")).toBe('"Query"');
    expect(quoted(undefined)).toBe("undefined");
  });
});
