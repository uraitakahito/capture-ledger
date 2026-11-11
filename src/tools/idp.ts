/**
 * 手元の Cognito の代役（Floci）と話す道具の共通部分。**本番には無い。**
 *
 * ## なぜ Floci か
 *
 * 本番の IdP は Amazon Cognito。台帳はトークンを Cognito の形で確かめる
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

/** resource server と scope。Windmill の flow はこの scope でトークンを取る。 */
export const RESOURCE_SERVER = "capture-ledger";
export const CRAWL_SCOPE = `${RESOURCE_SERVER}/crawl`;

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

/** 引き渡しファイルを読む。`root` は台帳の根（既定はこの repo）。 */
export const readHandoff = (root: string = ROOT) => readEnvFile(resolve(root, IDP_HANDOFF));

/** 引き渡しファイルを書く（全部を置き換える）。値は印字しない —— secret が混じる。 */
export const writeHandoff = (values: Record<string, string>) => {
  const path = resolve(ROOT, IDP_HANDOFF);
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
