/**
 * このリクエストを出しているのが誰か。
 *
 * ## これは継ぎ目であって、実装ではない
 *
 * 呼び出し元を認証することは、認可することとは別の問題で、identity provider に依存する。認可の層がそこから必要とするものは小さく安定して
 * いる —— subject と、その人が属する組織 —— ので、その形だけをここで固定し、
 * 裏の検証は他に触れずに差し替えられるようにしてある。
 *
 * 本番の IdP は Amazon Cognito、手元はその代役の Floci（CAPTURE-185）。どちらも JWT を
 * 検証する resolver を通る。下の開発用 resolver は header を信じる。それが安全なのは、
 * 明示的に有効化しない限り動くことを拒み、起動時に大きな声でそう言うから。
 *
 * ## なぜ組織はトークンから来るのか
 *
 * 所属は OpenFGA に保存しない。リクエストごとに contextual tuple として渡すので、
 * 組織への参加や離脱を認可ストアへ同期する必要が一度も生じない —— その点については
 * トークンが既に出どころだから。代償は、取り消しがトークンの失効を待つこと。
 * トークンを短命にすべき理由がそれ。
 */
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { optional } from "../config/env.js";
import {
  identityFromClaims,
  isMachineToken,
  organizationsFromList,
  type Identity,
} from "../config/identity.js";
import { createChildLogger } from "../logger.js";

export type { Identity };

const log = createChildLogger({ module: "identity" });

/**
 * 拒んだ理由のうち、ログに書いてよいもの: jose のエラーの `code` と、クレームの検査で
 * 落ちたならその名前 (`iss`・`aud`・`exp` …)。
 *
 * **エラーをそのまま渡さないこと。** jose のクレームのエラーは `payload` (トークンの中身)
 * を抱えている。書いてよいのは、どの検査で落ちたかだけ。
 */
const rejection = (err: unknown): { code?: string; claim?: string } => {
  if (typeof err !== "object" || err === null) return {};
  const { code, claim } = err as { code?: unknown; claim?: unknown };
  return {
    ...(typeof code === "string" && { code }),
    ...(typeof claim === "string" && { claim }),
  };
};

export type IdentityResolver = (request: FastifyRequest) => Promise<Identity | undefined>;

/**
 * ローカル開発用の、header を信じる resolver。
 *
 * `X-Capture-ledger-Subject` と `X-Capture-ledger-Organizations` (カンマ区切り) をそのまま受け取る
 * —— そのポートに届く者は誰にでもなれる。`CAPTURE_LEDGER_DEV_IDENTITY=1` のときしか
 * 到達できない。
 */
export const devIdentityResolver: IdentityResolver = (request) => {
  const subject = request.headers["x-capture-ledger-subject"];
  if (typeof subject !== "string" || subject === "") return Promise.resolve(undefined);

  const orgHeader = request.headers["x-capture-ledger-organizations"];
  // 綴りは環境変数の側と同じ。片方だけ空白の落とし方が変わってはいけない。
  const organizations = organizationsFromList(typeof orgHeader === "string" ? orgHeader : "");

  return Promise.resolve({ subject, organizations });
};

/** 確かめの設定。本番の Cognito でも、手元の Floci でも同じ形。 */
export interface JwtCheck {
  /** トークンの `iss`。鍵はその下の `/.well-known/jwks.json` に在る。 */
  issuer: string;
  /**
   * 受ける app client の ID。Cognito の access token は `aud` を持たず、呼び手のアプリを
   * `client_id` で言う（M2M のトークンは `aud` を持てない）。だから `aud` ではなくこれで照らす。
   */
  clientIds: readonly string[];
  /**
   * 機械（M2M）の組織を引く。M2M のトークンには `cognito:groups` が載らないので、
   * capture-ledger が OpenFGA に保存した許可から決める。渡さなければ、機械の組織は空のまま。
   */
  machineOrganizations?: (subject: string) => Promise<string[]>;
}

/**
 * 署名と `iss`・`exp` を通った payload を、さらに 2 つで確かめる。**落ちた理由**を返す
 * (通れば undefined)。形は jose のエラーと同じ `{ code, claim }` で、ログにだけ書く。
 *
 *   - `token_use` が `access` であること。ID token は API の名乗りに使わない
 *     (Cognito の ID token は `aud` に client の ID を持つので、`aud` で照らす式だと通ってしまう)
 *   - `client_id` が受ける一覧に在ること
 */
const accessTokenRefusal = (
  payload: JWTPayload,
  clientIds: readonly string[],
): { code: string; claim: string } | undefined => {
  if (payload["token_use"] !== "access")
    return { code: "ERR_NOT_ACCESS_TOKEN", claim: "token_use" };
  const clientId = payload["client_id"];
  if (typeof clientId !== "string" || !clientIds.includes(clientId)) {
    return { code: "ERR_CLIENT_NOT_ALLOWED", claim: "client_id" };
  }
  return undefined;
};

/**
 * JWT を検証する resolver。**本番でもこれを使う。**
 *
 * 鍵を引数で受け取るのは、単体試験で IdP を立てないため。本番と手元は
 * `createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"))` を渡し、
 * 試験はその場で作った鍵を渡す —— `jwtVerify` がどちらも受ける。
 *
 * **開発でだけ鍵をファイルから読む形にはしない。** そうするとこの行が本番と
 * 別のものになり、「本番の経路を毎日動かす」という狙いがそこで崩れる。
 */
export const jwtIdentityResolver =
  (keys: JWTVerifyGetKey | CryptoKey, options: JwtCheck): IdentityResolver =>
  async (request) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(header.slice("Bearer ".length), keys, {
        issuer: options.issuer,
      }));
    } catch (err) {
      // 失敗の理由は呼び手に返さない。どこで落ちたかは総当たりの手がかりになる。
      // API のログには残す —— 開発で「なぜ 401 か」を辿れるのはここだけ。
      log.info(rejection(err), "JWT rejected");
      return undefined;
    }
    const refused = accessTokenRefusal(payload, options.clientIds);
    if (refused !== undefined) {
      log.info(refused, "JWT rejected");
      return undefined;
    }
    // クレームの読み方は config/identity.ts の 1 か所。
    const identity = identityFromClaims(payload);
    if (identity === undefined) return undefined;
    // **try の外で引く。** OpenFGA に届かないのは「名乗りが偽」ではないので、401 に
    // 化けさせない (投げれば 500 になり、原因がログに出る)。
    if (
      isMachineToken(payload) &&
      identity.organizations.length === 0 &&
      options.machineOrganizations !== undefined
    ) {
      return { ...identity, organizations: await options.machineOrganizations(identity.subject) };
    }
    return identity;
  };

/** 全員を拒む。これが既定なので、設定していない配備から漏れることはない。 */
export const denyAllResolver: IdentityResolver = () => Promise.resolve(undefined);

/** 選んだ名乗り方。resolver と一緒に、どれを選んだかを持つ。 */
export type IdentitySetup =
  | { mode: "jwt"; issuer: string; clientIds: string[]; resolve: IdentityResolver }
  | { mode: "header"; resolve: IdentityResolver }
  | { mode: "deny"; resolve: IdentityResolver };

/**
 * 3 つのうちどれを使うか。**既定は拒否**。
 *
 * `CAPTURE_LEDGER_OIDC_ISSUER` が在れば JWT を検証する —— 手元の Floci でも本番の Cognito でも
 * 同じ経路を通り、違うのは `CAPTURE_LEDGER_OIDC_ISSUER` と `CAPTURE_LEDGER_OIDC_CLIENT_IDS` の値だけ。
 * 無ければ従来どおり `CAPTURE_LEDGER_DEV_IDENTITY=1` のときにヘッダを信じ、それも無ければ
 * 全員を拒む。
 *
 * JWT が開発用ヘッダより優先されるのは、**両方設定されている環境で弱いほうへ
 * 落ちない**ようにするため。
 *
 * issuer が在るのに client の ID が 1 つも無ければ、**起動で落とす。** 全員を 401 にして
 * 動き続けると、設定の漏れが「トークンが悪い」に見える。
 *
 * resolver だけでなく、どれを選んだかも返す。起動ログ (`startup-notes.ts`) がそれを言うため。
 */
export const selectIdentity = (
  deps: Pick<JwtCheck, "machineOrganizations"> = {},
): IdentitySetup => {
  const issuer = optional("CAPTURE_LEDGER_OIDC_ISSUER", "");
  if (issuer !== "") {
    const clientIds = optional("CAPTURE_LEDGER_OIDC_CLIENT_IDS", "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (clientIds.length === 0) {
      throw new Error(
        "CAPTURE_LEDGER_OIDC_ISSUER が在るのに CAPTURE_LEDGER_OIDC_CLIENT_IDS が空です。" +
          "受ける app client の ID をカンマ区切りで書いてください (手元なら pnpm run idp:bootstrap が .env.local に書く)",
      );
    }
    return {
      mode: "jwt",
      issuer,
      clientIds,
      resolve: jwtIdentityResolver(createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)), {
        issuer,
        clientIds,
        ...deps,
      }),
    };
  }
  return process.env["CAPTURE_LEDGER_DEV_IDENTITY"] === "1"
    ? { mode: "header", resolve: devIdentityResolver }
    : { mode: "deny", resolve: denyAllResolver };
};
