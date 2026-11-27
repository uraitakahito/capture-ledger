import { describe, it, expect } from "vitest";
import type { JWTPayload } from "jose";

import {
  ORGANIZATIONS_CLAIM,
  clientsFromList,
  identityFromClaims,
  isMachineToken,
  organizationsFromList,
} from "../src/config/identity.js";

// JWTPayload は index signature を持つので、そのまま渡せる。
const claims = (payload: Record<string, unknown>): JWTPayload => payload;

/**
 * クレームから主体を組む規則。組織のクレームの綴りは `ORGANIZATIONS_CLAIM` の 1 か所
 * (Cognito の `cognito:groups`)。
 *
 * 以前は API と CLI が別々に読んでいて、片方のクレーム名だけを変えると片方の試験しか
 * 赤くならなかった。読む所を 1 つにしたので、綴りを変えた日にはここが赤くなる。
 */
describe("ORGANIZATIONS_CLAIM", () => {
  // Cognito (と代役の Floci) が人の access token に群を載せる綴り。手元の Floci で確かめた
  // (CAPTURE-185 の段 0)。ここが変わるなら、本番の IdP の形が変わったということ。
  it("Cognito の群のクレーム", () => {
    expect(ORGANIZATIONS_CLAIM).toBe("cognito:groups");
  });
});

describe("isMachineToken", () => {
  it("sub と client_id が同じなら機械 (client credentials)", () => {
    expect(isMachineToken(claims({ sub: "abc", client_id: "abc" }))).toBe(true);
  });
  it("違えば人", () => {
    expect(isMachineToken(claims({ sub: "user-sub", client_id: "abc" }))).toBe(false);
  });
  it("client_id が無ければ人", () => {
    expect(isMachineToken(claims({ sub: "abc" }))).toBe(false);
  });
  it("sub が空なら機械ではない", () => {
    expect(isMachineToken(claims({ sub: "", client_id: "" }))).toBe(false);
  });
});

describe("identityFromClaims", () => {
  it("sub と組織のクレームから Identity を組む", () => {
    expect(identityFromClaims(claims({ sub: "alice", [ORGANIZATIONS_CLAIM]: ["acme"] }))).toEqual({
      subject: "alice",
      organizations: ["acme"],
    });
  });

  // 読める名前 (CAPTURE-450)。人の access token は username を持つ。在るときだけ写す。
  it("username が在れば name に写す", () => {
    expect(identityFromClaims(claims({ sub: "alice-sub", username: "alice" }))).toEqual({
      subject: "alice-sub",
      organizations: [],
      name: "alice",
    });
  });

  it("username が文字列でなければ name は無い", () => {
    expect(identityFromClaims(claims({ sub: "alice-sub", username: 42 }))).toEqual({
      subject: "alice-sub",
      organizations: [],
    });
  });

  // OAuth の scope は空白区切り。1 つずつに分ける (CAPTURE-450。門が字の同じかで見る)
  it("scope を空白で分けて scopes に写す。空なら無い", () => {
    expect(
      identityFromClaims(claims({ sub: "abc", client_id: "abc", scope: "a/crawl  a/crawl.start" })),
    ).toEqual({
      subject: "abc",
      organizations: [],
      machine: true,
      scopes: ["a/crawl", "a/crawl.start"],
    });
    expect(identityFromClaims(claims({ sub: "abc", scope: "" }))).toEqual({
      subject: "abc",
      organizations: [],
    });
  });

  // 機械かは sub と client_id で決まる。名前はここでは付かない (client の名前は resolver が設定から引く)。
  it("sub と client_id が同じなら machine が付く", () => {
    expect(identityFromClaims(claims({ sub: "abc", client_id: "abc" }))).toEqual({
      subject: "abc",
      organizations: [],
      machine: true,
    });
  });

  it("sub が無ければ undefined", () => {
    expect(identityFromClaims(claims({ [ORGANIZATIONS_CLAIM]: ["acme"] }))).toBeUndefined();
  });

  it("sub が空文字なら undefined", () => {
    expect(identityFromClaims(claims({ sub: "" }))).toBeUndefined();
  });

  // 「どこにも属さない人」は表せる必要がある —— 組織が無いことは不正ではない。
  it("組織のクレームが無ければ、組織は空になる", () => {
    expect(identityFromClaims(claims({ sub: "alice" }))).toEqual({
      subject: "alice",
      organizations: [],
    });
  });

  it("組織のクレームが配列でなければ、組織は空になる", () => {
    expect(identityFromClaims(claims({ sub: "alice", [ORGANIZATIONS_CLAIM]: "acme" }))).toEqual({
      subject: "alice",
      organizations: [],
    });
  });

  it("空文字と文字列でない要素を落とす", () => {
    expect(
      identityFromClaims(claims({ sub: "alice", [ORGANIZATIONS_CLAIM]: ["acme", "", 42, null] })),
    ).toEqual({ subject: "alice", organizations: ["acme"] });
  });
});

/**
 * カンマ区切りから組織を読む規則。開発用ヘッダ (`X-Capture-ledger-Organizations`) と
 * 環境変数 (`CAPTURE_LEDGER_DEV_ORGANIZATIONS`) が同じ綴りを使う。
 */
describe("organizationsFromList", () => {
  it("カンマで割って前後の空白を落とす", () => {
    expect(organizationsFromList("acme, contoso")).toEqual(["acme", "contoso"]);
  });

  it("空の項目を落とす", () => {
    expect(organizationsFromList("acme,,  ,contoso")).toEqual(["acme", "contoso"]);
  });

  it("空文字なら空の一覧", () => {
    expect(organizationsFromList("")).toEqual([]);
  });
});

/**
 * 受ける app client の一覧 (`CAPTURE_LEDGER_OIDC_CLIENT_IDS`) の読み方。項目は `ID` か `名前=ID` (CAPTURE-450)。
 * 名前は、その client から来たクロールの行に残る。
 */
describe("clientsFromList", () => {
  it("ID だけの項目は、今までどおり読む（名前は無い）", () => {
    expect(clientsFromList(" web , windmill ,")).toEqual({
      ids: ["web", "windmill"],
      names: new Map(),
    });
  });

  it("名前=ID の項目は、ID と名前を読む", () => {
    expect(clientsFromList("workbench=abc,ai = def")).toEqual({
      ids: ["abc", "def"],
      names: new Map([
        ["abc", "workbench"],
        ["def", "ai"],
      ]),
    });
  });

  it("2 つの書き方を混ぜてよい", () => {
    expect(clientsFromList("workbench=abc,def")).toEqual({
      ids: ["abc", "def"],
      names: new Map([["abc", "workbench"]]),
    });
  });

  it("空文字なら空", () => {
    expect(clientsFromList("")).toEqual({ ids: [], names: new Map() });
  });

  // どちらかが黙って勝つと、「始めた人」の欄が黙って誤る。同じ名前の書き直しは害が無いので通す。
  it("同じ ID に違う名前を書いたら投げる。同じ名前なら通す", () => {
    expect(() => clientsFromList("a=abc,b=abc")).toThrow(/同じ ID に、違う名前 "a"/);
    expect(clientsFromList("a=abc,a=abc").names).toEqual(new Map([["abc", "a"]]));
  });

  // ID が object の元から在る名前でも、名前の無い client として読む (名前を引くと関数が返る、を塞ぐ)。
  it("constructor という ID は、名前の無い client", () => {
    const { ids, names } = clientsFromList("constructor");
    expect(ids).toEqual(["constructor"]);
    expect(names.get("constructor")).toBeUndefined();
  });

  // 名前は行に写して画面に出す。字を限り、崩れた項目は黙って落とさずに投げる。
  it.each(["=abc", "name=", "Name=abc", "na me=abc", "a=b=c", `${"x".repeat(33)}=abc`])(
    "形の崩れた項目 %j は投げる",
    (item) => {
      expect(() => clientsFromList(item)).toThrow(/CAPTURE_LEDGER_OIDC_CLIENT_IDS の項目/);
    },
  );
});
