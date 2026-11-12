import { describe, it, expect } from "vitest";
import {
  LINKS_PER_PAGE,
  cutOf,
  distinctLinks,
  linkRows,
  outcomeOf,
} from "../src/crawl/link-outcomes.js";
import type { PageLink } from "../src/crawl/rules.js";

/**
 * リンク 1 本ずつの「どうなったか」(`crawl_links`・`039`)。
 *
 * 決め方を 1 つ間違えても、クロールは普通に終わる。画面の数 (撮った・枚数で切った・深さで切った) だけが
 * 黙ってずれるので、境目を 1 つずつ固定する。入力は、決め方ごとに答えが分かれる物を別々に持つ。
 */
const SITE = "https://site.test";
const followed = (path: string, text = ""): PageLink => ({
  url: `${SITE}${path}`,
  host: "site.test",
  hostname: "site.test",
  action: "follow",
  rule: 1,
  nofollow: false,
  text,
});
const skipped = (url: string): PageLink => ({
  url,
  host: new URL(url).host,
  hostname: new URL(url).hostname,
  action: "skip",
  rule: 0,
  nofollow: false,
  text: "",
});
const nofollow = (path: string): PageLink => ({
  url: `${SITE}${path}`,
  host: "site.test",
  hostname: "site.test",
  nofollow: true,
  text: "",
});

describe("入らなかった理由", () => {
  it("深さだけに当たる段は「深さで切った」", () => {
    expect(cutOf({ nextDepth: 3, maxDepth: 2, closed: false })).toBe("max_depth");
  });

  it("深さの内の段は「枚数で切った」（行が無いのは、枠が尽きたから）", () => {
    expect(cutOf({ nextDepth: 2, maxDepth: 2, closed: false })).toBe("max_pages");
  });

  it("締まっていたら、深さに当たっていても「締まっていた」が先", () => {
    expect(cutOf({ nextDepth: 3, maxDepth: 2, closed: true })).toBe("closed");
    expect(cutOf({ nextDepth: 1, maxDepth: 2, closed: true })).toBe("closed");
  });
});

describe("リンク 1 本がどうなったか", () => {
  it("行が在って、見つけたのがこのページなら「次の段に入れた」", () => {
    expect(outcomeOf(followed("/a"), "10", "10", "max_pages")).toBe("followed");
  });

  it("行が在って、見つけたのが別のページなら「もう行がある」", () => {
    expect(outcomeOf(followed("/a"), "11", "10", "max_pages")).toBe("known");
  });

  it("起点へ戻るリンクは「もう行がある」（起点の行は、見つけたページが null）", () => {
    expect(outcomeOf(followed("/"), "10", null, "max_pages")).toBe("known");
  });

  it("規則は通したのに行が無ければ、入らなかった理由", () => {
    expect(outcomeOf(followed("/a"), "10", undefined, "max_pages")).toBe("max_pages");
    expect(outcomeOf(followed("/a"), "10", undefined, "max_depth")).toBe("max_depth");
    expect(outcomeOf(followed("/a"), "10", undefined, "closed")).toBe("closed");
  });

  it("規則で落とした物は、行が在っても無くても「落とした」", () => {
    expect(outcomeOf(skipped("https://other.test/"), "10", undefined, "max_pages")).toBe("skip");
    expect(outcomeOf(skipped("https://other.test/"), "10", "10", "max_pages")).toBe("skip");
  });

  it("nofollow は、規則を当てていないので「外した」（行が在っても）", () => {
    expect(outcomeOf(nofollow("/a"), "10", "10", "max_pages")).toBe("nofollow");
  });
});

describe("1 ページのリンクを URL ごとに 1 本にする", () => {
  it("同じ URL の 2 本目は落とし、あった順と最初の文字を残す", () => {
    const kept = distinctLinks([followed("/a", "一"), followed("/b"), followed("/a", "二")]);
    expect(kept.map((link) => [link.url, link.text])).toEqual([
      [`${SITE}/a`, "一"],
      [`${SITE}/b`, ""],
    ]);
  });

  it("nofollow の付いた物と付かない物が同じ URL なら、付かない方を最初の位置に残す", () => {
    const kept = distinctLinks([nofollow("/a"), followed("/b"), followed("/a")]);
    expect(kept.map((link) => [link.url, link.nofollow])).toEqual([
      [`${SITE}/a`, false],
      [`${SITE}/b`, false],
    ]);
  });

  it("付かない方が先なら、後の nofollow で置き換えない", () => {
    const kept = distinctLinks([followed("/a"), nofollow("/a")]);
    expect(kept).toEqual([followed("/a")]);
  });
});

describe("1 段ぶんの行", () => {
  const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";

  it("hub の形: 4 本のうち行が在る 2 本は入れた、無い 2 本は枚数で切った", () => {
    const { rows, dropped } = linkRows(
      CRAWL,
      [
        {
          from: "10",
          links: [
            followed("/leaf/1", "leaf 1"),
            followed("/leaf/2"),
            followed("/leaf/3"),
            followed("/hidden"),
          ],
        },
      ],
      new Map([
        [`${SITE}/`, null],
        [`${SITE}/leaf/1`, "10"],
        [`${SITE}/leaf/2`, "10"],
      ]),
      "max_pages",
    );
    expect(dropped).toBe(0);
    expect(rows.map((row) => [row.seq, row.url, row.outcome])).toEqual([
      [0, `${SITE}/leaf/1`, "followed"],
      [1, `${SITE}/leaf/2`, "followed"],
      [2, `${SITE}/leaf/3`, "max_pages"],
      [3, `${SITE}/hidden`, "max_pages"],
    ]);
    expect(rows[0]).toEqual({
      crawlId: CRAWL,
      fromPage: "10",
      seq: 0,
      url: `${SITE}/leaf/1`,
      hostname: "site.test",
      text: "leaf 1",
      rule: 1,
      outcome: "followed",
    });
  });

  it("同じ段の 2 ページが同じ新しい URL を指せば、行の見つけたページだけが「入れた」で、もう一方は「もう行がある」", () => {
    const { rows } = linkRows(
      CRAWL,
      [
        { from: "10", links: [followed("/x")] },
        { from: "11", links: [followed("/x")] },
      ],
      new Map([[`${SITE}/x`, "10"]]),
      "max_pages",
    );
    expect(rows.map((row) => [row.fromPage, row.outcome])).toEqual([
      ["10", "followed"],
      ["11", "known"],
    ]);
  });

  it("cycle の形: 起点へ戻るリンクは「もう行がある」", () => {
    const { rows } = linkRows(
      CRAWL,
      [{ from: "11", links: [followed("/a")] }],
      new Map([
        [`${SITE}/a`, null],
        [`${SITE}/b`, "10"],
      ]),
      "max_pages",
    );
    expect(rows.map((row) => row.outcome)).toEqual(["known"]);
  });

  it("落とした物は規則 0、nofollow は規則なし（null）で残る", () => {
    const { rows } = linkRows(
      CRAWL,
      [{ from: "10", links: [skipped("https://other.test/page"), nofollow("/n")] }],
      new Map(),
      "max_pages",
    );
    expect(rows.map((row) => [row.hostname, row.rule, row.outcome])).toEqual([
      ["other.test", 0, "skip"],
      ["site.test", null, "nofollow"],
    ]);
  });

  it("行の id が引けなかったページは書かない", () => {
    const { rows } = linkRows(
      CRAWL,
      [{ from: null, links: [followed("/a")] }],
      new Map(),
      "max_pages",
    );
    expect(rows).toEqual([]);
  });

  it("1 ページの上限を超えた分は書かず、数を返す", () => {
    const links = Array.from({ length: LINKS_PER_PAGE + 3 }, (_, i) => followed(`/p/${String(i)}`));
    const { rows, dropped } = linkRows(CRAWL, [{ from: "10", links }], new Map(), "max_depth");
    expect(rows).toHaveLength(LINKS_PER_PAGE);
    expect(dropped).toBe(3);
    expect(rows.at(-1)?.seq).toBe(LINKS_PER_PAGE - 1);
  });
});
