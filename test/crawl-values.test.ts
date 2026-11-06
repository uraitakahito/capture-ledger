import { describe, expect, it } from "vitest";
import { checkValues, pinDeclarations, SECRETS_FOLDER, secretPath } from "../src/crawl/values.js";
import type { CrawlScript, ScriptParam } from "../src/db/database.js";

/**
 * クロールごとの値 (変数とシークレット) を、スクリプトの宣言に照らす判断。
 *
 * route (`POST /api/crawls`) はこの答えをそのまま 400 の本文にし、シークレットが Windmill に在るかだけを
 * 別に訊く。DB を使う試験はこの repo に無いので、断る条件は全部ここで見る。
 */
const script = (id: string, params?: ScriptParam[]): CrawlScript => ({
  id,
  version: 1,
  phase: "behavior",
  source: `// ${id}`,
  sha256: "a".repeat(64),
  options: {},
  ...(params === undefined ? {} : { params }),
});
const variable = (name: string, required = false): ScriptParam => ({
  name,
  kind: "variable",
  required,
});
const secret = (name: string, required = false): ScriptParam => ({
  name,
  kind: "secret",
  required,
});

describe("頼みの変数を、スクリプトの宣言に照らす", () => {
  it("宣言した変数は通り、シークレットは名前順に path と宣言したスクリプトの id を添えて返す", () => {
    const result = checkValues(
      [
        script("egov-law-search", [variable("query"), secret("zeta_token", true)]),
        script("inline-probe", [secret("api_token"), secret("zeta_token")]),
      ],
      { query: "個人情報" },
    );
    expect(result).toEqual({
      kind: "ok",
      secrets: [
        {
          name: "api_token",
          path: "f/waggle_secrets/api_token",
          required: false,
          declaredBy: ["inline-probe"],
        },
        {
          name: "zeta_token",
          path: "f/waggle_secrets/zeta_token",
          // どれか 1 つの宣言が求めれば求める
          required: true,
          declaredBy: ["egov-law-search", "inline-probe"],
        },
      ],
    });
  });

  it("必須の変数が渡されているかは見ない —— 判定は ts-compile-service の 1 か所 (BH0001)", () => {
    expect(checkValues([script("a", [variable("query", true)])], {})).toEqual({
      kind: "ok",
      secrets: [],
    });
  });

  it("どのスクリプトも宣言していない名前は unknown variables で名指す（綴りの誤りを黙って通さない）", () => {
    expect(checkValues([script("a", [variable("query")])], { qeury: "x", query: "y" })).toEqual({
      kind: "refused",
      body: { error: "unknown variables", names: ["qeury"] },
    });
  });

  it("宣言を読めないスクリプトが在れば、知らない名前を通す —— 理由は flow の compile の段が BH0002 で言う", () => {
    expect(
      checkValues([script("a", [variable("query")])], { k: "v" }, { unreadable: true }),
    ).toEqual({ kind: "ok", secrets: [] });
    expect(checkValues([script("a", [variable("query")])], { k: "v" })).toEqual({
      kind: "refused",
      body: { error: "unknown variables", names: ["k"] },
    });
  });

  it("値は宣言の形に照らす。合わなければ invalid variables で名指す", () => {
    const shaped = (schema: ScriptParam["schema"]) => [
      script("a", [{ ...variable("q"), ...(schema === undefined ? {} : { schema }) }]),
    ];
    const min = shaped({ type: "string", minLength: 2 });
    expect(checkValues(min, { q: "ab" }).kind).toBe("ok");
    expect(checkValues(min, { q: "a" })).toEqual({
      kind: "refused",
      body: { error: "invalid variables", names: ["q"], hint: "q は 2 字以上" },
    });
    const max = shaped({ type: "string", maxLength: 1 });
    expect(checkValues(max, { q: "a" }).kind).toBe("ok");
    expect(checkValues(max, { q: "ab" })).toEqual({
      kind: "refused",
      body: { error: "invalid variables", names: ["q"], hint: "q は 1 字まで" },
    });
    const oneOf = shaped({ type: "string", enum: ["a", "b"] });
    expect(checkValues(oneOf, { q: "b" }).kind).toBe("ok");
    expect(checkValues(oneOf, { q: "c" })).toEqual({
      kind: "refused",
      body: { error: "invalid variables", names: ["q"], hint: "q は a・b のどれか" },
    });
    // 長さは code point で数える (JSON Schema の決まり)。絵文字は 1 字
    expect(checkValues(max, { q: "😀" }).kind).toBe("ok");
    // 渡さなければ形は見ない (必須かどうかは compile の話)
    expect(checkValues(min, {}).kind).toBe("ok");
  });

  it("同じ名前を別の形で宣言していれば conflicting params", () => {
    const a = { ...variable("q"), schema: { type: "string", minLength: 1 } } as ScriptParam;
    const b = { ...variable("q"), schema: { type: "string", minLength: 2 } } as ScriptParam;
    expect(checkValues([script("a", [a]), script("b", [b])], { q: "xx" })).toEqual({
      kind: "refused",
      body: { error: "conflicting params", names: ["q"] },
    });
    expect(checkValues([script("a", [a]), script("b", [a])], { q: "xx" }).kind).toBe("ok");
  });

  it("宣言の無い台帳のスクリプト（古い写し）は、その場の TS ではないので例外にしない", () => {
    expect(checkValues([script("autoscroll")], { k: "v" })).toEqual({
      kind: "refused",
      body: { error: "unknown variables", names: ["k"] },
    });
  });

  it("シークレットの名前を変数で渡すと断る（記録に値が残る）。宣言を読めないスクリプトが在っても", () => {
    expect(
      checkValues([script("a", [secret("api_token")])], { api_token: "x" }, { unreadable: true }),
    ).toEqual({
      kind: "refused",
      body: { error: "secrets cannot be passed as variables", names: ["api_token"] },
    });
  });

  it("同じ名前を変数とシークレットの両方で宣言していれば断る（どちらにも渡せない）", () => {
    expect(
      checkValues([script("a", [variable("token")]), script("b", [secret("token")])], {
        token: "x",
      }),
    ).toEqual({ kind: "refused", body: { error: "conflicting params", names: ["token"] } });
  });

  it("シークレットが 32 個を超えれば断る（BrowserHive の map の上限）", () => {
    const many = Array.from({ length: 33 }, (_, i) => secret(`s${String(i)}`));
    expect(checkValues([script("a", many), script("b", many)], {})).toEqual({
      kind: "refused",
      body: { error: "too many secrets", count: 33, max: 32 },
    });
    expect(checkValues([script("a", many.slice(0, 32))], {}).kind).toBe("ok");
  });

  it("path は f/waggle_secrets/ の下に名前で組む（人は名前だけ書く）", () => {
    expect(SECRETS_FOLDER).toBe("f/waggle_secrets/");
    expect(secretPath("api_token")).toBe("f/waggle_secrets/api_token");
  });
});

describe("compile の答えの宣言を、行に固定する写しへ", () => {
  it("変数は答えの宣言で置き換え、シークレットは元の写しのまま残す", () => {
    const pinned = pinDeclarations(
      [script("a", [variable("old"), secret("token")])],
      [{ id: "a", params: [variable("query", true)], unreadable: false }],
    );
    expect(pinned[0]?.params).toEqual([variable("query", true), secret("token")]);
  });

  it("宣言が無く元の写しにも無ければ、鍵ごと足さない", () => {
    const [plain] = pinDeclarations(
      [script("inline-x")],
      [{ id: "inline-x", params: [], unreadable: false }],
    );
    expect(plain).not.toHaveProperty("params");
  });

  it("答えに無いスクリプトの変数は残さない —— 正は source の宣言", () => {
    expect(pinDeclarations([script("a", [variable("old")])], [])[0]?.params).toEqual([]);
  });
});
