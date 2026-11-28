import { describe, expect, it } from "vitest";

import {
  comparedPagesOf,
  comparedTextOf,
  pairsOf,
  type ComparedPage,
} from "../src/changes/pairs.js";
import { recordingDb } from "./recording-db.js";

/**
 * 比べる組の作り方 (CAPTURE-236)。周回の数 (`pages_compared`) と、詳細の答えの「同じだったページ」は、どちらも
 * これで作る。周回がこれを使っていることは `change-worker` の試験が、本物の DB の数は `changes-smoke` が見る。
 */
const page = (url: string, over: Partial<ComparedPage> = {}): ComparedPage => ({
  archiveId: `${url}-id`,
  bucket: "browserhive",
  objectKey: `${url}.wacz`,
  url,
  stage: "after-capture-scripts",
  textSha256: "x",
  textWithheld: null,
  ...over,
});
const urls = (pairs: { after: ComparedPage }[]) => pairs.map((p) => p.after.url);

describe("比べる組", () => {
  it("両方の回に在る URL だけを、今回の回の順で組にする", () => {
    const pairs = pairsOf(
      [page("https://b.test/"), page("https://only-now.test/"), page("https://a.test/")],
      [
        page("https://a.test/", { archiveId: "a-prev" }),
        page("https://only-prev.test/"),
        page("https://b.test/"),
      ],
    );
    expect(urls(pairs)).toEqual(["https://b.test/", "https://a.test/"]);
    expect(pairs[1]).toMatchObject({
      after: { archiveId: "https://a.test/-id" },
      before: { archiveId: "a-prev" },
    });
  });

  it("どちらかの文字の digest が無い組は外す", () => {
    expect(
      pairsOf(
        [page("https://a.test/", { textSha256: null }), page("https://b.test/")],
        [page("https://a.test/"), page("https://b.test/", { textSha256: null })],
      ),
    ).toEqual([]);
  });

  it("どちらかを伏せた組は、digest が在っても外す", () => {
    expect(
      pairsOf(
        [
          page("https://a.test/", { textWithheld: "policy" }),
          page("https://b.test/"),
          page("https://c.test/"),
        ],
        [
          page("https://a.test/"),
          page("https://b.test/", { textWithheld: "policy" }),
          page("https://c.test/"),
        ],
      ).map((p) => p.after.url),
    ).toEqual(["https://c.test/"]);
  });

  it("digest が同じ組も違う組も組にする (差分を作るかは周回が決める)", () => {
    expect(
      urls(
        pairsOf(
          [
            page("https://a.test/", { textSha256: "same" }),
            page("https://b.test/", { textSha256: "new" }),
          ],
          [
            page("https://a.test/", { textSha256: "same" }),
            page("https://b.test/", { textSha256: "old" }),
          ],
        ),
      ),
    ).toEqual(["https://a.test/", "https://b.test/"]);
  });

  it("回のページは、WACZ ごとに after-capture-scripts の写し、無ければ文書の行を選び、同じ URL は先の WACZ の物", async () => {
    const at = new Date("2026-11-12T04:00:00.000Z");
    const row = (archiveId: string, url: string, stage: string | null, sha: string) => ({
      archiveId,
      bucket: "b",
      objectKey: `${archiveId}.wacz`,
      url,
      capturedAt: at,
      browserhiveVersion: "29.0.2",
      stage,
      textSha256: sha,
      textWithheld: null,
    });
    const { db, queries } = recordingDb([
      [
        row("a1", "https://a.test/", null, "doc"),
        row("a1", "https://a.test/", "after-load", "load"),
        row("a1", "https://a.test/", "after-capture-scripts", "behaviors"),
        row("b1", "https://b.test/", "after-load", "load"),
        row("b1", "https://b.test/", null, "doc"),
        row("c1", "https://c.test/", "after-load", "load"),
        row("a2", "https://a.test/", "after-capture-scripts", "later"),
      ],
    ]);
    const pages = await comparedPagesOf(db, "crawl");
    expect(pages.map((p) => [p.archiveId, p.stage, p.textSha256])).toEqual([
      ["a1", "after-capture-scripts", "behaviors"],
      ["b1", null, "doc"],
    ]);
    expect(pages[0]).toMatchObject({
      capturedAt: at,
      browserhiveVersion: "29.0.2",
      objectKey: "a1.wacz",
    });
    const { sql } = queries[0]!;
    expect(sql).toContain('"archives"."inspected_at" is not null');
    expect(sql).toContain('order by "archives"."captured_at", "archive_pages"."ordinal"');
  });
});

describe("WACZ の行から、比べる行の文字を取る", () => {
  const lines = [
    { url: "https://a.test/", text: "文書" },
    {
      url: "urn:browserhive:snapshot:after-load:https://a.test/",
      stage: "after-load",
      text: "読み込みの後",
    },
    {
      url: "urn:browserhive:snapshot:after-capture-scripts:https://a.test/",
      stage: "after-capture-scripts",
      text: "capture scripts の後",
    },
  ];

  it("時点を言えば、その時点の写しの文字", () => {
    expect(comparedTextOf(lines, "after-capture-scripts")).toBe("capture scripts の後");
  });

  it("時点が null なら、文書の行（stage の無い行）の文字", () => {
    expect(comparedTextOf(lines, null)).toBe("文書");
    expect(comparedTextOf([{ url: "https://a.test/", stage: "", text: "空の stage" }], null)).toBe(
      "空の stage",
    );
  });

  it("その行が無い・文字が無ければ空", () => {
    expect(comparedTextOf(lines.slice(0, 2), "after-capture-scripts")).toBe("");
    expect(comparedTextOf([{ url: "https://a.test/" }], null)).toBe("");
  });
});
