import { describe, expect, it } from "vitest";
import { checkValues, SECRETS_FOLDER, secretPath } from "../src/crawl/values.js";
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

  it("required の変数が無ければ missing variables で名指す。required でない物は無くてよい", () => {
    const scripts = [script("a", [variable("query", true), variable("lang")])];
    expect(checkValues(scripts, {})).toEqual({
      kind: "refused",
      body: { error: "missing variables", names: ["query"] },
    });
    expect(checkValues(scripts, { query: "x" })).toEqual({ kind: "ok", secrets: [] });
  });

  it("どのスクリプトも宣言していない名前は unknown variables で名指す（綴りの誤りを黙って通さない）", () => {
    expect(checkValues([script("a", [variable("query")])], { qeury: "x", query: "y" })).toEqual({
      kind: "refused",
      body: { error: "unknown variables", names: ["qeury"] },
    });
  });

  it("宣言の無いその場の JS が 1 本でも在れば、知らない名前を通す。params: [] は宣言なので通さない", () => {
    // 添えなかった物は「何を読むか分からない」。空の宣言は「何も読まない」
    expect(checkValues([script("a", [variable("query")]), script("inline-x")], { k: "v" })).toEqual(
      { kind: "ok", secrets: [] },
    );
    expect(
      checkValues([script("a", [variable("query")]), script("inline-x", [])], { k: "v" }),
    ).toEqual({ kind: "refused", body: { error: "unknown variables", names: ["k"] } });
  });

  it("宣言の無い台帳のスクリプト（古い写し）は、その場の JS ではないので例外にしない", () => {
    expect(checkValues([script("autoscroll")], { k: "v" })).toEqual({
      kind: "refused",
      body: { error: "unknown variables", names: ["k"] },
    });
  });

  it("シークレットの名前を変数で渡すと断る（記録に値が残る）。宣言の無いその場の JS が在っても", () => {
    expect(
      checkValues([script("a", [secret("api_token")]), script("inline-x")], { api_token: "x" }),
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
