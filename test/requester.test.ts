import { describe, it, expect } from "vitest";
import { actorOf, requesterOf } from "../src/crawl/requester.js";

/**
 * クロールを頼んだ者を、名乗りと見出しから組む (CAPTURE-450)。行に残すのは主体の ID と、表示のための
 * 名前・app client・申告の名前。申告の名前は呼び手が自分で書くので、字の形だけを見る。
 */
describe("actorOf", () => {
  it("見出しが無ければ undefined (申告なし)", () => {
    expect(actorOf(undefined)).toBeUndefined();
  });

  it.each(["capture-450-swe.1", "a", "Seat_1", "x".repeat(64)])("%j は受ける", (value) => {
    expect(actorOf(value)).toBe(value);
  });

  // null は「在るが形が違う」。route はこれを 400 にする (黙って落とすと、申告したつもりの席が気づけない)。
  // 道具が「席の名前が分からなければ空」で見出しをいつも送っても、クロールは始まる。
  it.each(["", " ", "\t"])("空の見出し %j は、無いのと同じ (申告なし)", (value) => {
    expect(actorOf(value)).toBeUndefined();
  });

  it("前後の空白は落として読む", () => {
    expect(actorOf(" seat-1 ")).toBe("seat-1");
  });

  it.each(["a b", ".hidden", "-x", "席", "a/b", "x".repeat(65)])("%j は null", (value) => {
    expect(actorOf(value)).toBeNull();
  });

  it("見出しが 2 つ在れば null", () => {
    expect(actorOf(["a", "b"])).toBeNull();
  });
});

describe("requesterOf", () => {
  it("組織は 1 つ目、主体は subject", () => {
    expect(requesterOf({ subject: "alice", organizations: ["acme", "contoso"] })).toEqual({
      orgId: "acme",
      subject: "alice",
    });
  });

  it("組織が無ければ空文字 (今までどおり)", () => {
    expect(requesterOf({ subject: "alice", organizations: [] })).toEqual({
      orgId: "",
      subject: "alice",
    });
  });

  it("名前・app client・申告の名前を、在る物だけ足す", () => {
    expect(
      requesterOf(
        { subject: "ai-id", organizations: ["acme"], name: "ai", client: "ai", machine: true },
        "capture-450-swe.1",
      ),
    ).toEqual({
      orgId: "acme",
      subject: "ai-id",
      name: "ai",
      client: "ai",
      actor: "capture-450-swe.1",
    });
  });
});
