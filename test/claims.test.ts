import { describe, it, expect } from "vitest";
import type { JWTPayload } from "jose";

import {
  ORGANIZATIONS_CLAIM,
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
