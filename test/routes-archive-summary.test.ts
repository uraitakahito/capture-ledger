/**
 * 好きな 2 本の差分を Claude に要約させる (`POST /api/archives/:id/changes/summary`。CAPTURE-462)。代役は
 * `history-app.ts`。派生の層の store は本物で、残す行は Kysely が組んだ INSERT で照らす。
 *
 * 頼む人 (alice) の組織は acme、クロールの組織は crawl-org。**費用はクロールの組織に数える**ので、2 つを別にしてある。
 */
import { describe, expect, it } from "vitest";

import { changeOf } from "../src/changes/change-of.js";
import { CHANGE_PROMPT_VERSION, changeInputSha256 } from "../src/changes/summarize.js";
import { ClaudeUnavailable } from "../src/claude/types.js";
import {
  archiveOf,
  call,
  CRAWL,
  URL_A,
  type ArchiveSeed,
  type BuildOptions,
  type StoredSummary,
} from "./history-app.js";

const AFTER = "a0000000-0000-4000-8000-0000000000aa";
const BEFORE = "b0000000-0000-4000-8000-0000000000bb";
const OLD = "お知らせ\n価格 100 円\nお問い合わせ";
const NEW = "お知らせ\n価格 120 円\nお問い合わせ";
const HUNKS = changeOf(OLD, NEW).hunks;
const INPUT_SHA256 = changeInputSha256([{ url: URL_A, hunks: HUNKS }]);

const after = (text = NEW, over: Partial<ArchiveSeed> = {}) =>
  archiveOf(AFTER, { behaviors: text }, over);
const before = (text = OLD, over: Partial<ArchiveSeed> = {}) =>
  archiveOf(BEFORE, { behaviors: text }, over);
const pair = () => [after(), before()];

const post = (opts: BuildOptions, body: unknown = { since: BEFORE }, id = AFTER) =>
  call(opts, { method: "POST", url: `/api/archives/${id}/changes/summary`, body });

/** Claude の答え。800 と 200 tokens の opus-5-5 は $0.0072。 */
const reply = (over: Record<string, unknown> = {}) => ({
  output: {
    headline: "価格が変わった",
    pages: [
      {
        url: URL_A,
        significance: "content",
        headline: "価格が 100 円から 120 円になった",
        quotes: ["価格 120 円", "差分に無い文"],
      },
    ],
  },
  content: [],
  model: "claude-opus-5-5",
  attempts: [{ model: "claude-opus-5-5", usage: { input_tokens: 800, output_tokens: 200 } }],
  stopReason: "end_turn",
  ...over,
});

const stored: StoredSummary = {
  model: "claude-opus-5-5",
  promptVersion: CHANGE_PROMPT_VERSION,
  usd: "0.012300",
  output: {
    headline: "前に払った要約",
    pages: [
      {
        url: URL_A,
        significance: "minor",
        headline: "前に払った 1 行",
        quotes: ["価格 120 円"],
        quotesUnverified: [],
      },
    ],
  },
};

/** INSERT の列の名前 → 値。 */
const rowOf = (insert: { sql: string; parameters: readonly unknown[] } | undefined) => {
  const columns = /\(([^)]*)\) values/.exec(insert?.sql ?? "")?.[1] ?? "";
  const names = columns.split(", ").map((name) => name.replaceAll('"', ""));
  return Object.fromEntries(names.map((name, i) => [name, insert?.parameters[i]]));
};

describe("好きな 2 本の差分を Claude に要約させる", () => {
  it("要約を返し、派生の層に 1 行残す（組織は「今」の取り込みのクロールの組織・頼んだ人・費用・model・版）", async () => {
    const { res, inserted, claudeAsked, queries } = await post({
      archives: pair(),
      claude: () => Promise.resolve(reply()),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      url: URL_A,
      state: "diffed",
      hunks: HUNKS,
      summary: {
        evidence: false,
        model: "claude-opus-5-5",
        promptVersion: "change-v1",
        usd: 0.0072,
      },
      significance: "content",
      headline: "価格が 100 円から 120 円になった",
      quotes: [
        { text: "価格 120 円", verified: true },
        { text: "差分に無い文", verified: false },
      ],
      reused: false,
    });
    expect(claudeAsked()).toBe(1);
    expect(inserted).toHaveLength(1);
    const row = rowOf(inserted[0]);
    expect(row).toMatchObject({
      kind: "change",
      // 頼んだ人の組織 (acme) ではない
      org_id: CRAWL.orgId,
      crawl_id: CRAWL.id,
      archive_id: AFTER,
      target: JSON.stringify({ archiveId: AFTER, prevArchiveId: BEFORE }),
      input_sha256: INPUT_SHA256,
      model: "claude-opus-5-5",
      prompt_version: "change-v1",
      effort: "low",
      rounds: 1,
      usd: "0.007200",
      created_by: "alice",
    });
    expect(JSON.parse(String(row["output"]))).toMatchObject({
      headline: "価格が変わった",
      pages: [{ url: URL_A, quotesUnverified: ["差分に無い文"] }],
    });
    // 月の使った額も、クロールの組織で数える
    const spent = queries.find((q) => q.sql.includes("coalesce(sum(usd), 0)"));
    expect(spent?.parameters).toEqual([CRAWL.orgId]);
  });

  it("同じ入力の要約が在れば、Claude を呼ばずに返す（reused が真・月の上限も見ない・残さない）", async () => {
    const { res, claudeAsked, inserted, queries } = await post({
      archives: pair(),
      summary: stored,
      // 上限に届いていても、在る要約は返す
      spent: "99",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: "diffed",
      summary: { evidence: false, model: "claude-opus-5-5", usd: 0.0123 },
      significance: "minor",
      headline: "前に払った 1 行",
      quotes: [{ text: "価格 120 円", verified: true }],
      reused: true,
    });
    expect(claudeAsked()).toBe(0);
    expect(inserted).toEqual([]);
    const find = queries.find((q) => q.sql.startsWith('select "model"'));
    expect(find?.parameters).toEqual(["change", INPUT_SHA256, "change-v1"]);
  });

  it("月の上限に届いていれば 429 で、Claude を呼ばず、残さない", async () => {
    const { res, claudeAsked, inserted } = await post({
      archives: pair(),
      spent: "5.000000",
      budgetUsd: 5,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "claude budget exhausted", spentUsd: 5, budgetUsd: 5 });
    expect(claudeAsked()).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("上限の手前なら呼ぶ", async () => {
    const { res, claudeAsked } = await post({
      archives: pair(),
      spent: "4.999999",
      budgetUsd: 5,
      claude: () => Promise.resolve(reply()),
    });
    expect(res.statusCode).toBe(200);
    expect(claudeAsked()).toBe(1);
  });

  it("差分の無い 2 本（同じ・比べられない）は 422（nothing to summarize）で、Claude を呼ばない", async () => {
    for (const archives of [
      [after(OLD), before(OLD)],
      [after("お知らせ\n\n  価格 100 円\nお問い合わせ"), before(OLD)],
      [after(), { id: BEFORE, crawl: CRAWL, inspected: false }],
    ]) {
      const { res, claudeAsked, queries } = await post({ archives });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: "nothing to summarize" });
      expect(claudeAsked()).toBe(0);
      expect(queries.filter((q) => q.sql.includes('"derivations"'))).toEqual([]);
    }
  });

  it("「今」の取り込みがクロールに繋がらなければ 422（no organization）で、Claude を呼ばない", async () => {
    const { res, claudeAsked, inserted } = await post({
      archives: [after(NEW, { crawl: null }), before()],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "no organization" });
    expect(claudeAsked()).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("「前」の取り込みがクロールに繋がらなくても、「今」のクロールの組織で要約する", async () => {
    const { res, inserted } = await post({
      archives: [after(), before(OLD, { crawl: null })],
      claude: () => Promise.resolve(reply()),
    });
    expect(res.statusCode).toBe(200);
    expect(rowOf(inserted[0])).toMatchObject({ org_id: CRAWL.orgId, crawl_id: CRAWL.id });
  });

  it("Claude が断れば 422（claude refused）で、払った試みは派生の層に残る", async () => {
    const { res, inserted } = await post({
      archives: pair(),
      claude: () => Promise.resolve(reply({ output: null, stopReason: "refusal" })),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "claude refused" });
    expect(inserted).toHaveLength(1);
    const row = rowOf(inserted[0]);
    expect(row).toMatchObject({
      kind: "change",
      org_id: CRAWL.orgId,
      crawl_id: CRAWL.id,
      archive_id: AFTER,
      output: JSON.stringify({ kind: "refused" }),
      usd: "0.007200",
      created_by: "alice",
    });
    // 成功の一意 (034) とぶつけない: 入力の digest に試みの印を付ける
    expect(String(row["input_sha256"])).toMatch(new RegExp(`^${INPUT_SHA256}#[0-9a-f-]{36}$`));
    expect(JSON.parse(String(row["target"]))).toMatchObject({
      archiveId: AFTER,
      prevArchiveId: BEFORE,
    });
  });

  it("答えが決めた形で読めなければ 502（claude failed）で、払った試みは残る", async () => {
    const { res, inserted } = await post({
      archives: pair(),
      claude: () => Promise.resolve(reply({ output: null })),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "claude failed" });
    expect(inserted).toHaveLength(1);
    expect(rowOf(inserted[0])).toMatchObject({
      output: JSON.stringify({ kind: "unreadable" }),
      usd: "0.007200",
    });
  });

  it("Claude が答えなければ 502（claude failed）。費用の分からない試みは残さない", async () => {
    const { res, inserted } = await post({
      archives: pair(),
      claude: () => Promise.reject(new ClaudeUnavailable("529 overloaded")),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "claude failed" });
    expect(inserted).toEqual([]);
  });

  it("費用が 0 の断りは残さない", async () => {
    const { res, inserted } = await post({
      archives: pair(),
      claude: () => Promise.resolve(reply({ output: null, stopReason: "refusal", attempts: [] })),
    });
    expect(res.statusCode).toBe(422);
    expect(inserted).toEqual([]);
  });

  it("同時の頼みが先に残していたら（034 の一意にぶつかる）、先の要約を返す", async () => {
    let asked = 0;
    const { res, inserted } = await post({
      archives: pair(),
      // 1 度目 (呼ぶ前) は無く、2 度目 (ぶつかった後) は在る
      summary: () => (asked++ === 0 ? undefined : stored),
      claude: () => Promise.resolve(reply()),
      insertError: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "derivations_change_input_idx",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(res.json()).toMatchObject({ reused: true, headline: "前に払った 1 行" });
  });

  it("見てよくない取り込みを含むと 404 で、DB も保管庫も Claude も触らない", async () => {
    for (const viewable of [[AFTER], [BEFORE]]) {
      const { res, queries, ranges, claudeAsked, asked, batchAsked } = await post({
        archives: pair(),
        viewable,
        claude: () => Promise.resolve(reply()),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
      expect(queries).toEqual([]);
      expect(ranges).toEqual([]);
      expect(claudeAsked()).toBe(0);
      // 差分のエンドポイントと同じく、1 本ずつ強い一貫性で訊く
      expect(asked.filter((a) => a.relation === "can_view")).toEqual([
        { relation: "can_view", object: `archive:${AFTER}`, consistency: "HIGHER_CONSISTENCY" },
        { relation: "can_view", object: `archive:${BEFORE}`, consistency: "HIGHER_CONSISTENCY" },
      ]);
      expect(batchAsked).toEqual([]);
    }
  });

  it("名乗らなければ 401、頼めなければ 404", async () => {
    expect((await post({ archives: pair(), signedIn: false })).res.statusCode).toBe(401);
    const denied = await post({ archives: pair(), submit: false });
    expect(denied.res.statusCode).toBe(404);
    expect(denied.queries).toEqual([]);
  });

  it("URL が違う 2 本は 422（different url）、保管庫が答えなければ 502。どちらも Claude を呼ばない", async () => {
    const other = await post({
      archives: [after(), before(OLD, { sourceUrl: "https://site.test/other" })],
    });
    expect(other.res.statusCode).toBe(422);
    expect(other.res.json()).toEqual({ error: "different url" });
    const down = await post({ archives: pair(), storeDown: [BEFORE] });
    expect(down.res.statusCode).toBe(502);
    expect(down.res.json()).toEqual({ error: "storage unreachable" });
    expect(other.claudeAsked() + down.claudeAsked()).toBe(0);
  });

  it("知らない鍵・since が無い・UUID でない since は 400 で、OpenFGA にも訊かない", async () => {
    for (const body of [{ since: BEFORE, model: "claude-fable-5-1" }, {}, { since: "yesterday" }]) {
      const { res, asked } = await post({ archives: pair() }, body);
      expect(res.statusCode).toBe(400);
      expect(asked).toEqual([]);
    }
  });

  it("Claude の鍵が無い配備では、この経路が無い（404）", async () => {
    const { res, asked } = await post({ archives: pair(), claude: false });
    expect(res.statusCode).toBe(404);
    // Fastify の 404。エンドポイントの「not found」ではない
    expect(res.json<{ message: string }>().message).toContain("Route POST");
    expect(asked).toEqual([]);
  });
});
