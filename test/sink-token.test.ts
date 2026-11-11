/**
 * 受け取り先のトークンを試す。
 *
 * **これが権限そのもの。** BrowserHive が持つのはこれ 1 つで、他のクロールの成果物に
 * 触れる手段は無い —— という主張が本当かどうかが、ここで決まる。
 *
 * 試している契約は 1 文で書ける: **自分のクロールの、期限内のトークンだけが通る。**
 */
import { describe, expect, it } from "vitest";

import { issueSinkToken, sinkObjectKey, verifySinkToken } from "../src/api/sink.js";

const SECRET = "s3cret";
const CRAWL = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const future = (ms: number): Date => new Date(Date.now() + ms);

describe("受け取り先のトークン", () => {
  it("自分で発行したものは通る", () => {
    const token = issueSinkToken(SECRET, CRAWL, future(60_000));

    expect(verifySinkToken(SECRET, CRAWL, token)).toBe(true);
  });

  it("別のクロールのトークンは通らない", () => {
    // **ここが通ると、1 つの取り込みが他人の成果物を上書きできる。**
    const token = issueSinkToken(SECRET, OTHER, future(60_000));

    expect(verifySinkToken(SECRET, CRAWL, token)).toBe(false);
  });

  it("期限が切れたものは通らない", () => {
    const token = issueSinkToken(SECRET, CRAWL, new Date(Date.now() - 1_000));

    expect(verifySinkToken(SECRET, CRAWL, token)).toBe(false);
  });

  it("期限ちょうどは通らない", () => {
    // 境界は「切れている」側に倒す。取り込みの上限より長く発行すればよいだけなので、
    // ここで甘くする理由が無い。
    const now = new Date();
    const token = issueSinkToken(SECRET, CRAWL, now);

    expect(verifySinkToken(SECRET, CRAWL, token, now)).toBe(false);
  });

  it("署名を書き換えたものは通らない", () => {
    const token = issueSinkToken(SECRET, CRAWL, future(60_000));
    const dot = token.indexOf(".");
    const tampered = `${token.slice(0, dot)}.${"A".repeat(token.length - dot - 1)}`;

    expect(verifySinkToken(SECRET, CRAWL, tampered)).toBe(false);
  });

  it("期限だけ延ばしたものは通らない", () => {
    // 署名は `{crawlId, exp}` に掛かっているので、exp を書き換えると合わなくなる。
    const token = issueSinkToken(SECRET, CRAWL, future(60_000));
    const mac = token.slice(token.indexOf(".") + 1);
    const forged = `${String(Math.floor(Date.now() / 1000) + 86_400)}.${mac}`;

    expect(verifySinkToken(SECRET, CRAWL, forged)).toBe(false);
  });

  it("別の鍵で作ったものは通らない", () => {
    const token = issueSinkToken("other-secret", CRAWL, future(60_000));

    expect(verifySinkToken(SECRET, CRAWL, token)).toBe(false);
  });

  it("壊れた形は例外にせず false", () => {
    // 「壊れた形」と「合わない署名」を呼ぶ側から区別させない。
    for (const bad of ["", ".", "abc", "notanumber.mac", ".mac", "123"]) {
      expect(verifySinkToken(SECRET, CRAWL, bad)).toBe(false);
    }
  });
});

describe("置き場所", () => {
  it("組織で分ける —— 鍵そのものが帰属の出どころになる", () => {
    expect(sinkObjectKey("acme", "t__x.wacz")).toBe("org/acme/t__x.wacz");
  });
});
