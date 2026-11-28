/**
 * 同じ URL の取り込みの一覧 (`GET /api/history`。CAPTURE-462)。代役は `history-app.ts`。読む SQL は本物の Kysely が
 * 組んだ物を照らす (Postgres で本当に通るか・索引を使うかは、CI の `history-smoke`)。
 */
import { describe, expect, it } from "vitest";

import { HISTORY_PAGE_SIZE } from "../src/changes/history.js";
import { archiveOf, call, CRAWL, NOW, sha256, URL_A, type ArchiveSeed } from "./history-app.js";

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => new Date(NOW.getTime() - n * 60_000);
const historyUrl = (url: string, more = "") => `/api/history?url=${encodeURIComponent(url)}${more}`;

interface Row {
  id: string;
  capturedAt: string;
  objectKey: string;
  crawlId: string | null;
  origin: { kind: string; scheduleId: string | null; scheduleName: string | null };
  recipeSha256: string | null;
  browserhiveVersion: string | null;
  text: { stage: string | null; sha256: string; chars: number } | null;
  notComparable: string | null;
}
interface Answer {
  url: string;
  archives: Row[];
  next: string | null;
}

/** n 本の取り込み (新しい順)。 */
const many = (n: number): ArchiveSeed[] =>
  Array.from({ length: n }, (_, i) => archiveOf(id(i + 1), { doc: "x" }, { capturedAt: at(i) }));

describe("同じ URL の取り込みの一覧", () => {
  it("渡した URL を正規化してから引き、正規化した URL を答えに載せる", async () => {
    const { res, queries } = await call(
      { archives: [archiveOf(id(1), { doc: "x" })] },
      { url: historyUrl("HTTPS://Site.test#top") },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<Answer>().url).toBe(URL_A);
    const list = queries[0];
    // 索引の列 (digest) と、URL そのものの両方で絞る
    expect(list?.sql).toContain(
      `where "a"."source_url_hash" = digest($1::text, 'sha256') and "a"."source_url" = $2 ` +
        `order by "a"."captured_at" desc limit $3`,
    );
    expect(list?.parameters).toEqual([URL_A, URL_A, HISTORY_PAGE_SIZE + 1]);
  });

  it("before は「この時刻より前」の条件になる", async () => {
    const { queries } = await call(
      { archives: [] },
      { url: historyUrl(URL_A, "&before=2026-11-20T19:00:32.000Z") },
    );
    expect(queries[0]?.sql).toContain('"a"."captured_at" < $3');
    expect(queries[0]?.parameters).toEqual([
      URL_A,
      URL_A,
      new Date("2026-11-20T19:00:32.000Z"),
      HISTORY_PAGE_SIZE + 1,
    ]);
  });

  it("http でも https でもない字は 400（invalid url）で、DB を読まない", async () => {
    for (const url of ["mailto:someone@site.test", "site.test/a", "javascript:alert(1)"]) {
      const { res, queries } = await call({}, { url: historyUrl(url) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid url" });
      expect(queries).toEqual([]);
    }
  });

  it("url が無い・空・before が日時でないときは 400", async () => {
    expect((await call({}, { url: "/api/history" })).res.statusCode).toBe(400);
    expect((await call({}, { url: "/api/history?url=" })).res.statusCode).toBe(400);
    expect((await call({}, { url: historyUrl(URL_A, "&before=yesterday") })).res.statusCode).toBe(
      400,
    );
  });

  it("知らない引数は 400", async () => {
    const { res, queries } = await call({}, { url: historyUrl(URL_A, "&limit=5") });
    expect(res.statusCode).toBe(400);
    expect(queries).toEqual([]);
  });

  it("名乗らなければ 401", async () => {
    const { res } = await call({ signedIn: false }, { url: historyUrl(URL_A) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthenticated" });
  });

  it("クロールを頼めない人には空（正規化した URL つき）で、DB を読まない", async () => {
    const { res, queries, batchAsked } = await call(
      { archives: many(3), submit: false },
      { url: historyUrl("https://site.test") },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: URL_A, archives: [], next: null });
    expect(queries).toEqual([]);
    expect(batchAsked).toEqual([]);
  });

  it("見てよくない取り込みの行は出ず、そのページの行も読まない", async () => {
    const { res, queries, batchAsked } = await call(
      { archives: many(3), viewable: [id(1), id(3)] },
      { url: historyUrl(URL_A) },
    );
    expect(res.json<Answer>().archives.map((a) => a.id)).toEqual([id(1), id(3)]);
    // まとめ訊きは、引いた行の全部について 1 度
    expect(batchAsked).toEqual([[id(1), id(2), id(3)]]);
    const pages = queries.find((q) => q.sql.includes('from "archive_pages"'));
    expect(pages?.parameters).toEqual([id(1), id(3)]);
  });

  it("続きが在れば next は 50 行目の撮った時刻で、51 行目は返さず、見てよいかも訊かない", async () => {
    const { res, batchAsked } = await call(
      { archives: many(HISTORY_PAGE_SIZE + 1) },
      { url: historyUrl(URL_A) },
    );
    const body = res.json<Answer>();
    expect(body.archives).toHaveLength(HISTORY_PAGE_SIZE);
    expect(body.archives.at(-1)?.id).toBe(id(HISTORY_PAGE_SIZE));
    expect(body.next).toBe(at(HISTORY_PAGE_SIZE - 1).toISOString());
    expect(batchAsked[0]).toHaveLength(HISTORY_PAGE_SIZE);
  });

  it("ちょうど 50 行なら next は null", async () => {
    const { res } = await call({ archives: many(HISTORY_PAGE_SIZE) }, { url: historyUrl(URL_A) });
    const body = res.json<Answer>();
    expect(body.archives).toHaveLength(HISTORY_PAGE_SIZE);
    expect(body.next).toBeNull();
  });

  it("見てよい行が 0 でも、続きが在れば next は時刻（返った行数からは決めない）", async () => {
    const { res, queries } = await call(
      { archives: many(HISTORY_PAGE_SIZE + 1), viewable: [] },
      { url: historyUrl(URL_A) },
    );
    expect(res.json()).toEqual({
      url: URL_A,
      archives: [],
      next: at(HISTORY_PAGE_SIZE - 1).toISOString(),
    });
    // 見てよい行が無ければ、ページの行は読まない (空の in を組まない)
    expect(queries.filter((q) => q.sql.includes('from "archive_pages"'))).toEqual([]);
  });

  it("取り込みが無い URL は空で、OpenFGA にも訊かない", async () => {
    const { res, batchAsked } = await call({ archives: [] }, { url: historyUrl(URL_A) });
    expect(res.json()).toEqual({ url: URL_A, archives: [], next: null });
    expect(batchAsked).toEqual([]);
  });

  it("比べる行は after-capture-scripts の写し、無ければ文書の行。比べられない行には訳が付く", async () => {
    const seeds: ArchiveSeed[] = [
      // 文書の行と写しの両方 → 写し
      archiveOf(id(1), { doc: "文書", behaviors: "スクリプトの後" }),
      // 写しは after-load だけ → 文書の行
      archiveOf(id(2), { doc: "文書だけ" }),
      // 写しも文書の行も無い (after-load の写しだけ)
      { id: id(3), crawl: CRAWL, pages: [{ stage: "after-load", textSha256: sha256("x") }] },
      // 文書の行に文字が無い
      { id: id(4), crawl: CRAWL, pages: [{ stage: null, textSha256: null }] },
      // 比べる行 (写し) を伏せた。文書の行には文字が在る
      {
        id: id(5),
        crawl: CRAWL,
        pages: [
          { stage: null, textSha256: sha256("文書"), textChars: 2 },
          { stage: "after-capture-scripts", textSha256: null, textWithheld: "no-archive" },
        ],
      },
      // まだ検めていない (ページの行が無い)
      { id: id(6), crawl: CRAWL, inspected: false },
      // 検めていない行は、伏せた行より先に言う
      {
        id: id(7),
        crawl: CRAWL,
        inspected: false,
        pages: [{ stage: null, textWithheld: "deny" }],
      },
    ];
    const { res, queries } = await call({ archives: seeds }, { url: historyUrl(URL_A) });
    const rows = res.json<Answer>().archives;
    expect(rows.map((row) => [row.text, row.notComparable])).toEqual([
      [{ stage: "after-capture-scripts", sha256: sha256("スクリプトの後"), chars: 7 }, null],
      [{ stage: null, sha256: sha256("文書だけ"), chars: 4 }, null],
      [null, "no_text"],
      [null, "no_text"],
      [null, "withheld"],
      [null, "not_inspected"],
      [null, "not_inspected"],
    ]);
    // 行は SQL の中で選ばない: 取り込みのページの行を全部、ordinal の順に引く
    const pages = queries.find((q) => q.sql.includes('from "archive_pages"'));
    expect(pages?.sql).toBe(
      'select "archive_id", "stage", "text_sha256", "text_chars", "text_withheld" from "archive_pages" ' +
        'where "archive_id" in ($1, $2, $3, $4, $5, $6, $7) order by "archive_id", "ordinal"',
    );
  });

  it("行は出どころ（予定・手・不明）と撮り方と版を持つ", async () => {
    const manual = { ...CRAWL, id: "c0000000-0000-4000-8000-000000000002", scheduleId: null };
    const { res, keyOf } = await call(
      {
        archives: [
          archiveOf(id(1), { doc: "x" }),
          archiveOf(
            id(2),
            { doc: "x" },
            { crawl: { ...manual, scheduleName: null, recipeSha256: null } },
          ),
          archiveOf(id(3), { doc: "x" }, { crawl: null, browserhiveVersion: null }),
        ],
      },
      { url: historyUrl(URL_A) },
    );
    const rows = res.json<Answer>().archives;
    expect(rows[0]).toEqual({
      id: id(1),
      capturedAt: NOW.toISOString(),
      objectKey: keyOf({ id: id(1) }),
      crawlId: CRAWL.id,
      origin: { kind: "schedule", scheduleId: CRAWL.scheduleId, scheduleName: CRAWL.scheduleName },
      recipeSha256: CRAWL.recipeSha256,
      browserhiveVersion: "32.0.3",
      text: { stage: null, sha256: sha256("x"), chars: 1 },
      notComparable: null,
    });
    expect(rows[1]).toMatchObject({
      crawlId: manual.id,
      origin: { kind: "manual", scheduleId: null, scheduleName: null },
      recipeSha256: null,
    });
    expect(rows[2]).toMatchObject({
      crawlId: null,
      origin: { kind: "unknown", scheduleId: null, scheduleName: null },
      recipeSha256: null,
      browserhiveVersion: null,
    });
  });
});
