import { describe, expect, it } from "vitest";

import {
  TOKEN_MARGIN_MS,
  actorFrom,
  actorFromCastlist,
  aiClientOf,
  heldTokenOf,
  refusalText,
  startBody,
  unreachableText,
  summaryOf,
  tokenRequest,
  tokenStillGood,
} from "../src/tools/crawl-cli.js";

/**
 * `pnpm run crawl` (AI の担当がクロールを始める CLI。CAPTURE-450) の判断の所。**secret と token を、誤りの文にも
 * 答えにも出さない**ことを、ここで固める。
 */
const HIDDEN = "hidden-secret-value";
const handoff = {
  IDP_TOKEN_ENDPOINT: "http://127.0.0.1:4566/cognito-idp/oauth2/token",
  IDP_AI_CLIENT_ID: "ai-client-id",
  IDP_AI_CLIENT_SECRET: HIDDEN,
  IDP_AI_SCOPE: "capture-ledger/crawl.start",
};

describe("aiClientOf", () => {
  it("引き渡しから client を組む", () => {
    expect(aiClientOf(handoff)).toEqual({
      tokenEndpoint: handoff.IDP_TOKEN_ENDPOINT,
      clientId: "ai-client-id",
      clientSecret: HIDDEN,
      scope: "capture-ledger/crawl.start",
    });
  });

  it.each(["IDP_TOKEN_ENDPOINT", "IDP_AI_CLIENT_ID", "IDP_AI_CLIENT_SECRET", "IDP_AI_SCOPE"])(
    "%s が無ければ、次に打つ 1 行を言う",
    (name) => {
      const answer = aiClientOf({ ...handoff, [name]: "" });
      expect(answer).toEqual({
        error: expect.stringContaining("pnpm run idp:bootstrap") as string,
      });
    },
  );
});

describe("tokenRequest", () => {
  it("secret は Basic の見出しにだけ入り、本文には scope だけ", () => {
    const { headers, body } = tokenRequest(
      aiClientOf(handoff) as Exclude<ReturnType<typeof aiClientOf>, { error: string }>,
    );
    expect(body).toBe("grant_type=client_credentials&scope=capture-ledger%2Fcrawl.start");
    expect(body).not.toContain(HIDDEN);
    expect(Buffer.from(headers["authorization"]!.slice("Basic ".length), "base64").toString()).toBe(
      `ai-client-id:${HIDDEN}`,
    );
  });
});

describe("token の使い回し", () => {
  const now = 1_000_000;

  it("期限から秒を読む。期限の 30 秒前からは取り直す", () => {
    const held = heldTokenOf(200, { access_token: "tok", expires_in: 600 }, now);
    expect(held).toEqual({ value: "tok", expiresAt: now + 600_000 });
    expect(
      tokenStillGood(
        held as { value: string; expiresAt: number },
        now + 600_000 - TOKEN_MARGIN_MS - 1,
      ),
    ).toBe(true);
    expect(
      tokenStillGood(held as { value: string; expiresAt: number }, now + 600_000 - TOKEN_MARGIN_MS),
    ).toBe(false);
    expect(tokenStillGood(undefined, now)).toBe(false);
  });

  // 断られた答えの本文は、そのまま出さない (token が載りうる)。状態の数と error の語だけ
  it("取れなければ、状態の数と error の語だけを言う", () => {
    const answer = heldTokenOf(400, { error: "invalid_scope", access_token: HIDDEN }, now);
    expect(answer).toEqual({ error: expect.stringContaining("400（invalid_scope）") as string });
    expect(JSON.stringify(answer)).not.toContain(HIDDEN);
  });
});

describe("席の名前 (申告)", () => {
  it("旗 → 環境変数 → castlist の順。空と空白は飛ばす", () => {
    expect(actorFrom("flag-seat", "env-seat", "castlist-seat")).toBe("flag-seat");
    expect(actorFrom(undefined, "env-seat", "castlist-seat")).toBe("env-seat");
    expect(actorFrom(" ", "", "castlist-seat")).toBe("castlist-seat");
    expect(actorFrom(undefined, "", undefined)).toBeUndefined();
  });

  it("castlist の答えから、名前が 1 つに決まる時だけ選ぶ", () => {
    expect(actorFromCastlist({ actors: [{ name: "capture-450-swe.1" }] })).toBe(
      "capture-450-swe.1",
    );
    // 同じ名前が 2 行 (出し手が違う) なら 1 つ
    expect(actorFromCastlist([{ name: "a" }, { name: "a" }])).toBe("a");
    // 違う名前が 2 つなら、誤った名前で申告しない
    expect(actorFromCastlist({ actors: [{ name: "a" }, { name: "b" }] })).toBeUndefined();
    expect(actorFromCastlist({ actors: [] })).toBeUndefined();
    expect(actorFromCastlist({ error: "x" })).toBeUndefined();
  });

  // 申告は表示のためだけ。castlist の名前が申告の字の形に合わなければ捨て、始めることを 400 で止めない
  it("castlist の名前が申告の字の形に合わなければ、捨てる", () => {
    expect(actorFromCastlist({ actors: [{ name: "席 1" }] })).toBeUndefined();
    expect(actorFromCastlist({ actors: [{ name: "x".repeat(65) }] })).toBeUndefined();
  });
});

describe("refusalText", () => {
  it.each([
    [401, {}, "CAPTURE_LEDGER_OIDC_CLIENT_IDS に ai="],
    [
      403,
      { error: "insufficient_scope", scope: "capture-ledger/crawl" },
      "要る scope: capture-ledger/crawl",
    ],
    [404, { error: "not found" }, "pnpm run idp:grant"],
    [409, { error: "a crawl is already running" }, "走っているクロール"],
    [400, { error: "missing seeds" }, "(400): missing seeds"],
  ])("%i は、次の手を言う", (status, body, expected) => {
    expect(refusalText(status, body)).toContain(expected);
  });

  // 1 本を読んだ時の 404 は、id の打ち違いか許可。idp:grant を勧めない
  it("1 本を読んだ時の 404 は、id を確かめる", () => {
    expect(refusalText(404, { error: "not found" }, true)).toContain("id を確かめる");
    expect(refusalText(404, { error: "not found" }, true)).not.toContain("idp:grant");
  });

  // Fastify が 400 の訳を入れる message も出す (「Bad Request」だけでは迷う)
  it("400 は error と message を出す", () => {
    expect(
      refusalText(400, { error: "Bad Request", message: 'params/id must match format "uuid"' }),
    ).toBe('capture-ledger が断った (400): Bad Request: params/id must match format "uuid"');
  });

  it("繋がらない時は、どこに届かないかと起こす命令を言う", () => {
    expect(unreachableText("idp", "http://127.0.0.1:4566/x")).toContain(
      "pnpm run dev:up --from idp",
    );
    expect(unreachableText("api", "http://127.0.0.1:7070/api/crawls")).toContain(
      "pnpm run dev:up --from api",
    );
  });

  // 本文の error と scope のほかは載せない
  it("本文のほかの欄は載せない", () => {
    expect(refusalText(400, { error: "x", token: HIDDEN })).not.toContain(HIDDEN);
  });
});

describe("始める本文と、知らせる所", () => {
  it("深さは渡した時だけ", () => {
    expect(startBody(["https://site.test/"], undefined)).toEqual({ seeds: ["https://site.test/"] });
    expect(startBody(["https://site.test/"], 0)).toEqual({
      seeds: ["https://site.test/"],
      maxDepth: 0,
    });
  });

  it("1 本の答えから、状態と誰が始めたかだけを抜く", () => {
    expect(
      summaryOf({
        crawlId: "c1",
        state: "succeeded",
        stopReason: "completed",
        pagesCaptured: 1,
        pagesFailed: 0,
        error: null,
        requestedByName: "ai",
        requestedClient: "ai",
        requestedActor: "swe-seat-1",
        scripts: [{ source: "long" }],
      }),
    ).toEqual({
      crawlId: "c1",
      state: "succeeded",
      stopReason: "completed",
      pagesCaptured: 1,
      pagesFailed: 0,
      error: null,
      requestedByName: "ai",
      requestedClient: "ai",
      requestedActor: "swe-seat-1",
    });
  });
});
