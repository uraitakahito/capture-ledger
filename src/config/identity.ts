/**
 * 実行の主体 —— 誰が、どの組織のために動かしているか。
 *
 * ## これは形であって、認証ではない
 *
 * ここに在るのは **クレームの読み方** だけで、検証はしない。署名と、トークンの種類・
 * 呼び手のアプリを確かめるのは `api/identity.ts` の resolver の仕事で、こちらは
 * 「読めた payload から Identity をどう組み立てるか」を 1 か所に置くためのもの。
 *
 * 本番の IdP は Amazon Cognito、手元はその代役の Floci（CAPTURE-185）。どちらも同じ形の
 * access token を出すので、読み方は 1 つで済む。
 */
import type { JWTPayload } from "jose";

export interface Identity {
  subject: string;
  organizations: string[];
}

/**
 * 組織のクレームの綴り。Cognito（と代役の Floci）は、利用者が属する群を
 * `cognito:groups`（文字列の配列）で人の access token に載せる。群の名前が組織の名前。
 *
 * **M2M（client credentials）のトークンには載らない。** 機械の組織は、capture-ledger が OpenFGA に
 * 保存した許可から引く（`api/identity.ts` の `machineOrganizations`）。
 *
 * 定数にしてあるのは、試験が同じものを参照できるようにするため —— 名前を変えた日に
 * 試験が **同時に** 赤くなる。群を作る側（`src/tools/idp-bootstrap.ts`）も群の名前しか
 * 書かないので、クレームの綴りを持つのはここだけ。
 */
export const ORGANIZATIONS_CLAIM = "cognito:groups";

/**
 * カンマ区切りから組織を読む。読み手は開発用ヘッダ `X-Capture-ledger-Organizations` だけ。
 *
 * 関数のまま残しているのは `test/claims.test.ts` が空要素の落とし方を直接見ているから
 * —— `,,  ,` のような入力の扱いは、ヘッダ経路の中に埋めると誰も見なくなる。
 */
export const organizationsFromList = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

/**
 * 機械（M2M）のトークンか。Cognito の client credentials のトークンは、`sub` に
 * app client の ID を入れ、`client_id` と同じ値にする（人のトークンの `sub` は利用者の ID）。
 */
export const isMachineToken = (payload: JWTPayload): boolean =>
  typeof payload.sub === "string" && payload.sub !== "" && payload.sub === payload["client_id"];

/**
 * 検証済みのクレームから主体を組む。
 *
 * **ここは検証しない。** 呼ぶ側（`api/identity.ts` の `jwtVerify` と、トークンの種類・
 * 呼び手のアプリの確かめ）が済ませている。この関数が答えるのは
 * 「そのクレームが、どんな `Identity` を表すか」だけ。
 *
 * 組織が無いのは不正ではない。「どこにも属さない人」は表せる必要があり、
 * その人は自分の組織のアーカイブを 1 つも見られない、というだけ。
 */
export const identityFromClaims = (payload: JWTPayload): Identity | undefined => {
  if (typeof payload.sub !== "string" || payload.sub === "") return undefined;
  const claim = payload[ORGANIZATIONS_CLAIM];
  return {
    subject: payload.sub,
    organizations: Array.isArray(claim)
      ? claim.filter((org): org is string => typeof org === "string" && org !== "")
      : [],
  };
};
