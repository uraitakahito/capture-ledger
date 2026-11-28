/**
 * 手元の Cognito の代役（Floci）と話す道具の共通部分。**本番には無い。**
 *
 * ## なぜ Floci か
 *
 * 本番の IdP は Amazon Cognito。capture-ledger はトークンを Cognito の形で確かめる
 * (`src/api/identity.ts`: 署名・`iss`・`exp`・`token_use`・`client_id`)。手元でも同じ形の
 * トークンを出す物が要るので、Cognito を真似る Floci を compose のサービス `idp` に置く
 * (CAPTURE-185)。プールや利用者を作るのは Cognito の管理の API で、本番では AWS の側で作る。
 *
 * ## SDK を使わない
 *
 * 呼ぶのは Cognito の JSON の API の数個だけで、相手は手元の Floci だけ。Floci は既定で
 * 署名を確かめないので、`x-amz-target` と JSON で足りる。AWS の SDK（依存が数十）を
 * 道具のためだけに入れない。署名の見出しは形だけ付ける（`test` は Floci の既定の鍵）。
 *
 * ## 届く範囲
 *
 * Floci の管理の API は、既定の鍵 `test`/`test` を条件なしに通す（2026-11-11 に Floci 2.4.0 の
 * ソースで確かめた）。compose のネットワークから届く物は、誰でも利用者やトークンを作れる。
 * 開発用の手元のスタックの中の心配として受け入れた（CAPTURE-185 の段 0）。ホストへは
 * `127.0.0.1` にだけ出す。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { optional } from "./env.js";
import { ROOT } from "./root.js";

/** ホストから Floci に届く先。compose の `127.0.0.1:4566:4566`。 */
export const IDP_ENDPOINT = optional("CAPTURE_LEDGER_IDP_ENDPOINT", "http://127.0.0.1:4566");

/**
 * コンテナ（Windmill の flow）から Floci に届く先。compose のサービス `idp` と、project 名
 * `capture-ledger`（DNS の domain）。**トークンの `iss` はこちらにならない** —— Floci は `FLOCI_BASE_URL`
 * から `iss` を作るので、どこから取っても `http://127.0.0.1:4566/<プール>` のまま（実測）。
 */
export const IDP_CONTAINER_ENDPOINT = "http://idp.capture-ledger:4566";

/** Floci が答えるか。compose の healthcheck と同じ所を見る。 */
export const IDP_READY_URL = `${IDP_ENDPOINT}/_floci/init`;

/** token endpoint の path。本物の Cognito は `https://<ドメイン>/oauth2/token`。 */
export const TOKEN_PATH = "/cognito-idp/oauth2/token";

/**
 * 引き渡しファイル。**この repo の道具が書き、隣の repo（capture-scheduler）が読みに来る。**
 * capture-scheduler の windmill:capture-ledger-token (scripts の capture-ledger-token.ts) が同じ綴りで読む。
 */
export const IDP_HANDOFF = ".dev/idp.env";

/** 群の名前が組織の名前（`cognito:groups`）。手元の既定の組織。 */
export const DEV_ORGANIZATION = "acme";

/**
 * resource server と scope (CAPTURE-450)。綴りは API の門 (`src/api/scope.ts`) の 1 か所が持つ。
 * Windmill の flow は `CRAWL_SCOPE`、AI の担当の app client は `START_SCOPE` でトークンを取る。
 */
export { CRAWL_SCOPE, RESOURCE_SERVER, START_SCOPE } from "../api/scope.js";

/**
 * AI の担当の引き渡しファイル (CAPTURE-450)。AI の担当の app client の ID と secret だけを置く ——
 * `.dev/idp.env` (人のパスワードと Windmill の secret) とは分け、クロールを始める CLI はこちらだけを読む。
 */
export const IDP_AI_HANDOFF = ".dev/idp-ai.env";

/** Cognito の JSON の API の失敗。`__type` を名前に持つ。 */
export class CognitoError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(`${type}: ${message}`);
  }
}

/** Cognito の管理の API を 1 回呼ぶ。 */
export const cognito = async <T>(action: string, body: object): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`${IDP_ENDPOINT}/`, {
      method: "POST",
      headers: {
        "x-amz-target": `AWSCognitoIdentityProviderService.${action}`,
        "content-type": "application/x-amz-json-1.1",
        authorization:
          "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/cognito-idp/aws4_request, SignedHeaders=host, Signature=0",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `${IDP_ENDPOINT} に届かない (${err instanceof Error ? err.message : String(err)})。` +
        "compose のサービス idp (Floci) は起きているか? (pnpm run stack:up)",
      { cause: err },
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    throw new CognitoError(
      text(json["__type"]) || String(res.status),
      text(json["message"]) || text(json["Message"]),
    );
  }
  return json as T;
};

/** app client。`ClientSecret` は secret つきの client だけが持つ。 */
export interface AppClient {
  ClientId: string;
  ClientName: string;
  ClientSecret?: string;
}

/** workbench の戻り先。capture-workbench の既定の 7080 と `/callback`。 */
export const WORKBENCH_CALLBACK = "http://127.0.0.1:7080/callback";

/**
 * workbench のサインアウトの後の戻り先 (t-6nje)。workbench は「サインアウト」で IdP の logout の口
 * (`…/logout?client_id=…&logout_uri=…`) へ回し、IdP は自分のサインイン (cookie) を消して、ここへ戻す ——
 * `/login` がいつものサインインを 1 から始めるので、人はサインインのフォームに着く。**IdP は、登録した物と
 * 1 字でも違う戻り先を断る** (query を足しても 400。Floci 2.4.0 で実測) ので、workbench が作る値と揃える。
 */
export const WORKBENCH_SIGNED_OUT = "http://127.0.0.1:7080/login";

/**
 * workbench の app client の設定。public (secret を持たない)・authorization code と PKCE。
 * 本番の Cognito の app client にも、同じ戻り先 (`CallbackURLs`) とサインアウトの後の戻り先 (`LogoutURLs`) を登録する。
 */
export const WORKBENCH_CLIENT = {
  AllowedOAuthFlows: ["code"],
  AllowedOAuthScopes: ["openid"],
  AllowedOAuthFlowsUserPoolClient: true,
  CallbackURLs: [WORKBENCH_CALLBACK],
  LogoutURLs: [WORKBENCH_SIGNED_OUT],
  ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
};

/**
 * 在る値が、設定に書いた値に合うか。配列は並びごと (無い欄は空の配列と同じ)、入れ子は**設定に書いた欄だけ**
 * (`TokenValidityUnits` は、書いていない単位を IdP が既定で埋める)、ほかは同じ値か。
 */
const settled = (have: unknown, want: unknown): boolean => {
  if (Array.isArray(want)) return JSON.stringify(have ?? []) === JSON.stringify(want);
  if (typeof want === "object" && want !== null) {
    const held = typeof have === "object" && have !== null ? (have as Record<string, unknown>) : {};
    return Object.entries(want).every(([name, value]) => settled(held[name], value));
  }
  return have === want;
};

/**
 * 在る client の設定が `settings` と違えば、直す (同じなら何も呼ばない —— `dev:up` のたびに書き直さない)。
 * 比べるのは `settings` に書いた欄だけ。UpdateUserPoolClient は渡さない欄を既定に戻すので、`settings` を
 * みな渡す。作る時だけの欄 (`GenerateSecret`) は比べず、渡さない —— 在る client の secret は作り直さない。
 * client の ID は変わらず、出ているトークンと IdP のサインインもそのまま (Floci 2.4.0 で実測)。
 */
export const syncClient = async <C extends AppClient>(
  pool: string,
  client: C,
  settings: Record<string, unknown>,
): Promise<C> => {
  const rest = Object.fromEntries(
    Object.entries(settings).filter(([name]) => name !== "GenerateSecret"),
  );
  if (settled(client, rest)) return client;
  const { UserPoolClient } = await cognito<{ UserPoolClient: C }>("UpdateUserPoolClient", {
    UserPoolId: pool,
    ClientId: client.ClientId,
    ClientName: client.ClientName,
    ...rest,
  });
  return { ...UserPoolClient, ClientSecret: UserPoolClient.ClientSecret ?? client.ClientSecret };
};

/** `名前=値` の行のファイルを読む。無ければ空。 */
export const readEnvFile = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (line.startsWith("#") || at <= 0) continue;
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
};

/** 引き渡しファイルを読む。`root` は capture-ledger の根（既定はこの repo）。 */
export const readHandoff = (root: string = ROOT) => readEnvFile(resolve(root, IDP_HANDOFF));

/** 引き渡しファイルを書く（全部を置き換える）。値は印字しない —— secret が混じる。 */
export const writeHandoff = (values: Record<string, string>, file: string = IDP_HANDOFF) => {
  const path = resolve(ROOT, file);
  mkdirSync(dirname(path), { recursive: true });
  const header =
    "# capture-ledger の pnpm run idp:bootstrap が書くファイル。**手で書かない**。\n" +
    "# 手元の Floci（Cognito の代役）のプール・client・利用者。secret とパスワードが入る。\n";
  const body = Object.entries(values)
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`${name} の値に改行が入っている`);
      return `${name}=${value}`;
    })
    .join("\n");
  writeFileSync(path, `${header}${body}\n`, { mode: 0o600 });
  return path;
};
