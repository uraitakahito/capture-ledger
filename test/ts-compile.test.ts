import { afterEach, describe, expect, it, vi } from "vitest";

import type { CrawlScript } from "../src/db/database.js";
import { createTsCompile } from "../src/config/ts-compile.js";
import {
  attributeDiagnostics,
  TsCompileUnreachable,
  tsCompileAt,
} from "../src/scripts/ts-compile.js";

/**
 * ts-compile-service のクライアント。**答えの形が違えば、通ったとも誤りが無いとも読まない** ——
 * 同じ番号を別のサービスが持っていても、取り直しの結果として渡さないため。
 */
const BASE = "http://ts-compile.test:28080";
const SCRIPT: CrawlScript = {
  id: "inline-close-banner",
  version: 1,
  phase: "behavior",
  source: "const close = (el) => el.click();\n",
  sha256: "e".repeat(64),
  options: {},
};
const PARAM = {
  name: "query",
  kind: "variable",
  required: true,
  summary: "検索語",
  schema: { type: "string", minLength: 1 },
};
const DIAGNOSTIC = {
  file: "inline-close-banner.ts",
  line: 1,
  col: 16,
  code: "TS7006",
  message: "Parameter 'el' implicitly has an 'any' type.",
};

const answering = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    );
  });
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ts-compile-service のクライアント", () => {
  it("送った列を POST /compile の本文にし、200 なら通ったと読む", async () => {
    const calls = answering(200, {
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      scripts: [],
      cached: false,
      declarations: [{ id: SCRIPT.id, params: [PARAM], unreadable: false }],
    });
    const answer = await tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], ["query"]);
    expect(answer).toEqual({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      declarations: [{ id: SCRIPT.id, params: [PARAM], unreadable: false }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/compile`);
    expect(calls[0]!.init.method).toBe("POST");
    const sent = calls[0]!.init.body;
    expect(typeof sent).toBe("string");
    // 名前だけを送る。値は送らない
    expect(JSON.parse(sent as string)).toEqual({ scripts: [SCRIPT], variableNames: ["query"] });
  });

  it("422 なら型の誤りを返す", async () => {
    answering(422, {
      message: "1 件",
      typescript: "6.0.3",
      diagnostics: [DIAGNOSTIC],
      declarations: [],
      missingVariables: ["query"],
    });
    const answer = await tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []);
    expect(answer).toEqual({
      ok: false,
      typescript: "6.0.3",
      diagnostics: [DIAGNOSTIC],
      declarations: [],
      missingVariables: ["query"],
    });
  });

  it("答えの宣言は capture-ledger の決まりに通す —— 形の悪い名前は、通ったとも誤りが無いとも読まない", async () => {
    // 名前は Windmill の変数の path に繋がる。サービスの答えでも `../` を通さない
    answering(200, {
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      declarations: [
        { id: SCRIPT.id, params: [{ ...PARAM, name: "../../u/admin/x" }], unreadable: false },
      ],
    });
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow(TsCompileUnreachable);
  });

  it("答えの宣言にシークレットは無い", async () => {
    answering(200, {
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      declarations: [
        {
          id: SCRIPT.id,
          params: [{ name: "token", kind: "secret", required: true }],
          unreadable: false,
        },
      ],
    });
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow(TsCompileUnreachable);
  });

  it("答えに宣言が無ければ投げる (古い版のサービスが答えている)", async () => {
    answering(200, { typescript: "6.0.3", hostTypes: "v0.5.0" });
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow("答えの形が違う");
  });

  it("200 でも形が違えば、通ったと読まずに投げる（同じ番号で別の物が答えている）", async () => {
    answering(200, "<html>capture-fixtures</html>");
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow(TsCompileUnreachable);
    answering(200, { ok: true });
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow("答えの形が違う");
  });

  it("422 でも誤りの形が違えば投げる", async () => {
    answering(422, {
      typescript: "6.0.3",
      diagnostics: [{ line: 1 }],
      declarations: [],
      missingVariables: [],
    });
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow(TsCompileUnreachable);
  });

  it("409 と 5xx は、status ごと投げる", async () => {
    answering(409, { message: "sha256 mismatch", id: SCRIPT.id });
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow("→ 409");
    answering(503, "down");
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow("→ 503");
  });

  it("届かなければ投げる", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:28080")));
    await expect(
      tsCompileAt({ base: BASE, timeoutMs: 1000 }).compile([SCRIPT], []),
    ).rejects.toThrow("ECONNREFUSED");
  });
});

describe("設定からクライアントを作る", () => {
  it("URL が無ければクライアントを作らない", () => {
    vi.stubEnv("CAPTURE_LEDGER_TS_COMPILE_URL", undefined);
    expect(createTsCompile()).toBeUndefined();
  });

  it("URL の末尾の / を落として呼ぶ", async () => {
    vi.stubEnv("CAPTURE_LEDGER_TS_COMPILE_URL", `${BASE}/`);
    const calls = answering(200, { typescript: "6.0.3", hostTypes: "v0.6.0", declarations: [] });
    await createTsCompile()!.compile([], []);
    expect(calls[0]!.url).toBe(`${BASE}/compile`);
  });
});

describe("誤りをスクリプトに結ぶ", () => {
  it("<id>.ts は送った id に直し、送っていない file はそのまま残す", () => {
    expect(
      attributeDiagnostics(
        [
          DIAGNOSTIC,
          { file: "lib.dom.d.ts", line: 3, col: 1, code: "TS2300", message: "dup" },
          { code: "TS5023", message: "no file" },
        ],
        [SCRIPT.id],
      ),
    ).toEqual([
      { script: SCRIPT.id, line: 1, col: 16, code: "TS7006", message: DIAGNOSTIC.message },
      { file: "lib.dom.d.ts", line: 3, col: 1, code: "TS2300", message: "dup" },
      { code: "TS5023", message: "no file" },
    ]);
  });
});
