/**
 * 前回からの変化 (CAPTURE-167) の、ページの組の作り方。周回 (`changes/worker.ts`) が比べる組と、詳細の答え
 * (`changes/reads.ts`) の「同じだったページ」(`unchanged`・CAPTURE-236) は、どちらもここで作る。決まりを 1 か所に
 * 置くのは、答えの数 (`pages` と `unchanged`) が周回の数えた `pages_compared` と食い違わないため。
 *
 * 比べる行の選び方 (`comparedLineOf`・`comparedTextOf`) は、同じ URL の取り込みの一覧と好きな 2 本の差分
 * (CAPTURE-462。`changes/history.ts`・`changes/compare.ts`) も使う。
 */
import type { Kysely } from "kysely";

import type { Database } from "../db/database.js";
import type { PageLine } from "../search/document.js";

/** 回の中のページ 1 つ (比べる行)。 */
export interface ComparedPage {
  archiveId: string;
  bucket: string;
  objectKey: string;
  url: string;
  stage: string | null;
  textSha256: string | null;
  textWithheld: string | null;
}

/** 詳細の答えが WACZ を名指すのに要る欄も持つ行。 */
export interface ComparedRow extends ComparedPage {
  capturedAt: Date;
  browserhiveVersion: string | null;
}

/** 比べる行の選び方。after-behaviors の写し、無ければ文書の行 (stage の無い行)。after-load だけの回は文書の行。 */
export const comparedLineOf = <T extends { stage: string | null }>(
  rows: readonly T[],
): T | undefined =>
  rows.find((row) => row.stage === "after-behaviors") ?? rows.find((row) => row.stage === null);

/**
 * WACZ の `pages/pages.jsonl` の行から、比べる行の文字を取る。`stage` は `comparedLineOf` が DB の行から選んだ物
 * (`null` は文書の行)。周回 (`changes/worker.ts`) と、好きな 2 本の差分 (`changes/compare.ts`) の両方が使う ——
 * DB の行の選び方と、WACZ の行の選び方が食い違わないように 1 か所に置く。行が無ければ空の文字。
 */
export const comparedTextOf = (lines: readonly PageLine[], stage: string | null): string => {
  const line =
    stage === null
      ? lines.find((l) => typeof l.stage !== "string" || l.stage === "")
      : lines.find((l) => l.stage === stage);
  return line?.text ?? "";
};

/** 回のページ。URL ごとに 1 つ、比べる行。検め終えた WACZ だけ。 */
export const comparedPagesOf = async (
  db: Kysely<Database>,
  crawlId: string,
): Promise<ComparedRow[]> => {
  const rows = await db
    .selectFrom("archives")
    .innerJoin("archivePages", "archivePages.archiveId", "archives.id")
    .select([
      "archives.id as archiveId",
      "archives.bucket",
      "archives.objectKey",
      "archives.sourceUrl as url",
      "archives.capturedAt",
      "archives.browserhiveVersion",
      "archivePages.stage",
      "archivePages.textSha256",
      "archivePages.textWithheld",
    ])
    .where("archives.crawlId", "=", crawlId)
    .where("archives.inspectedAt", "is not", null)
    .orderBy("archives.capturedAt")
    .orderBy("archivePages.ordinal")
    .execute();
  const byArchive = new Map<string, ComparedRow[]>();
  for (const row of rows)
    byArchive.set(row.archiveId, [...(byArchive.get(row.archiveId) ?? []), row]);
  const byUrl = new Map<string, ComparedRow>();
  for (const pages of byArchive.values()) {
    const line = comparedLineOf(pages);
    // 回の中で同じ URL は 1 度しか撮らない (`crawl_pages` の重複排除)。在れば先の物
    if (line !== undefined && !byUrl.has(line.url)) byUrl.set(line.url, line);
  }
  return [...byUrl.values()];
};

export interface PagePair<P extends ComparedPage> {
  after: P;
  before: P;
}

/**
 * 比べる組。両方の回に在る URL で、どちらも文字の digest が在り、どちらも伏せていない物。並びは今回の回の順。
 * 組の数が `pages_compared`。digest が同じ組は周回が差分を作らない。
 */
export const pairsOf = <P extends ComparedPage>(
  current: readonly P[],
  previous: readonly P[],
): PagePair<P>[] => {
  const before = new Map(previous.map((page) => [page.url, page]));
  const pairs: PagePair<P>[] = [];
  for (const page of current) {
    const prev = before.get(page.url);
    // 伏せた・文字の無いページは比べない
    if (prev === undefined || page.textSha256 === null || prev.textSha256 === null) continue;
    if (page.textWithheld !== null || prev.textWithheld !== null) continue;
    pairs.push({ after: page, before: prev });
  }
  return pairs;
};
