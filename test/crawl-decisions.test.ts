import { describe, it, expect } from "vitest";
import { aggregateDecisions, SAMPLES } from "../src/crawl/decisions.js";
import type { DecidedLink } from "../src/crawl/rules.js";

/**
 * 1 段の判断を `crawl_decisions` の行にまとめる。
 *
 * 数え方を誤っても、クロールは普通に終わる。台帳の数を信じて「この規則は 3 本落とした」と
 * 読む人のために、数え方を固定しておく。
 */
const link = (url: string, rule: number, action: DecidedLink["action"] = "skip"): DecidedLink => {
  const { host, hostname } = new URL(url);
  return { url, host, hostname, rule, action };
};

describe("判断をまとめる", () => {
  it("同じ URL を 2 ページで見つけても 1 本と数える", () => {
    const rows = aggregateDecisions(
      [link("http://skipped.invalid/page", 1), link("http://skipped.invalid/page", 1)],
      1,
    );
    expect(rows).toEqual([
      {
        depth: 1,
        rule: 1,
        action: "skip",
        hostname: "skipped.invalid",
        links: 1,
        samples: ["http://skipped.invalid/page"],
      },
    ]);
  });

  it("規則とホスト名の組ごとに 1 行。どれにも当たらない物は規則 0", () => {
    const rows = aggregateDecisions(
      [
        link("http://a.invalid/1", 1),
        link("http://b.invalid/1", 1),
        link("http://a.invalid/2", 0),
        link("https://www.site.test/x", 2, "follow"),
      ],
      2,
    );
    expect(rows.map((row) => [row.rule, row.hostname, row.action, row.links])).toEqual([
      [1, "a.invalid", "skip", 1],
      [1, "b.invalid", "skip", 1],
      [0, "a.invalid", "skip", 1],
      [2, "www.site.test", "follow", 1],
    ]);
    expect(rows.every((row) => row.depth === 2)).toBe(true);
  });

  it("ホスト名で数える —— ポートだけ違うリンクは同じ行", () => {
    const rows = aggregateDecisions(
      [link("http://a.invalid:8080/1", 3, "follow"), link("http://a.invalid:8081/1", 3, "follow")],
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostname: "a.invalid", links: 2 });
  });

  it("例は見つけた順に上限まで。数は上限を超えても全部", () => {
    const urls = Array.from({ length: SAMPLES + 3 }, (_, i) => `http://a.invalid/${String(i)}`);
    const [row] = aggregateDecisions(
      urls.map((url) => link(url, 1)),
      1,
    );
    expect(row?.links).toBe(SAMPLES + 3);
    expect(row?.samples).toEqual(urls.slice(0, SAMPLES));
  });

  it("何も決めていなければ行は無い", () => {
    expect(aggregateDecisions([], 1)).toEqual([]);
  });
});
