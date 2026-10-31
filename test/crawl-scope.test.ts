import { describe, it, expect } from "vitest";
import { parseHttpUrl, inScope, siteOf } from "../src/crawl/scope.js";

/**
 * 範囲の判定と正規化。規則の並びの当て方は `crawl-rules.test.ts`。
 *
 * ここが緩いとクロールは範囲外へ出て、厳しすぎると同じページを何度も取る。どちらも
 * 「動いているように見える」ので、境目を 1 つずつ固定しておく。
 */
const seed = parseHttpUrl("https://site.test/start")!;

describe("URL の読み取りと正規化", () => {
  it("drops the fragment", () => {
    // `#section` は同じ資源の中の位置。落とさないと同じページを何度も取る。
    expect(parseHttpUrl("https://site.test/a#top")?.normalized).toBe("https://site.test/a");
  });

  it("keeps the query untouched", () => {
    // 並べ替えたクエリが別のページを返すサイトは実在する。取りこぼしより取り違えが悪い。
    const a = parseHttpUrl("https://site.test/a?b=2&a=1")?.normalized;
    expect(a).toBe("https://site.test/a?b=2&a=1");
  });

  it("refuses a scheme that is not http(s)", () => {
    for (const raw of ["mailto:a@site.test", "javascript:alert(1)", "tel:+81", "data:,x"]) {
      expect(parseHttpUrl(raw)).toBeUndefined();
    }
  });

  it("refuses something that is not a url at all", () => {
    expect(parseHttpUrl("/relative/path")).toBeUndefined();
    expect(parseHttpUrl("")).toBeUndefined();
  });
});

describe("範囲の判定", () => {
  it("treats a different scheme as a different origin", () => {
    // http と https は別 origin。混在するサイトでは same-host を選ぶことになる。
    const candidate = parseHttpUrl("http://site.test/a")!;
    expect(inScope(candidate, [seed], "same-origin")).toBe(false);
    expect(inScope(candidate, [seed], "same-host")).toBe(true);
  });

  it("treats a different port as a different origin", () => {
    const candidate = parseHttpUrl("https://site.test:8443/a")!;
    expect(inScope(candidate, [seed], "same-origin")).toBe(false);
  });

  it("treats a subdomain as outside", () => {
    // `same-host` でも外。ホストが違えば別のサーバで、負荷の宛先も別。
    const candidate = parseHttpUrl("https://www.site.test/a")!;
    expect(inScope(candidate, [seed], "same-origin")).toBe(false);
    expect(inScope(candidate, [seed], "same-host")).toBe(false);
  });

  it("accepts the same origin on a different path", () => {
    expect(inScope(parseHttpUrl("https://site.test/deep/a")!, [seed], "same-origin")).toBe(true);
  });

  it("same-host はポートまで見て、scheme は見ない", () => {
    expect(inScope(parseHttpUrl("http://site.test/a")!, [seed], "same-host")).toBe(true);
    expect(inScope(parseHttpUrl("https://site.test:8443/a")!, [seed], "same-host")).toBe(false);
  });

  it("same-site はサブドメインを入れ、別のサイトは入れない", () => {
    const www = parseHttpUrl("https://www.example.co.jp/")!;
    expect(inScope(parseHttpUrl("https://shop.example.co.jp/a")!, [www], "same-site")).toBe(true);
    // co.jp は区切り。example.co.jp と other.co.jp は別のサイト
    expect(inScope(parseHttpUrl("https://other.co.jp/a")!, [www], "same-site")).toBe(false);
  });

  it("same-site は Public Suffix List の私的な区画も区切りに見る（foo.github.io と bar.github.io は別）", () => {
    // tldts の既定は私的な区画を見ないので、外すと 2 つが同じ github.io に数えられる
    const foo = parseHttpUrl("https://foo.github.io/")!;
    expect(inScope(parseHttpUrl("https://bar.github.io/")!, [foo], "same-site")).toBe(false);
    expect(inScope(parseHttpUrl("https://foo.github.io/x")!, [foo], "same-site")).toBe(true);
  });

  it("any は起点を見ずに全部を入れる", () => {
    expect(inScope(parseHttpUrl("https://anything.invalid/")!, [seed], "any")).toBe(true);
  });
});

describe("サイト", () => {
  it("登録ドメインを返す", () => {
    expect(siteOf("www.site.test")).toBe("site.test");
    expect(siteOf("a.b.example.co.jp")).toBe("example.co.jp");
  });

  it("登録ドメインを持たない名前（IP・localhost・区切りそのもの）は、ホスト名そのもの", () => {
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("localhost")).toBe("localhost");
    expect(siteOf("github.io")).toBe("github.io");
  });
});

describe("起点が複数のとき", () => {
  const a = parseHttpUrl("https://a.site.test/start")!;
  const b = parseHttpUrl("https://b.site.test/start")!;

  it("どれか 1 つの起点の範囲に入れば入る", () => {
    // **範囲は起点の数だけ広がる。** それでも「依頼時に決まって後から動かない」
    // という性質は変わらない —— 端のページが新しい中心になることは無い。
    expect(inScope(parseHttpUrl("https://b.site.test/deep")!, [a, b], "same-origin")).toBe(true);
  });

  it("どの起点の範囲にも入らなければ入らない", () => {
    expect(inScope(parseHttpUrl("https://c.site.test/x")!, [a, b], "same-origin")).toBe(false);
  });

  it("起点の URL が 0 本なら何も入らない", () => {
    // `011` の CHECK が作らせないので実際には来ないが、来たときに全部を範囲内と
    // 読むよりは、何も入らないほうがよい。
    expect(inScope(parseHttpUrl("https://a.site.test/x")!, [], "same-origin")).toBe(false);
  });
});
