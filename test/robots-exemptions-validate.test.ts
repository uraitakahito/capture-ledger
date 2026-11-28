import { describe, expect, it } from "vitest";

import {
  checkExemption,
  expiresAtProblem,
  normalizeHost,
  pathPatternProblem,
  userAgentProblem,
  type ExemptionRequest,
} from "../src/exemptions/validate.js";

/** robots.txt の例外の登録の検査 (`src/exemptions/validate.ts`)。純粋な関数なので、字を渡して答えを見るだけ。 */
const NOW = new Date("2026-11-28T03:00:00.000Z");
const DAY = 86_400_000;

describe("normalizeHost", () => {
  it.each([
    ["site.test", "site.test"],
    ["Site.TEST", "site.test"],
    ["  site.test  ", "site.test"],
    ["site.test:8443", "site.test:8443"],
    // https の既定のポートは落ちる (`url.host` の形)
    ["site.test:443", "site.test"],
    ["日本語.test", "xn--wgv71a119e.test"],
    ["[::1]:8080", "[::1]:8080"],
  ])("%s は %s に整う", (input, host) => {
    expect(normalizeHost(input)).toBe(host);
  });

  it.each([
    "",
    "   ",
    "*",
    "*.site.test",
    "site.*",
    "https://site.test",
    "site.test/",
    "site.test/path",
    "user@site.test",
    "user:pass@site.test",
    "site.test?x=1",
    "site.test#top",
    "site .test",
    "site.test\nother.test",
    "site.test\\path",
    "site.test:port",
    // 末尾の点は url.host に残り、起点のホストと字で当たらない
    "site.test.",
    `${"a".repeat(300)}.test`,
  ])("%j は断る", (input) => {
    expect(normalizeHost(input)).toBeUndefined();
  });
});

describe("pathPatternProblem", () => {
  it.each(["/", "/status/", "/*/status/*", "/page$", "/a%20b", `/${"a".repeat(255)}`])(
    "%s は通る",
    (pattern) => {
      expect(pathPatternProblem(pattern)).toBeUndefined();
    },
  );

  it.each([
    ["", "start with /"],
    ["status", "start with /"],
    ["*", "start with /"],
    // 改行や # を許すと、型を robots.txt の規則として読む側が別の規則・注として読む
    ["/a\nDisallow: /", "printable ASCII"],
    ["/a\r", "printable ASCII"],
    ["/a b", "printable ASCII"],
    ["/a\tb", "printable ASCII"],
    ["/a#b", "printable ASCII"],
    ["/日本語", "printable ASCII"],
    [`/${"a".repeat(256)}`, "at most 256"],
  ])("%j は断る (%s)", (pattern, problem) => {
    expect(pathPatternProblem(pattern)).toContain(problem);
  });
});

describe("userAgentProblem", () => {
  it.each([
    "BrowserHive/1.0",
    "BrowserHive/32.1.1+build-7",
    "BrowserHive/1.0 (+https://site.test/bot)",
    "BrowserHive/1.0 (+http://site.test/bot)",
    // 印の語を一部に含むだけの語は断らない
    "BrowserHive/1.0 (+https://site.test/knowledge)",
    "BrowserHive/1.0 (+https://cooperate.test/operation)",
  ])("%s は通る", (userAgent) => {
    expect(userAgentProblem(userAgent)).toBeUndefined();
  });

  it.each([
    "",
    "BrowserHive",
    "BrowserHive/",
    "browserhive/1.0",
    `BrowserHive/${"1".repeat(33)}`,
    "BrowserHive/1.0 ",
    " BrowserHive/1.0",
    "BrowserHive/1.0 OtherBot/2.0",
    "BrowserHive/1.0 ()",
    "BrowserHive/1.0\n",
    // 注に書けるのは URL だけ。地の文は書けない
    "BrowserHive/1.0 (web archiving; user-directed capture)",
    "BrowserHive/1.0 (evidence capture; +https://site.test/bot)",
    "BrowserHive/1.0 (Windows NT 10.0; Win64; x64)",
    "BrowserHive/1.0 (a) (b)",
    "BrowserHive/1.0 (bot\nX-Injected: 1)",
    // URL は 1 つだけ。空白と括弧を含まない
    "BrowserHive/1.0 (+https://site.test/a +https://site.test/b)",
    "BrowserHive/1.0 (+https://site.test/bot; contact)",
    "BrowserHive/1.0 ( +https://site.test/bot )",
    "BrowserHive/1.0 (+ftp://site.test/bot)",
    "BrowserHive/1.0 (+https://)",
    "BrowserHive/1.0 (https://site.test/bot)",
  ])("%j は形で断る", (userAgent) => {
    expect(userAgentProblem(userAgent)).toContain("must be BrowserHive/<version>");
  });

  it.each([
    "BrowserHive/1.0 (+https://site.test/Version/17.0)",
    "BrowserHive/1.0 (+https://site.test/Brave/1.60)",
    // 日付や番号の段も同じ形なので断る
    "BrowserHive/1.0 (+https://site.test/docs/2024)",
  ])("%j は URL の中の製品の印の形で断る", (userAgent) => {
    expect(userAgentProblem(userAgent)).toContain("form of a product token");
  });

  it.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "BrowserHive/1.0 Chrome/131.0",
    "BrowserHive/1.0 (Mozilla/5.0)",
    "BrowserHive/1.0 ({chrome})",
    "{chrome} BrowserHive/1.0",
    "BrowserHive/1.0 (like GECKO)",
    "BrowserHive/1.0 (AppleWebKit)",
    // IE の名乗りの注の形
    "BrowserHive/1.0 (compatible; MSIE 10.0; Windows NT 6.2)",
    // ほかのクローラの名
    "BrowserHive/1.0 (compatible; Twitterbot)",
    "BrowserHive/1.0 (compatible; Googlebot; +http://www.google.com/bot.html)",
    "BrowserHive/1.0 (facebookexternalhit)",
    // 語は字のどこに在っても断る (URL の中も)。短い印は語の境目で当てる
    "BrowserHive/1.0 (+https://site.test/chrome)",
    "BrowserHive/1.0 (+https://site.test/Googlebot)",
    "BrowserHive/1.0 (+https://site.test/AdsBot-Google)",
    "BrowserHive/1.0 (+https://site.test/Edg/131.0)",
    "BrowserHive/1.0 (+https://site.test/OPR/115.0)",
    "BrowserHive/1.0 (+https://opera.test/bot)",
  ])("%j はほかの名乗りの語で断る", (userAgent) => {
    expect(userAgentProblem(userAgent)).toContain("name of a browser or of another crawler");
  });

  it("512 字を超えたら断る", () => {
    expect(userAgentProblem(`BrowserHive/1.0 (+https://site.test/${"a".repeat(512)})`)).toContain(
      "at most 512",
    );
    const fits = `BrowserHive/1.0 (+https://site.test/${"a".repeat(512 - 37)})`;
    expect(fits).toHaveLength(512);
    expect(userAgentProblem(fits)).toBeUndefined();
  });
});

describe("expiresAtProblem", () => {
  it("登録の時刻より後で、90 日以内なら通る", () => {
    expect(expiresAtProblem(new Date(NOW.getTime() + 1), NOW)).toBeUndefined();
    expect(expiresAtProblem(new Date(NOW.getTime() + 90 * DAY), NOW)).toBeUndefined();
  });

  it("今と同じか前は断る", () => {
    expect(expiresAtProblem(NOW, NOW)).toContain("in the future");
    expect(expiresAtProblem(new Date(NOW.getTime() - DAY), NOW)).toContain("in the future");
  });

  it("90 日を超えたら断る", () => {
    expect(expiresAtProblem(new Date(NOW.getTime() + 90 * DAY + 1), NOW)).toContain(
      "within 90 days",
    );
  });

  it("読めない時刻は断る", () => {
    expect(expiresAtProblem(new Date(Number.NaN), NOW)).toContain("ISO 8601");
  });
});

describe("checkExemption", () => {
  const request = (overrides: ExemptionRequest = {}): ExemptionRequest => ({
    host: "Site.TEST",
    scope: "seeds",
    userAgent: "BrowserHive/1.0 (+https://site.test/bot)",
    reason: "  公開の投稿を証拠として残す  ",
    expiresAt: "2026-12-28T03:00:00Z",
    ...overrides,
  });
  const problemOf = (overrides: ExemptionRequest) => {
    const checked = checkExemption(request(overrides), NOW);
    return checked.kind === "invalid" ? `${checked.field}: ${checked.problem}` : "valid";
  };

  it("既定を埋め、ホストと理由を整えて返す", () => {
    expect(checkExemption(request(), NOW)).toEqual({
      kind: "valid",
      exemption: {
        host: "site.test",
        pathPattern: "/",
        scope: "seeds",
        appliesTo: "all",
        userAgent: "BrowserHive/1.0 (+https://site.test/bot)",
        reason: "公開の投稿を証拠として残す",
        expiresAt: new Date("2026-12-28T03:00:00.000Z"),
        dailyLimit: 100,
        linkLimit: 20,
      },
    });
  });

  it("渡した欄はそのまま通る", () => {
    const checked = checkExemption(
      request({
        pathPattern: "/*/status/*",
        scope: "links",
        appliesTo: "human",
        dailyLimit: 10_000,
        linkLimit: 1000,
        expiresAt: "2026-12-01T09:00:00+09:00",
      }),
      NOW,
    );
    expect(checked).toMatchObject({
      kind: "valid",
      exemption: {
        pathPattern: "/*/status/*",
        scope: "links",
        appliesTo: "human",
        dailyLimit: 10_000,
        linkLimit: 1000,
        expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      },
    });
  });

  it.each<[ExemptionRequest, string]>([
    [{ host: "" }, "host: "],
    [{ host: "*.site.test" }, "host: "],
    [{ pathPattern: "status" }, "pathPattern: pathPattern must start with /"],
    [{ scope: "all" }, "scope: scope must be seeds or links"],
    [{ appliesTo: "machine" }, "appliesTo: appliesTo must be all or human"],
    [{ userAgent: "" }, "userAgent: userAgent is required"],
    [{ userAgent: "BrowserHive/1.0 Chrome/131.0" }, "userAgent: userAgent must not contain"],
    [{ reason: "   " }, "reason: reason must not be blank"],
    [{ reason: "あ".repeat(501) }, "reason: reason must be at most 500"],
    // offset の無い時刻は、読む側の時間帯で意味が変わる
    [{ expiresAt: "2026-12-28T03:00:00" }, "expiresAt: expiresAt must be an ISO 8601"],
    [{ expiresAt: "2026-12-28" }, "expiresAt: expiresAt must be an ISO 8601"],
    [{ expiresAt: "2026-11-28T03:00:00Z" }, "expiresAt: expiresAt must be in the future"],
    [{ expiresAt: "2027-02-27T03:00:00Z" }, "expiresAt: expiresAt must be within 90 days"],
    [{ dailyLimit: 0 }, "dailyLimit: dailyLimit must be an integer between 1 and 10000"],
    [{ dailyLimit: 10_001 }, "dailyLimit: "],
    [{ dailyLimit: 1.5 }, "dailyLimit: "],
    [{ linkLimit: 0 }, "linkLimit: linkLimit must be an integer between 1 and 1000"],
    [{ linkLimit: 1001 }, "linkLimit: "],
  ])("%j は欄を名指して断る", (overrides, problem) => {
    expect(problemOf(overrides)).toContain(problem);
  });

  // `.length` (UTF-16 の code unit) で数えると、絵文字は 1 つで 2 になり、250 個で断ってしまう
  it("理由の字は code point で数える (絵文字 500 個は通り、501 個は断る)", () => {
    expect(problemOf({ reason: "📸".repeat(500) })).toBe("valid");
    expect(problemOf({ reason: "📸".repeat(501) })).toContain("reason must be at most 500");
  });

  it("欄が無い本文は、最初の欄 (host) を名指す", () => {
    expect(checkExemption({}, NOW)).toMatchObject({ kind: "invalid", field: "host" });
  });

  it("500 字ちょうどの理由と、90 日ちょうどの期限は通る", () => {
    expect(problemOf({ reason: "あ".repeat(500), expiresAt: "2027-02-26T03:00:00Z" })).toBe(
      "valid",
    );
  });
});
