/**
 * `pnpm run crawl` (AI の担当がクロールを始める CLI。CAPTURE-450) の、判断の所。命令の本体 (`crawl.ts`) は
 * 引数を読んで、ここの関数を順に呼ぶだけ。ここは HTTP も file も触らない (試験が `test/crawl-cli.test.ts`)。
 *
 * ## 秘密を出さない
 *
 * secret と token は、どの答え・誤りの文にも入れない。誤りの文に載せるのは、状態の数・capture-ledger の
 * `error` の字・足りない scope の名前だけ (見出しも本文の全部も載せない)。
 */

import { isActorName } from "../crawl/requester.js";

/** AI の担当の引き渡しファイル (`.dev/idp-ai.env`) から読む物。 */
export interface AiClient {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/** 引き渡しの値から、AI の担当の client を組む。足りなければ、次に打つ 1 行を添えた誤りの文。 */
export const aiClientOf = (values: Record<string, string>): AiClient | { error: string } => {
  const tokenEndpoint = values["IDP_TOKEN_ENDPOINT"];
  const clientId = values["IDP_AI_CLIENT_ID"];
  const clientSecret = values["IDP_AI_CLIENT_SECRET"];
  const scope = values["IDP_AI_SCOPE"];
  if (!tokenEndpoint || !clientId || !clientSecret || !scope) {
    return {
      error:
        "AI の担当の引き渡しファイル (.dev/idp-ai.env) が無いか、欄が足りない。" +
        "先に pnpm run idp:bootstrap (dev:up の段 idp が打つ)",
    };
  }
  return { tokenEndpoint, clientId, clientSecret, scope };
};

/** client credentials の要求の本文と見出し。secret は見出しの Basic にだけ入る。 */
export const tokenRequest = (
  client: AiClient,
): { headers: Record<string, string>; body: string } => ({
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
  },
  body: `grant_type=client_credentials&scope=${encodeURIComponent(client.scope)}`,
});

/** 覚えた token。期限の 30 秒前からは取り直す (待つ間に切れないように)。 */
export interface HeldToken {
  value: string;
  expiresAt: number;
}
export const TOKEN_MARGIN_MS = 30_000;
export const tokenStillGood = (held: HeldToken | undefined, now: number): held is HeldToken =>
  held !== undefined && held.expiresAt - TOKEN_MARGIN_MS > now;

/** token の答えを読む。形が違えば、状態の数だけを言う誤りの文 (本文に token が入りうるので載せない)。 */
export const heldTokenOf = (
  status: number,
  body: unknown,
  now: number,
): HeldToken | { error: string } => {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const value = record["access_token"];
  const expiresIn = record["expires_in"];
  if (status !== 200 || typeof value !== "string" || value === "") {
    const reason = typeof record["error"] === "string" ? `（${record["error"]}）` : "";
    return {
      error:
        `token を取れなかった: ${String(status)}${reason}。` +
        "IdP（compose の idp）は起きているか、ai の client は在るか（pnpm run dev:up --from idp）",
    };
  }
  return { value, expiresAt: now + (typeof expiresIn === "number" ? expiresIn : 300) * 1000 };
};

/**
 * 席の名前 (申告) を決める。旗 `--actor` → 環境変数 `CAPTURE_LEDGER_ACTOR` → castlist に session の ID で訊いた答え、の順。
 * どれも無ければ undefined (申告なしで始める。人が打った時も始まる)。
 */
export const actorFrom = (
  flag: string | undefined,
  env: string | undefined,
  looked: string | undefined,
) =>
  [flag, env, looked]
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value !== "");

/**
 * castlist の `GET /api/actors?binding=claude.session:<id>` の答えから、アクターの名前を 1 つ選ぶ。
 * 名前が 1 つに決まらなければ (無い・違う名前が 2 つ以上) undefined —— 誤った名前で申告しない。
 * 申告の字の形 (`isActorName`) に合わない名前も捨てる —— 表示のための申告で、始めること自体を 400 で止めない。
 */
export const actorFromCastlist = (body: unknown): string | undefined => {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const list = Array.isArray(body) ? body : record["actors"];
  if (!Array.isArray(list)) return undefined;
  const names = new Set(
    list
      .map((actor) =>
        typeof actor === "object" && actor !== null
          ? (actor as Record<string, unknown>)["name"]
          : undefined,
      )
      .filter((name): name is string => typeof name === "string" && name !== ""),
  );
  const [only] = names;
  return names.size === 1 && only !== undefined && isActorName(only) ? only : undefined;
};

/**
 * capture-ledger が断った時の文。次に打つ 1 行を添える。本文は `error`・`message`・`scope` の字だけを使う
 * (`message` は Fastify が 400 の訳を入れる欄で、秘密は入らない)。`reading` は 1 本を読んだ時 (404 の訳が違う)。
 */
export const refusalText = (status: number, body: unknown, reading = false): string => {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const error = [record["error"], record["message"]]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(": ");
  switch (status) {
    case 401:
      return (
        "capture-ledger が token を受けなかった (401)。CAPTURE_LEDGER_OIDC_CLIENT_IDS に ai= が在るか、" +
        "API を起こし直したか (pnpm run dev:up --from idp)"
      );
    case 403:
      return `この client の scope では届かない (403)。要る scope: ${typeof record["scope"] === "string" ? record["scope"] : "不明"}`;
    case 404:
      return reading
        ? "そのクロールが無いか、許可が無い (404)。id を確かめる"
        : "許可が無いか、エンドポイントが無い (404)。pnpm run idp:grant で ai の client に許可を付ける";
    case 409:
      return "走っているクロールが在る (409)。終わるのを待つ";
    default:
      return `capture-ledger が断った (${String(status)})${error === "" ? "" : `: ${error}`}`;
  }
};

/** 1 本の答えの、知らせる所だけ。 */
export const summaryOf = (crawl: Record<string, unknown>) => ({
  crawlId: crawl["crawlId"],
  state: crawl["state"],
  stopReason: crawl["stopReason"] ?? null,
  pagesCaptured: crawl["pagesCaptured"] ?? 0,
  pagesFailed: crawl["pagesFailed"] ?? 0,
  error: crawl["error"] ?? null,
  requestedByName: crawl["requestedByName"] ?? null,
  requestedClient: crawl["requestedClient"] ?? null,
  requestedActor: crawl["requestedActor"] ?? null,
});

/** 始める本文。起点と深さだけ (ほかの欄は capture-ledger の既定)。 */
/** 繋がらなかった時の文。どこに届かないかと、起こす命令を言う。 */
export const unreachableText = (where: "idp" | "api", url: string): string =>
  where === "idp"
    ? `IdP (${url}) に届かない。compose の idp は起きているか (pnpm run dev:up --from idp)`
    : `capture-ledger の API (${url}) に届かない。起きているか (pnpm run dev:up --from api)`;

export const startBody = (seeds: readonly string[], depth: number | undefined) => ({
  seeds,
  ...(depth !== undefined && { maxDepth: depth }),
});
