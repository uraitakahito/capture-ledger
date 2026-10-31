import { describe, it, expect } from "vitest";
import { parseHttpUrl, type ParsedUrl } from "../src/crawl/scope.js";
import {
  acceptLinks,
  checkRules,
  compileRules,
  covers,
  decide,
  decideLinks,
  matches,
  parsePattern,
  ruleOf,
  takeLinksFrom,
  type CompiledRule,
  type Pattern,
} from "../src/crawl/rules.js";
import type { CrawlRule } from "../src/db/database.js";

/**
 * 規則の並びの当て方。
 *
 * 規則は書いた人の意図どおりに当たっているように見えやすい —— 当たり方を 1 つ間違えても、
 * クロールは普通に終わり、archive も出る。境目 (ラベル・上から・覆い) を 1 つずつ固定しておく。
 */
const url = (raw: string): ParsedUrl => parseHttpUrl(raw)!;
const pattern = (raw: string): Pattern => parsePattern(raw)!;
const compiled = (rules: CrawlRule[]): CompiledRule[] => compileRules(rules)!;
const seed = url("https://www.site.test/");

describe("当てる物を読む", () => {
  it("範囲の 4 つの名前を読む", () => {
    for (const scope of ["same-origin", "same-host", "same-site", "any"]) {
      expect(parsePattern(scope)).toEqual({ kind: "scope", scope });
    }
  });

  it("小文字のホスト名をドメインに読む（IP と localhost も）", () => {
    for (const domain of ["ads.site.test", "xn--eckwd4c7c.test", "127.0.0.1", "localhost"]) {
      expect(parsePattern(domain)).toEqual({ kind: "domain", domain });
    }
  });

  it("http(s) の URL を前方一致に読み、ホストの大文字と既定の port を正規化する", () => {
    const read = parsePattern("HTTPS://WWW.Site.test:443/Search?q=1#top");
    expect(read?.kind).toBe("prefix");
    // パスの大文字は資源の名前なので残す。フラグメントは落とす (scope.ts の正規化と同じ)
    expect(read?.kind === "prefix" && read.url.normalized).toBe("https://www.site.test/Search?q=1");
  });

  it("origin だけの URL は、末尾に / の付いた前方一致になる", () => {
    // `https://www.site.test` のままだと `https://www.site.test.evil.net/` にも当たる
    const read = parsePattern("https://www.site.test");
    expect(read?.kind === "prefix" && read.url.normalized).toBe("https://www.site.test/");
  });

  it("大文字の混じったホスト名・*・ポート付き・ftp・空白入りは読めない", () => {
    for (const raw of [
      "ADS.site.test",
      "*.site.test",
      "site.test:443",
      "ftp://site.test/",
      "same origin",
      "",
    ]) {
      expect(parsePattern(raw), raw).toBeUndefined();
    }
  });
});

describe("ドメインはラベルの境目で照らす", () => {
  const ads = pattern("ads.site.test");

  it("そのホストと、その下のサブドメインに当たる", () => {
    expect(matches(url("https://ads.site.test/a"), ads, [seed])).toBe(true);
    expect(matches(url("https://x.y.ads.site.test/a"), ads, [seed])).toBe(true);
  });

  it("名前の後ろが同じだけのホストには当たらない（badads.site.test）", () => {
    // `endsWith("ads.site.test")` と書くとこれが当たる。境目は「.」
    expect(matches(url("https://badads.site.test/a"), ads, [seed])).toBe(false);
  });

  it("上のドメインには当たらず、ポートは見ない", () => {
    expect(matches(url("https://site.test/a"), ads, [seed])).toBe(false);
    expect(matches(url("http://ads.site.test:8080/a"), ads, [seed])).toBe(true);
  });

  it("前方一致は文字列の前方一致 —— /search は /searching にも当たる", () => {
    const search = pattern("https://www.site.test/search");
    expect(matches(url("https://www.site.test/search?q=1"), search, [seed])).toBe(true);
    expect(matches(url("https://www.site.test/searching"), search, [seed])).toBe(true);
    expect(matches(url("https://www.site.test/s"), search, [seed])).toBe(false);
  });
});

describe("上から当てる", () => {
  // 同じ URL に当たる規則が 2 つ。覆いではない (same-site は same-host を含むが、上が狭い)
  const rules = compiled([{ capture: "same-host" }, { follow: "same-site" }]);

  it("同じ URL に当たる規則が 2 つあれば、上の規則が勝つ", () => {
    expect(decide(url("https://www.site.test/a"), rules, [seed])).toEqual({
      action: "capture",
      rule: 1,
    });
  });

  it("上に当たらなければ下を見る", () => {
    expect(decide(url("https://shop.site.test/a"), rules, [seed])).toEqual({
      action: "follow",
      rule: 2,
    });
  });

  it("どれにも当たらなければ落とし、番号は 0", () => {
    expect(decide(url("https://other.invalid/a"), rules, [seed])).toEqual({
      action: "skip",
      rule: 0,
    });
  });
});

describe("リンクを見るページ", () => {
  const rules = compiled([{ capture: "outside.invalid" }, { follow: "same-host" }]);

  it("撮って辿るページのリンクは見る", () => {
    expect(takeLinksFrom(url("https://www.site.test/a"), rules, [seed])).toBe(true);
  });

  it("撮るだけのページのリンクは見ない —— 撮るだけの先は辿らない", () => {
    expect(takeLinksFrom(url("https://outside.invalid/a"), rules, [seed])).toBe(false);
  });

  it("どれにも当たらないページのリンクも見ない", () => {
    expect(takeLinksFrom(url("https://other.invalid/a"), rules, [seed])).toBe(false);
  });
});

describe("覆いの検査", () => {
  const covered = (a: string, b: string, seeds: readonly ParsedUrl[] = [seed]) =>
    covers(pattern(a), pattern(b), seeds);

  it("any は全部を覆う", () => {
    for (const b of ["same-origin", "same-site", "ads.site.test", "https://x.invalid/a"]) {
      expect(covered("any", b), b).toBe(true);
    }
  });

  it("範囲は same-site ⊇ same-host ⊇ same-origin で、逆向きは覆わない", () => {
    expect(covered("same-site", "same-host")).toBe(true);
    expect(covered("same-host", "same-origin")).toBe(true);
    expect(covered("same-site", "same-origin")).toBe(true);
    expect(covered("same-origin", "same-host")).toBe(false);
    expect(covered("same-host", "same-site")).toBe(false);
    expect(covered("same-site", "any")).toBe(false);
  });

  it("同じ当てる物は覆う（2 度書いた規則は二度と当たらない）", () => {
    expect(covered("same-host", "same-host")).toBe(true);
    expect(covered("ads.site.test", "ads.site.test")).toBe(true);
    expect(covered("https://www.site.test/a", "https://www.site.test/a")).toBe(true);
  });

  it("ドメインはその下のドメインを覆い、上や名前の後ろが同じだけのドメインは覆わない", () => {
    expect(covered("site.test", "ads.site.test")).toBe(true);
    expect(covered("ads.site.test", "site.test")).toBe(false);
    expect(covered("site.test", "badexample.com")).toBe(false);
  });

  it("same-site は起点と同じサイトのドメインを覆い、別のサイトのドメインは覆わない", () => {
    expect(covered("same-site", "ads.site.test")).toBe(true);
    expect(covered("same-site", "site.test")).toBe(true);
    expect(covered("same-site", "ads.other.invalid")).toBe(false);
    // 起点が無ければ言い切れない
    expect(covered("same-site", "ads.site.test", [])).toBe(false);
  });

  it("same-origin・same-host はドメインを覆わない（ドメインは別のホストも含む）", () => {
    expect(covered("same-origin", "www.site.test")).toBe(false);
    expect(covered("same-host", "www.site.test")).toBe(false);
  });

  it("前方一致は、それで始まる長い前方一致を覆う", () => {
    expect(covered("https://www.site.test/a", "https://www.site.test/a/b")).toBe(true);
    expect(covered("https://www.site.test/a/b", "https://www.site.test/a")).toBe(false);
  });

  it("前方一致の URL が範囲やドメインに当たれば、前方一致ごと覆う", () => {
    expect(covered("same-origin", "https://www.site.test/search")).toBe(true);
    expect(covered("same-site", "https://shop.site.test/search")).toBe(true);
    expect(covered("site.test", "https://ads.site.test/x")).toBe(true);
    expect(covered("same-origin", "https://shop.site.test/search")).toBe(false);
    expect(covered("site.test", "https://other-site.test/x")).toBe(false);
  });

  it("origin の直後の / まで無い前方一致は、範囲やドメインに覆われると言わない", () => {
    // 受けるときの正規化で / が付くので実際には来ない。来たときに頼らないことを固定する
    const bare: Pattern = {
      kind: "prefix",
      url: {
        normalized: "https://www.site.test",
        host: "www.site.test",
        hostname: "www.site.test",
        origin: "https://www.site.test",
      },
    };
    expect(covers(pattern("site.test"), bare, [seed])).toBe(false);
    expect(covers(pattern("same-origin"), bare, [seed])).toBe(false);
  });

  it("前方一致は、範囲もドメインも覆わない", () => {
    expect(covered("https://www.site.test/", "same-origin")).toBe(false);
    expect(covered("https://ads.site.test/", "ads.site.test")).toBe(false);
  });
});

describe("並びを確かめる", () => {
  it("読めない規則を、番号と頼まれた当てる物で名指す", () => {
    const checked = checkRules([{ skip: "ADS.site.test" }, { follow: "same-site" }], [seed]);
    expect(checked.invalid).toEqual([{ rule: 1, pattern: "ADS.site.test" }]);
  });

  it("前の規則に覆われた規則を、覆っている規則の番号と一緒に名指す", () => {
    const checked = checkRules([{ follow: "same-site" }, { skip: "ads.site.test" }], [seed]);
    expect(checked.covered).toEqual([{ rule: 2, coveredBy: 1 }]);
  });

  it("並べ替えれば覆いは消える", () => {
    const checked = checkRules([{ skip: "ads.site.test" }, { follow: "same-site" }], [seed]);
    expect(checked.covered).toEqual([]);
  });

  it("覆う規則が 2 つあれば、上の規則を名指す", () => {
    const checked = checkRules(
      [{ follow: "any" }, { capture: "same-site" }, { skip: "ads.site.test" }],
      [seed],
    );
    expect(checked.covered).toEqual([
      { rule: 2, coveredBy: 1 },
      { rule: 3, coveredBy: 1 },
    ]);
  });

  it("読めない規則は覆いの判定から外すが、番号は頼まれた並びのまま", () => {
    const checked = checkRules(
      [{ skip: "not a pattern" }, { follow: "same-site" }, { skip: "ads.site.test" }],
      [seed],
    );
    expect(checked.invalid).toEqual([{ rule: 1, pattern: "not a pattern" }]);
    expect(checked.covered).toEqual([{ rule: 3, coveredBy: 2 }]);
  });

  it("撮って辿るに当たらない起点を、正規化した URL で名指す", () => {
    const ads = url("https://ADS.site.test/x");
    const checked = checkRules([{ skip: "ads.site.test" }, { follow: "same-site" }], [seed, ads]);
    expect(checked.unfollowedSeeds).toEqual(["https://ads.site.test/x"]);
  });

  it("撮るだけに当たる起点も辿られない起点", () => {
    const checked = checkRules([{ capture: "same-host" }, { follow: "any" }], [seed]);
    expect(checked.unfollowedSeeds).toEqual([seed.normalized]);
  });

  it("規則を省いたときの並び（same-origin を辿る）は、起点を全部辿る", () => {
    const other = url("https://other.invalid/");
    const checked = checkRules([{ follow: "same-origin" }], [seed, other]);
    expect(checked).toMatchObject({ invalid: [], covered: [], unfollowedSeeds: [] });
  });
});

describe("書き残す形", () => {
  it("前方一致は正規化した URL で、ドメインと範囲は書いたまま", () => {
    const rules = compiled([
      { skip: "HTTPS://WWW.Site.test:443/search" },
      { capture: "ads.site.test" },
      { follow: "same-site" },
    ]);
    expect(rules.map(ruleOf)).toEqual([
      { skip: "https://www.site.test/search" },
      { capture: "ads.site.test" },
      { follow: "same-site" },
    ]);
  });

  it("行の規則が 1 本でも読めなければ、並びごと読めない", () => {
    expect(compileRules([{ follow: "same-host" }, { skip: "*.site.test" }])).toBeUndefined();
  });
});

describe("リンクに当てて、入れる物を選ぶ", () => {
  const rules = compiled([
    { skip: "skipped.invalid" },
    { follow: "same-host" },
    { capture: "any" },
  ]);
  const decided = (links: { href: string; rel?: string | null }[]) =>
    decideLinks(links, rules, [seed]);

  it("リンクごとに、当たった規則の動きと番号を付ける", () => {
    expect(
      decided([
        { href: "http://skipped.invalid/page" },
        { href: "https://www.site.test/a" },
        { href: "http://outside.invalid/page" },
      ]).map((link) => [link.action, link.rule]),
    ).toEqual([
      ["skip", 1],
      ["follow", 2],
      ["capture", 3],
    ]);
  });

  it("rel に nofollow を語として持つリンクと、http(s) でないリンクは当てる前に落とす", () => {
    expect(
      decided([
        { href: "https://www.site.test/a", rel: "nofollow" },
        { href: "https://www.site.test/b", rel: "noopener nofollow" },
        { href: "mailto:a@site.test" },
      ]),
    ).toEqual([]);
  });

  it("nofollow より長い語は nofollow ではない。rel が null でもよい", () => {
    // 部分一致で書くとこれが落ちる。`rel` は空白区切りの語の並び。BrowserHive は rel が無いと null を入れる
    expect(
      decided([
        { href: "https://www.site.test/a", rel: "nofollowme" },
        { href: "https://www.site.test/b", rel: null },
      ]),
    ).toHaveLength(2);
  });

  it("ホストはポートを含み、ホスト名は含まない", () => {
    const [link] = decided([{ href: "https://www.site.test:8443/a" }]);
    expect(link).toMatchObject({ host: "www.site.test:8443", hostname: "www.site.test" });
  });

  it("入れるのは撮って辿ると撮るだけで、落とす物は入れない", () => {
    const accepted = acceptLinks([
      {
        from: "7",
        links: decided([
          { href: "http://skipped.invalid/page" },
          { href: "https://www.site.test/a" },
          { href: "http://outside.invalid/page" },
        ]),
      },
    ]);
    expect(accepted.map((link) => link.url)).toEqual([
      "https://www.site.test/a",
      "http://outside.invalid/page",
    ]);
  });

  it("フラグメントだけ違うリンクと、2 ページで見つけたリンクは 1 本にし、最初に見つけたページを残す", () => {
    const accepted = acceptLinks([
      { from: "7", links: decided([{ href: "https://www.site.test/a#x" }]) },
      { from: "8", links: decided([{ href: "https://www.site.test/a" }]) },
    ]);
    expect(accepted).toEqual([
      { url: "https://www.site.test/a", host: "www.site.test", discoveredFrom: "7" },
    ]);
  });

  it("起点が複数なら、どれか 1 つの範囲に入る物を辿る", () => {
    const a = url("https://a.site.test/start");
    const b = url("https://b.site.test/start");
    const accepted = acceptLinks([
      {
        from: null,
        links: decideLinks(
          [
            { href: "https://a.site.test/1" },
            { href: "https://b.site.test/2" },
            { href: "https://c.site.test/3" },
          ],
          compiled([{ follow: "same-origin" }]),
          [a, b],
        ),
      },
    ]);
    expect(accepted.map((link) => link.url)).toEqual([
      "https://a.site.test/1",
      "https://b.site.test/2",
    ]);
  });
});
