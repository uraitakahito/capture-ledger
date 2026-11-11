import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  archivePageRows,
  canonicalUrl,
  composeReplayBundle,
  INITIAL_PAGES,
  pageKeys,
  replayDigestBytes,
  sha256Of,
  type BundleArchive,
  type BundlePage,
  type ComposeInput,
} from "../src/replay-bundle/format.js";
import type { SignedData } from "../src/replay-bundle/verify-signed-data.js";

/**
 * 合本の形 v1 を組む純粋な部分。ReplayWeb.page と replayweb-server が読む形 (並び・欄・置き場) を固定する。
 *
 * 並びは**わざと崩して渡す** —— 入力を正しい順で渡すと、並べ替えを消しても緑のまま通る。
 */

interface Vectors {
  version: number;
  cases: { input: string; canonical: string | null }[];
}

const VECTORS = "test/vectors/canonical-url.json";
/** replayweb-server が持つ原本 (submodule が無ければ照らす試験は飛ぶ)。 */
const UPSTREAM_VECTORS = ".upstream/replayweb-server/test/vectors/canonical-url.json";
const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Vectors;

describe("正規化（合本の形 v1 の例）", () => {
  it.each(vectors.cases.map((c) => [c.input, c.canonical] as const))(
    "%j を %j にする",
    (input, canonical) => {
      expect(canonicalUrl(input)).toBe(canonical);
    },
  );

  it("例は 1 件以上ある（写しが空なら上の試験は 1 本も走らない）", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(UPSTREAM_VECTORS))("写しは replayweb-server の原本と同じ中身", () => {
    expect(vectors).toEqual(JSON.parse(readFileSync(UPSTREAM_VECTORS, "utf8")));
  });
});

describe("頁の行の keys", () => {
  it("頼んだ URL と document.url を正規化し、重複は 1 つに", () => {
    expect(pageKeys("http://site.test/a#x", "http://site.test/b")).toEqual([
      "http://site.test/a",
      "http://site.test/b",
    ]);
    // リダイレクトが無ければ同じ URL。1 つにする
    expect(pageKeys("http://Site.TEST/a", "http://site.test/a#top")).toEqual([
      "http://site.test/a",
    ]);
  });

  it("document.url が無ければ頼んだ URL だけ、http(s) で読めない物は落とす", () => {
    expect(pageKeys("http://site.test/", undefined)).toEqual(["http://site.test/"]);
    expect(pageKeys("not a url", "mailto:a@site.test")).toEqual([]);
  });

  it("文書の行だけが keys を持ち、写しの行は空。欄は行のまま（無ければ null）", () => {
    const rows = archivePageRows(
      [
        { id: "t1", url: "http://site.test/", ts: "2026-11-05T01:03:57.957Z", title: "hub" },
        {
          id: "t1-after-load",
          url: "urn:browserhive:snapshot:after-load:http://site.test/after",
          ts: "2026-11-05T01:03:58.000Z",
          stage: "after-load",
        },
        { url: "http://site.test/no-id" },
      ],
      "http://site.test/after",
    );
    expect(rows).toEqual([
      {
        ordinal: 0,
        pageId: "t1",
        url: "http://site.test/",
        ts: "2026-11-05T01:03:57.957Z",
        title: "hub",
        stage: null,
        keys: ["http://site.test/", "http://site.test/after"],
        textSha256: null,
        textChars: null,
        textWithheld: null,
      },
      {
        ordinal: 1,
        pageId: "t1-after-load",
        url: "urn:browserhive:snapshot:after-load:http://site.test/after",
        ts: "2026-11-05T01:03:58.000Z",
        title: null,
        stage: "after-load",
        keys: [],
        textSha256: null,
        textChars: null,
        textWithheld: null,
      },
      {
        ordinal: 2,
        pageId: null,
        url: "http://site.test/no-id",
        ts: null,
        title: null,
        stage: null,
        keys: ["http://site.test/no-id", "http://site.test/after"],
        textSha256: null,
        textChars: null,
        textWithheld: null,
      },
    ]);
  });

  it("文字の sha256 と長さを入れ、伏せた行は理由だけを持つ (035)", () => {
    const [shown, withheld] = archivePageRows(
      [
        { url: "http://site.test/a", text: "本文" },
        { url: "http://site.test/b", textWithheld: "no-archive" },
      ],
      undefined,
    );
    expect(shown).toMatchObject({
      textSha256: createHash("sha256").update("本文").digest("hex"),
      textChars: 2,
      textWithheld: null,
    });
    expect(withheld).toMatchObject({
      textSha256: null,
      textChars: null,
      textWithheld: "no-archive",
    });
  });
});

const CRAWL = "3f2a1b2c-0000-4000-8000-000000000001";

const archive = (
  id: string,
  depth: number | null,
  capturedAt: string,
  over: Partial<BundleArchive> = {},
): BundleArchive => ({
  id,
  objectKey: `org/acme/2026-11/${id}_${CRAWL}.wacz`,
  waczSha256: id.repeat(64).slice(0, 64),
  indexEmpty: false,
  capturedAt: new Date(capturedAt),
  depth,
  ...over,
});

/** 文書の行と、その写しの行 (after-load)。 */
const pagesOf = (archiveId: string, url: string, ts: string): BundlePage[] => [
  {
    archiveId,
    ordinal: 0,
    pageId: archiveId,
    url,
    ts,
    title: url,
    stage: null,
    keys: [url],
  },
  {
    archiveId,
    ordinal: 1,
    pageId: `${archiveId}-after-load`,
    url: `urn:browserhive:snapshot:after-load:${url}`,
    ts,
    title: url,
    stage: "after-load",
    keys: [],
  },
];

const input = (over: Partial<ComposeInput> = {}): ComposeInput => {
  // 深さ 1 の頁を先に、起点 (深さ 0) を後に撮った (時刻も後) と言う並び。起点が先頭に来るのは並べたから
  const archives = [
    archive("b", 1, "2026-11-05T01:00:01.000Z"),
    archive("a", 0, "2026-11-05T01:00:09.000Z"),
    archive("c", 1, "2026-11-05T01:00:00.000Z"),
  ];
  return {
    crawlId: CRAWL,
    orgId: "acme",
    rev: 3,
    depth: 1,
    builtAt: new Date("2026-11-05T03:30:00.000Z"),
    crawlState: "succeeded",
    stopReason: "completed",
    finishedAt: new Date("2026-11-05T03:29:58.000Z"),
    archives,
    pages: [
      ...pagesOf("b", "http://site.test/b", "2026-11-05T01:00:01.000Z"),
      ...pagesOf("a", "http://site.test/", "2026-11-05T01:00:09.000Z"),
      ...pagesOf("c", "http://site.test/c", "2026-11-05T01:00:00.000Z"),
    ],
    ...over,
  };
};

describe("合本を組む", () => {
  it("置き場は org/<orgId>/crawls/<crawlId>/r<版>/ で、replay.json と pages.json を置く", () => {
    const bundle = composeReplayBundle(input());
    expect(bundle.dir).toBe(`org/acme/crawls/${CRAWL}/r3`);
    expect(bundle.replayKey).toBe(`org/acme/crawls/${CRAWL}/r3/replay.json`);
    expect(bundle.pagesKey).toBe(`org/acme/crawls/${CRAWL}/r3/pages.json`);
    expect(bundle.replayJson.pagesQueryUrl).toBe(`/q/org/acme/crawls/${CRAWL}/r3/pages`);
  });

  it("版は置き場・題・pagesQueryUrl・記録に出る（深さは記録だけ）", () => {
    const bundle = composeReplayBundle(input({ rev: 7, depth: 2 }));
    expect(bundle.replayJson.title).toBe("クロール 3f2a1b2c の合本 r7");
    expect(bundle.replayJson.pagesQueryUrl).toBe(`/q/org/acme/crawls/${CRAWL}/r7/pages`);
    expect(bundle.pagesJson).toMatchObject({ version: 1, crawlId: CRAWL, rev: 7 });
    expect(bundle.replayJson.replayBundle).toEqual({
      version: 1,
      crawlId: CRAWL,
      rev: 7,
      depth: 2,
      builtAt: "2026-11-05T03:30:00.000Z",
      crawlState: "succeeded",
      stopReason: "completed",
      finishedAt: "2026-11-05T03:29:58.000Z",
      members: 3,
      skipped: 0,
      skippedResources: [],
      pagesHash: sha256Of(bundle.pagesBytes),
    });
  });

  it("resources は起点の WACZ を先頭に、深さ・撮った時刻の順（後から撮った起点でも先頭）", () => {
    const bundle = composeReplayBundle(input());
    expect(bundle.replayJson.resources.map((resource) => resource.name)).toEqual([
      `a_${CRAWL}.wacz`,
      `c_${CRAWL}.wacz`,
      `b_${CRAWL}.wacz`,
    ]);
    expect(bundle.members).toEqual(["a", "c", "b"]);
    expect(bundle.replayJson.resources[0]).toEqual({
      name: `a_${CRAWL}.wacz`,
      path: `/wacz/org/acme/2026-11/a_${CRAWL}.wacz`,
      hash: `sha256:${"a".repeat(64)}`,
      crawlId: CRAWL,
    });
  });

  it("深さの引けない WACZ は最後", () => {
    const bundle = composeReplayBundle(
      input({
        archives: [
          archive("x", null, "2026-11-05T00:00:00.000Z"),
          archive("a", 0, "2026-11-05T01:00:00.000Z"),
        ],
        pages: [],
      }),
    );
    expect(bundle.members).toEqual(["a", "x"]);
  });

  it("鍵の path は区切りごとに百分率の符号に", () => {
    const bundle = composeReplayBundle(
      input({
        orgId: "a b",
        archives: [archive("a", 0, "2026-11-05T00:00:00.000Z", { objectKey: "dir x/a+b%.wacz" })],
        pages: [],
      }),
    );
    expect(bundle.replayJson.resources[0]?.path).toBe("/wacz/dir%20x/a%2Bb%25.wacz");
    expect(bundle.replayJson.resources[0]?.name).toBe("a+b%.wacz");
    expect(bundle.replayKey).toBe(`org/a b/crawls/${CRAWL}/r3/replay.json`);
    expect(bundle.replayJson.pagesQueryUrl).toBe(`/q/org/a%20b/crawls/${CRAWL}/r3/pages`);
  });

  it("initialPages は文書の行だけで、起点を先頭に深さ・時刻の順。写しの行は入れない", () => {
    const bundle = composeReplayBundle(input());
    expect(bundle.replayJson.initialPages).toEqual([
      {
        id: "a",
        url: "http://site.test/",
        ts: "2026-11-05T01:00:09.000Z",
        title: "http://site.test/",
        filename: `a_${CRAWL}.wacz`,
        isSeed: true,
        crawl_id: CRAWL,
      },
      {
        id: "c",
        url: "http://site.test/c",
        ts: "2026-11-05T01:00:00.000Z",
        title: "http://site.test/c",
        filename: `c_${CRAWL}.wacz`,
        isSeed: false,
        crawl_id: CRAWL,
      },
      {
        id: "b",
        url: "http://site.test/b",
        ts: "2026-11-05T01:00:01.000Z",
        title: "http://site.test/b",
        filename: `b_${CRAWL}.wacz`,
        isSeed: false,
        crawl_id: CRAWL,
      },
    ]);
  });

  it(`initialPages は ${String(INITIAL_PAGES)} 行まで（頁の総数は totalPages）`, () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      archive(
        `p${String(i).padStart(2, "0")}`,
        1,
        `2026-11-05T01:00:${String(i).padStart(2, "0")}.000Z`,
      ),
    );
    const seed = archive("seed", 0, "2026-11-05T02:00:00.000Z");
    const bundle = composeReplayBundle(
      input({
        archives: [...many, seed],
        pages: [...many, seed].flatMap((one) =>
          pagesOf(one.id, `http://site.test/${one.id}`, one.capturedAt.toISOString()),
        ),
      }),
    );
    expect(bundle.replayJson.initialPages).toHaveLength(INITIAL_PAGES);
    expect(bundle.replayJson.initialPages[0]).toMatchObject({ id: "seed", isSeed: true });
    expect(bundle.replayJson.initialPages[1]?.id).toBe("p00");
    expect(bundle.replayJson.totalPages).toBe(62);
    expect(bundle.pagesJson.pages).toHaveLength(62);
  });

  it("pages.json は全部の行（写しも）を filename・深さ・stage つきで持ち、写しの keys は空", () => {
    const bundle = composeReplayBundle(input());
    expect(bundle.pagesJson.pages.slice(0, 2)).toEqual([
      {
        id: "a",
        url: "http://site.test/",
        ts: "2026-11-05T01:00:09.000Z",
        title: "http://site.test/",
        filename: `a_${CRAWL}.wacz`,
        depth: 0,
        stage: null,
        keys: ["http://site.test/"],
      },
      {
        id: "a-after-load",
        url: "urn:browserhive:snapshot:after-load:http://site.test/",
        ts: "2026-11-05T01:00:09.000Z",
        title: "http://site.test/",
        filename: `a_${CRAWL}.wacz`,
        depth: 0,
        stage: "after-load",
        keys: [],
      },
    ]);
    expect(bundle.replayJson.totalPages).toBe(6);
  });

  it("id の無い行には <filename>#<ordinal> を振る（replayweb-server は id を文字列に限って読む）", () => {
    const base = input();
    const pages = base.pages.map((page) =>
      page.archiveId === "a" ? { ...page, pageId: null } : page,
    );
    const bundle = composeReplayBundle({ ...base, pages });
    const filename = `a_${CRAWL}.wacz`;
    expect(bundle.pagesJson.pages.slice(0, 2).map((page) => page.id)).toEqual([
      `${filename}#0`,
      `${filename}#1`,
    ]);
    // 一覧の 1 ページ目 (起点が先頭) にも同じ id が出る
    expect(bundle.replayJson.initialPages[0]?.id).toBe(`${filename}#0`);
    // id を持つ行はそのまま
    expect(bundle.pagesJson.pages.map((page) => page.id)).toContain("b");
  });

  it("記録が 0 の WACZ は resources にも pages.json にも入れず、数と名前・sha256 を残す", () => {
    const base = input();
    const bundle = composeReplayBundle({
      ...base,
      archives: base.archives.map((one) => (one.id === "c" ? { ...one, indexEmpty: true } : one)),
    });
    expect(bundle.replayJson.replayBundle.skippedResources).toEqual([
      { name: `c_${CRAWL}.wacz`, hash: `sha256:${"c".repeat(64)}` },
    ]);
    expect(bundle.members).toEqual(["a", "b"]);
    expect(bundle.replayJson.resources.map((resource) => resource.name)).not.toContain(
      `c_${CRAWL}.wacz`,
    );
    expect(bundle.pagesJson.pages.map((page) => page.filename)).not.toContain(`c_${CRAWL}.wacz`);
    expect(bundle.replayJson.initialPages.map((page) => page.id)).not.toContain("c");
    expect(bundle.skipped).toBe(1);
    expect(bundle.replayJson.replayBundle).toMatchObject({ members: 2, skipped: 1 });
    expect(bundle.replayJson.totalPages).toBe(4);
  });
});

/**
 * 署名が覆うのは replay.json のバイト列 (CAPTURE-61)。クロールについて証したい事 (WACZ の sha256・pages.json の
 * sha256・外した WACZ・クロールの状態) は、どれも replay.json の中に在る。
 */
describe("署名が覆う物", () => {
  const sha256 = (bytes: Buffer): string =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  it("置くバイト列は、組んだ物を JSON にした物そのもの（hash を計るのと置くのに同じ Buffer を使う）", () => {
    const bundle = composeReplayBundle(input());
    expect(bundle.replayBytes.equals(Buffer.from(JSON.stringify(bundle.replayJson)))).toBe(true);
    expect(bundle.pagesBytes.equals(Buffer.from(JSON.stringify(bundle.pagesJson)))).toBe(true);
    expect(bundle.digestKey).toBe(`org/acme/crawls/${CRAWL}/r3/replay-digest.json`);
  });

  it("pagesHash は pages.json のバイト列の sha256 で、頁の行が 1 つ変われば変わる", () => {
    const bundle = composeReplayBundle(input());
    expect(bundle.replayJson.replayBundle.pagesHash).toBe(sha256(bundle.pagesBytes));
    const base = input();
    const retitled = composeReplayBundle({
      ...base,
      pages: base.pages.map((page) => (page.pageId === "b" ? { ...page, title: "別の題" } : page)),
    });
    expect(retitled.replayJson.replayBundle.pagesHash).not.toBe(
      bundle.replayJson.replayBundle.pagesHash,
    );
  });

  it("版を払い出した時のクロールの状態を書く（走っている版は stopReason も finishedAt も null）", () => {
    const running = composeReplayBundle(
      input({ crawlState: "running", stopReason: null, finishedAt: null }),
    );
    expect(running.replayJson.replayBundle).toMatchObject({
      crawlState: "running",
      stopReason: null,
      finishedAt: null,
    });
    const failed = composeReplayBundle(
      input({
        crawlState: "failed",
        stopReason: "failed",
        finishedAt: new Date("2026-11-05T04:00:00.000Z"),
      }),
    );
    expect(failed.replayJson.replayBundle).toMatchObject({
      crawlState: "failed",
      stopReason: "failed",
      finishedAt: "2026-11-05T04:00:00.000Z",
    });
  });

  it("外した WACZ は名前の順に並べる（入力の順によらない）", () => {
    const bundle = composeReplayBundle(
      input({
        archives: [
          archive("z", 1, "2026-11-05T01:00:00.000Z", { indexEmpty: true }),
          archive("a", 0, "2026-11-05T01:00:01.000Z"),
          archive("m", 1, "2026-11-05T01:00:02.000Z", { indexEmpty: true }),
        ],
        pages: [],
      }),
    );
    expect(bundle.replayJson.replayBundle.skippedResources.map((one) => one.name)).toEqual([
      `m_${CRAWL}.wacz`,
      `z_${CRAWL}.wacz`,
    ]);
    expect(bundle.skipped).toBe(2);
  });

  it("replay-digest.json は {path: replay.json, hash, signedData} を 2 字の字下げと末尾の改行で書く", () => {
    const signedData = { hash: "sha256:00", signature: "c2ln" } as unknown as SignedData;
    const bytes = replayDigestBytes("sha256:00", signedData);
    expect(bytes.toString("utf8")).toBe(
      '{\n  "path": "replay.json",\n  "hash": "sha256:00",\n  "signedData": {\n' +
        '    "hash": "sha256:00",\n    "signature": "c2ln"\n  }\n}\n',
    );
  });
});
