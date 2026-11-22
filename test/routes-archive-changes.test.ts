/**
 * 好きな 2 本の差分 (`GET /api/archives/:id/changes?since=`。CAPTURE-462)。代役は `history-app.ts`。
 *
 * 作り物の WACZ は末尾の控えより大きいので、Range で読んでいること (丸ごと読んでいないこと) は、保管庫の記録で見える。
 */
import { describe, expect, it } from "vitest";

import { ENTRY_MAX_BYTES, TAIL_BYTES } from "../src/archive/wacz-range.js";
import { changeOf } from "../src/changes/change-of.js";
import { MAX_LINE_PRODUCT } from "../src/changes/compare.js";
import { changeInputSha256, PAIR_PROMPT, PAIR_PROMPT_VERSION } from "../src/changes/summarize.js";
import {
  archiveOf,
  call,
  CRAWL,
  NOW,
  pagesWacz,
  sha256,
  URL_A,
  type ArchiveSeed,
  type BuildOptions,
} from "./history-app.js";

const AFTER = "a0000000-0000-4000-8000-0000000000aa";
const BEFORE = "b0000000-0000-4000-8000-0000000000bb";
const PREV_AT = new Date("2026-11-21T04:00:00.000Z");
const OLD = "お知らせ\n価格 100 円\n更新: 2026-11-21\nお問い合わせ";
const NEW = "お知らせ\n価格 120 円\n新しい行\n更新: 2026-11-22\nお問い合わせ";

const after = (text = NEW, over: Partial<ArchiveSeed> = {}) =>
  archiveOf(AFTER, { doc: "文書（今）", behaviors: text }, over);
const before = (text = OLD, over: Partial<ArchiveSeed> = {}) =>
  archiveOf(
    BEFORE,
    { doc: "文書（前）", behaviors: text },
    { capturedAt: PREV_AT, browserhiveVersion: "28.0.1", ...over },
  );

const changesUrl = (id = AFTER, since = BEFORE) => `/api/archives/${id}/changes?since=${since}`;
const get = (opts: BuildOptions, url = changesUrl()) => call(opts, { url });

interface Answer {
  url: string;
  state: string;
  reason: string | null;
  sameBy: string | null;
  added: number;
  removed: number;
  hunks: string[][];
  recipeDiffers: boolean | null;
  stageDiffers: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  summary: unknown;
  significance: unknown;
  headline: unknown;
  quotes: unknown;
}

describe("好きな 2 本の差分", () => {
  it("違う 2 本の hunks は、changeOf に前と今の文字を直に渡した結果と同じ（:id が今、since が前）", async () => {
    const { res, keyOf } = await get({ archives: [after(), before()] });
    expect(res.statusCode).toBe(200);
    const expected = changeOf(OLD, NEW);
    // 前と今を取り違えると、足した行と消した行が逆になる
    expect(expected.added).toBe(3);
    expect(expected.removed).toBe(2);
    expect(res.json()).toEqual({
      url: URL_A,
      state: "diffed",
      reason: null,
      sameBy: null,
      added: expected.added,
      removed: expected.removed,
      hunks: expected.hunks,
      recipeDiffers: false,
      stageDiffers: false,
      before: {
        archiveId: BEFORE,
        objectKey: keyOf({ id: BEFORE }),
        sourceUrl: URL_A,
        capturedAt: PREV_AT.toISOString(),
        browserhiveVersion: "28.0.1",
        stage: "after-behaviors",
      },
      after: {
        archiveId: AFTER,
        objectKey: keyOf({ id: AFTER }),
        sourceUrl: URL_A,
        capturedAt: NOW.toISOString(),
        browserhiveVersion: "32.0.3",
        stage: "after-behaviors",
      },
      summary: null,
      significance: null,
      headline: null,
      quotes: [],
    });
    expect(Object.keys(res.json<object>())).toEqual([
      "url",
      "state",
      "reason",
      "sameBy",
      "added",
      "removed",
      "hunks",
      "recipeDiffers",
      "stageDiffers",
      "before",
      "after",
      "summary",
      "significance",
      "headline",
      "quotes",
    ]);
  });

  it("2 本の WACZ は Range で読み、丸ごとは読まない（末尾の 256 KiB を 1 度ずつ）", async () => {
    const a = after();
    const b = before();
    const { ranges, keyOf } = await get({ archives: [a, b] });
    const tail = (seed: ArchiveSeed) => {
      const size = seed.wacz?.length ?? 0;
      return `${keyOf(seed)} bytes=${String(size - TAIL_BYTES)}-${String(size - 1)}`;
    };
    expect(ranges.sort()).toEqual([tail(a), tail(b)].sort());
  });

  it("文字の digest が同じ 2 本は「同じ」（sameBy は digest）で、保管庫に触らない", async () => {
    const { res, ranges } = await get({
      // 保管庫には置かない。触れば「WACZ が無い」になる
      archives: [after(OLD, { wacz: undefined }), before(OLD, { wacz: undefined })],
    });
    expect(res.json()).toMatchObject({
      state: "same",
      reason: null,
      sameBy: "digest",
      added: 0,
      removed: 0,
      hunks: [],
    });
    expect(ranges).toEqual([]);
  });

  it("digest は違うが空行と字下げだけが違う 2 本は「同じ」（sameBy は lines）", async () => {
    const indented = "お知らせ\n\n   価格 100 円\n更新: 2026-11-21\n\n\nお問い合わせ\n";
    expect(sha256(indented)).not.toBe(sha256(OLD));
    const { res, ranges } = await get({ archives: [after(indented), before(OLD)] });
    expect(res.json()).toMatchObject({
      state: "same",
      reason: null,
      sameBy: "lines",
      added: 0,
      removed: 0,
      hunks: [],
    });
    expect(ranges).toHaveLength(2);
  });

  it("名乗らなければ 401", async () => {
    expect((await get({ signedIn: false })).res.statusCode).toBe(401);
  });

  it("クロールを頼めない人には 404 で、見てよいかも訊かず、DB も保管庫も読まない", async () => {
    const { res, asked, queries, ranges } = await get({
      archives: [after(), before()],
      submit: false,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(asked.filter((a) => a.relation === "can_view")).toEqual([]);
    expect(queries).toEqual([]);
    expect(ranges).toEqual([]);
  });

  it("見てよくない取り込みを含むと 404 で、取り込みの中身の読みも保管庫も走らない", async () => {
    for (const viewable of [[AFTER], [BEFORE], []]) {
      const { res, queries, ranges } = await get({ archives: [after(), before()], viewable });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
      expect(queries).toEqual([]);
      expect(ranges).toEqual([]);
    }
  });

  it("can_view を、2 本それぞれについて強い一貫性で訊く（まとめ訊きは使わない）", async () => {
    const { asked, batchAsked } = await get({ archives: [after(), before()] });
    expect(asked.filter((a) => a.relation === "can_view")).toEqual([
      { relation: "can_view", object: `archive:${AFTER}`, consistency: "HIGHER_CONSISTENCY" },
      { relation: "can_view", object: `archive:${BEFORE}`, consistency: "HIGHER_CONSISTENCY" },
    ]);
    expect(batchAsked).toEqual([]);
  });

  it("どちらかの取り込みが無ければ 404 で、ページの行も保管庫も読まない", async () => {
    for (const archives of [[after()], [before()]]) {
      const { res, queries, ranges } = await get({ archives });
      expect(res.statusCode).toBe(404);
      expect(queries.filter((q) => q.sql.includes('from "archive_pages"'))).toEqual([]);
      expect(ranges).toEqual([]);
    }
  });

  it("URL が違う 2 本は 422（different url）で、保管庫を読まない", async () => {
    const { res, ranges } = await get({
      archives: [after(), before(OLD, { sourceUrl: "https://site.test/other" })],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "different url" });
    expect(ranges).toEqual([]);
  });

  it("WACZ が保管庫に無ければ「WACZ が無い」", async () => {
    for (const archives of [
      [after(NEW, { wacz: undefined, waczBytes: 300_000 }), before()],
      [after(), before(OLD, { wacz: undefined, waczBytes: 300_000 })],
    ]) {
      const { res } = await get({ archives });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        state: "not_comparable",
        reason: "wacz_missing",
        sameBy: null,
        hunks: [],
      });
    }
  });

  it("検めていない取り込みは「まだ検めていない」で、保管庫を読まない", async () => {
    for (const archives of [
      [{ id: AFTER, crawl: CRAWL, inspected: false }, before()],
      [after(), { id: BEFORE, crawl: CRAWL, inspected: false }],
    ]) {
      const { res, ranges } = await get({ archives });
      expect(res.json()).toMatchObject({ state: "not_comparable", reason: "not_inspected" });
      expect(ranges).toEqual([]);
    }
  });

  it("伏せた行は「伏せた」、比べる行か文字の無い取り込みは「文字が無い」。今を先に見る", async () => {
    const withheld: ArchiveSeed = {
      id: AFTER,
      crawl: CRAWL,
      pages: [{ stage: null, textSha256: null, textWithheld: "no-archive" }],
    };
    const noText: ArchiveSeed = { id: AFTER, crawl: CRAWL, pages: [{ stage: "after-load" }] };
    const first = await get({ archives: [withheld, before()] });
    expect(first.res.json()).toMatchObject({
      state: "not_comparable",
      reason: "withheld",
      after: { stage: null },
    });
    const second = await get({ archives: [noText, before()] });
    expect(second.res.json()).toMatchObject({ state: "not_comparable", reason: "no_text" });
    // 今が伏せた行、前がまだ検めていない → 今の訳を言う
    const both = await get({
      archives: [withheld, { id: BEFORE, crawl: CRAWL, inspected: false }],
    });
    expect(both.res.json()).toMatchObject({ reason: "withheld" });
    expect([...first.ranges, ...second.ranges, ...both.ranges]).toEqual([]);
  });

  it("行数の掛け算が上限を超えれば「大きすぎる」。ちょうど上限なら比べる", async () => {
    expect(MAX_LINE_PRODUCT).toBe(4_000_000);
    const lines = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag} ${String(i)}`).join("\n");
    const over = await get({ archives: [after(lines(2001, "今")), before(lines(2000, "前"))] });
    expect(over.res.json()).toMatchObject({
      state: "not_comparable",
      reason: "too_large",
      hunks: [],
    });
    const exact = await get({ archives: [after(lines(2000, "今")), before(lines(2000, "前"))] });
    expect(exact.res.json()).toMatchObject({ state: "diffed", added: 2000, removed: 2000 });
  });

  it("解いた後の pages.jsonl が上限より大きい WACZ は「大きすぎる」", async () => {
    const huge = "a".repeat(ENTRY_MAX_BYTES);
    const { res } = await get({ archives: [after(huge), before()] });
    expect(res.json()).toMatchObject({ state: "not_comparable", reason: "too_large" });
  });

  it("保管庫が答えなければ 502（storage unreachable）", async () => {
    for (const storeDown of [[AFTER], [BEFORE]]) {
      const { res } = await get({ archives: [after(), before()], storeDown });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: "storage unreachable" });
    }
  });

  it("撮り方が違えば recipeDiffers が真、どちらかが分からなければ null", async () => {
    const other = { ...CRAWL, recipeSha256: "b".repeat(64) };
    const differs = await get({ archives: [after(), before(OLD, { crawl: other })] });
    expect(differs.res.json<Answer>().recipeDiffers).toBe(true);
    const unknown = await get({ archives: [after(), before(OLD, { crawl: null })] });
    expect(unknown.res.json<Answer>().recipeDiffers).toBeNull();
    const noDigest = await get({
      archives: [after(NEW, { crawl: { ...CRAWL, recipeSha256: null } }), before()],
    });
    expect(noDigest.res.json<Answer>().recipeDiffers).toBeNull();
  });

  it("比べた行の種類が違えば stageDiffers が真で、それぞれの行の文字を比べる", async () => {
    // 前は文書の行だけの取り込み (写しは after-load だけ)
    const docOnly = archiveOf(BEFORE, { doc: OLD }, { capturedAt: PREV_AT });
    const { res } = await get({ archives: [after(), docOnly] });
    const expected = changeOf(OLD, NEW);
    expect(res.json()).toMatchObject({
      state: "diffed",
      stageDiffers: true,
      added: expected.added,
      removed: expected.removed,
      hunks: expected.hunks,
      before: { stage: null },
      after: { stage: "after-behaviors" },
    });
  });

  it("知らない引数・since が無い・UUID でない id は 400 で、OpenFGA にも訊かない", async () => {
    for (const url of [
      `${changesUrl()}&context=5`,
      `/api/archives/${AFTER}/changes`,
      `/api/archives/${AFTER}/changes?since=yesterday`,
      `/api/archives/nope/changes?since=${BEFORE}`,
    ]) {
      const { res, asked } = await get({ archives: [after(), before()] }, url);
      expect(res.statusCode).toBe(400);
      expect(asked).toEqual([]);
    }
  });

  describe("在る要約", () => {
    const summary = {
      model: "claude-opus-5-5",
      promptVersion: PAIR_PROMPT_VERSION,
      usd: "0.012300",
      output: {
        headline: "価格が変わった",
        pages: [
          {
            url: "https://other.test/",
            significance: "none",
            headline: "別のページ",
            quotes: ["別の引用"],
            quotesUnverified: [],
          },
          {
            url: URL_A,
            significance: "content",
            headline: "価格が 100 円から 120 円になった",
            quotes: ["価格 120 円", "差分に無い文"],
            quotesUnverified: ["差分に無い文"],
          },
        ],
      },
    };

    it("同じ入力・同じ版の要約が在れば一緒に返し、引用は差分の変わった行に照らした印を持つ", async () => {
      const { res, queries, claudeAsked } = await get({ archives: [after(), before()], summary });
      expect(res.json()).toMatchObject({
        state: "diffed",
        summary: {
          evidence: false,
          model: "claude-opus-5-5",
          promptVersion: "change-pair-v1",
          usd: 0.0123,
        },
        // 要約の pages のうち、URL が同じ物から取る
        significance: "content",
        headline: "価格が 100 円から 120 円になった",
        quotes: [
          { text: "価格 120 円", verified: true },
          { text: "差分に無い文", verified: false },
        ],
      });
      const find = queries.find((q) => q.sql.includes('from "derivations"'));
      expect(find?.sql).toBe(
        'select "model", "prompt_version", "usd", "output" from "derivations" ' +
          'where "kind" = $1 and "input_sha256" = $2 and "prompt_version" = $3',
      );
      expect(find?.parameters).toEqual([
        "change",
        // 差分・撮り方の違い・手の比較の決まりの文
        changeInputSha256([{ url: URL_A, hunks: changeOf(OLD, NEW).hunks }], PAIR_PROMPT, {
          recipeDiffers: false,
          stageDiffers: false,
        }),
        "change-pair-v1",
      ]);
      // 読むだけ。Claude は呼ばない
      expect(claudeAsked()).toBe(0);
    });

    it("要約が無ければ summary は null", async () => {
      const { res } = await get({ archives: [after(), before()] });
      expect(res.json()).toMatchObject({
        summary: null,
        significance: null,
        headline: null,
        quotes: [],
      });
    });

    it("差分の無い 2 本（同じ・比べられない）では、要約を探さない", async () => {
      for (const archives of [
        [after(OLD), before(OLD)],
        [after(), { id: BEFORE, crawl: CRAWL, inspected: false }],
      ]) {
        const { res, queries } = await get({ archives, summary });
        expect(res.json()).toMatchObject({ summary: null, quotes: [] });
        expect(queries.filter((q) => q.sql.includes('from "derivations"'))).toEqual([]);
      }
    });

    it("鍵の無い配備でも、差分と在る要約は読める", async () => {
      const { res } = await get({ archives: [after(), before()], summary, claude: false });
      expect(res.json()).toMatchObject({ state: "diffed", summary: { evidence: false } });
    });
  });
});

describe("作り物の WACZ", () => {
  it("末尾の控えより大きい（小さいと、丸ごと読む実装と区別できない）", () => {
    expect(pagesWacz({ doc: "x" }).length).toBeGreaterThan(TAIL_BYTES);
  });
});
