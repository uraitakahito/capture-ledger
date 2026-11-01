import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindmillVariables,
  windmillApiOf,
  windmillVariablesAt,
  WindmillUnreachable,
} from "../src/crawl/windmill-variables.js";

/**
 * Windmill の変数に在るかを訊く窓口 (`src/crawl/windmill-variables.ts`)。
 *
 * fetch を差し替えて、**何を打つか**（口・path・Bearer・`decrypt_secret=false`）と、答えをどう読むかを見る。
 * 答えの形は Windmill CE v1.806.0 の実測（`exists` は素の真偽値、`get` は `value: null` と `is_secret`・
 * `edited_at`、無い path は 404）。
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const WEBHOOK = "http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level";

describe("webhook の URL から口を読む", () => {
  it("flow の webhook の形なら、口の根と workspace", () => {
    expect(windmillApiOf(WEBHOOK)).toEqual({ base: "http://127.0.0.1:8000", workspace: "crawler" });
    expect(windmillApiOf("https://wm.example.test/sub/api/w/ws-1/jobs/run/f/f/x/y")).toEqual({
      base: "https://wm.example.test/sub",
      workspace: "ws-1",
    });
  });

  it("形が違えば undefined", () => {
    expect(windmillApiOf("http://windmill.test/hooks/crawl")).toBeUndefined();
    expect(
      windmillApiOf("http://windmill.test/api/w/crawler/jobs/run_wait_result/x"),
    ).toBeUndefined();
  });

  it("設定が無いか片方だけなら窓口も無い。形が違う URL でも無い", () => {
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL", "");
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN", "");
    expect(createWindmillVariables()).toBeUndefined();
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL", WEBHOOK);
    expect(createWindmillVariables()).toBeUndefined();
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN", "t");
    expect(createWindmillVariables()).toBeDefined();
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL", "http://windmill.test/hooks/crawl");
    expect(createWindmillVariables()).toBeUndefined();
  });
});

describe("在るかを訊く", () => {
  const at = () =>
    windmillVariablesAt({
      base: "http://windmill.test",
      workspace: "crawler",
      token: "tok",
      timeoutMs: 1000,
    });

  /** fetch を差し替え、打った URL と header を記録する。 */
  const answering = (status: number, body: string) => {
    const calls: { url: string; authorization: string | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, authorization: init.headers["authorization"] });
      return Promise.resolve(new Response(body, { status }));
    });
    return calls;
  };

  it("exists は variables/exists/<path> に Bearer で GET し、真偽値をそのまま返す", async () => {
    const calls = answering(200, "true");
    await expect(at().exists("f/waggle_secrets/api_token")).resolves.toBe(true);
    expect(calls).toEqual([
      {
        url: "http://windmill.test/api/w/crawler/variables/exists/f/waggle_secrets/api_token",
        authorization: "Bearer tok",
      },
    ]);
    answering(200, "false");
    await expect(at().exists("f/waggle_secrets/nope")).resolves.toBe(false);
  });

  it("meta は decrypt_secret=false を付けて GET し、is_secret と edited_at だけを読む", async () => {
    // 付けなければ secret でも value に平文が返る（実測）。この query が、台帳が値を読まないことの要
    const calls = answering(
      200,
      JSON.stringify({
        path: "f/waggle_secrets/api_token",
        value: null,
        is_secret: true,
        edited_at: "2026-11-01T07:00:00.000000Z",
        edited_by: "admin",
      }),
    );
    await expect(at().meta("f/waggle_secrets/api_token")).resolves.toEqual({
      isSecret: true,
      editedAt: "2026-11-01T07:00:00.000000Z",
    });
    expect(calls[0]?.url).toBe(
      "http://windmill.test/api/w/crawler/variables/get/f/waggle_secrets/api_token?decrypt_secret=false",
    );
    expect(calls[0]?.authorization).toBe("Bearer tok");
  });

  it("secret でない変数は isSecret: false。edited_at が無ければ null", async () => {
    answering(200, JSON.stringify({ value: "plain", is_secret: false }));
    await expect(at().meta("f/waggle_secrets/x")).resolves.toEqual({
      isSecret: false,
      editedAt: null,
    });
  });

  it("無い変数は 404 で undefined（exists は訊かずに meta だけでも分かる）", async () => {
    answering(404, "Not found: Variable f/waggle_secrets/nope not found");
    await expect(at().meta("f/waggle_secrets/nope")).resolves.toBeUndefined();
  });

  it("届かなければ WindmillUnreachable（exists も meta も）", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("connect ECONNREFUSED")));
    await expect(at().exists("f/waggle_secrets/x")).rejects.toBeInstanceOf(WindmillUnreachable);
    await expect(at().meta("f/waggle_secrets/x")).rejects.toBeInstanceOf(WindmillUnreachable);
  });

  it("2xx でも 404 でもない答えは WindmillUnreachable で、status と本文を言う", async () => {
    answering(401, "Unauthorized: invalid token");
    await expect(at().exists("f/waggle_secrets/x")).rejects.toThrow(/401 Unauthorized/);
    answering(500, "boom");
    await expect(at().meta("f/waggle_secrets/x")).rejects.toThrow(/500 boom/);
  });

  it("exists の答えが真偽値でなければ、「無い」とは読まずに WindmillUnreachable", async () => {
    answering(200, "null");
    await expect(at().exists("f/waggle_secrets/x")).rejects.toBeInstanceOf(WindmillUnreachable);
  });
});
