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
  /**
   * 読める名前 (CAPTURE-450)。人は access token の `username`、機械は app client の名前
   * (`CAPTURE_LEDGER_OIDC_CLIENT_IDS` に `名前=ID` と書いた物)。**表示のための物で、認可には使わない** ——
   * 許可も `owner` tuple も `subject` で書く。分からなければ無い。
   */
  name?: string;
  /** どの app client から来たか (受ける一覧に書いた名前)。名前の無い client と、ヘッダの経路では無い。 */
  client?: string;
  /** 機械 (client credentials) のトークンなら true。人とヘッダの経路では無い。 */
  machine?: true;
}

/** 人の access token が利用者の名前を載せるクレーム (Cognito と代役の Floci)。機械のトークンには無い。 */
export const USERNAME_CLAIM = "username";

/**
 * 受ける app client の一覧を読んだ結果。`names` は ID から名前へ (名前を書いた client だけ)。
 * Map にしてあるのは、ID が `constructor` のような object の元から在る名前でも、名前の無い client として読むため。
 */
export interface AcceptedClients {
  ids: string[];
  names: Map<string, string>;
}

/** app client の名前に使える字。行に写して画面に出すので、狭くしておく。 */
const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * `CAPTURE_LEDGER_OIDC_CLIENT_IDS` を読む。項目はカンマ区切りで、`ID` か `名前=ID` (CAPTURE-450)。
 *
 * 名前を書くと、その client から来たクロールの行に名前が残る (`crawls.requested_client`)。ID だけの
 * 書き方は今までどおり通り、名前が残らないだけ。**形の崩れた項目は投げる** —— 黙って落とすと、その client の
 * トークンが 401 になり、設定の誤りが「トークンが悪い」に見える。同じ ID に違う名前を書いた時も投げる
 * (どちらかが黙って勝つと、「始めた人」の欄が黙って誤る)。
 */
export const clientsFromList = (value: string): AcceptedClients => {
  const ids: string[] = [];
  const names = new Map<string, string>();
  for (const item of value.split(",").map((part) => part.trim())) {
    if (item === "") continue;
    const at = item.indexOf("=");
    if (at === -1) {
      ids.push(item);
      continue;
    }
    const name = item.slice(0, at).trim();
    const id = item.slice(at + 1).trim();
    if (!CLIENT_NAME.test(name) || id === "" || id.includes("=")) {
      throw new Error(
        `CAPTURE_LEDGER_OIDC_CLIENT_IDS の項目 "${item}" が読めません。` +
          "`ID` か `名前=ID` で書いてください (名前は英小文字・数字・ハイフンで 32 字まで)",
      );
    }
    const before = names.get(id);
    if (before !== undefined && before !== name) {
      throw new Error(
        `CAPTURE_LEDGER_OIDC_CLIENT_IDS の項目 "${item}" が読めません。` +
          `同じ ID に、違う名前 "${before}" がもう書いてあります`,
      );
    }
    ids.push(id);
    names.set(id, name);
  }
  return { ids, names };
};

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
  const username = payload[USERNAME_CLAIM];
  return {
    subject: payload.sub,
    organizations: Array.isArray(claim)
      ? claim.filter((org): org is string => typeof org === "string" && org !== "")
      : [],
    // 在るときだけ足す。機械のトークンには `username` が無く、名前は resolver が client の名前から足す
    ...(typeof username === "string" && username !== "" && { name: username }),
    ...(isMachineToken(payload) && { machine: true as const }),
  };
};
