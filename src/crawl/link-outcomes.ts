/**
 * 撮ったページにあったリンク 1 本ずつが「どうなったか」を決め、`crawl_links` (`039`) の行にする。
 *
 * 純粋な関数にしてあるのは、**段の報告と埋め直しが同じ答えを出すため**。どちらも、規則を当てた結果
 * (`rules.ts` の `pageLinks`) と、`crawl_pages` の行 (URL → 見つけたページ) だけを渡す。次の段に何を入れたかは
 * 渡さない —— 入れた結果は行に在り、行から読めば、報告をやり直しても、後から埋め直しても、同じになる。
 */
import type { CrawlLinkOutcome } from "../db/database.js";
import type { PageLink } from "./rules.js";

/** 1 ページに残すリンクの上限。超えた分は書かない (呼ぶ側が数をログに残す)。 */
export const LINKS_PER_PAGE = 2000;

/** 規則は通したのに行が無いリンクの、入らなかった理由。 */
export type Cut = "max_depth" | "max_pages" | "closed";

/**
 * 入らなかった理由。**締まっていたら、それが先。** 次に深さ、最後に枚数 —— `budget.ts` の `planNextLevel` が
 * 深さを枚数より先に見るのと同じ順 (深さで止まった段に「枚数で切った」と書くと、上限を上げれば続きが取れると
 * 読み手に思わせる)。
 */
export const cutOf = (at: { nextDepth: number; maxDepth: number; closed: boolean }): Cut =>
  at.closed ? "closed" : at.nextDepth > at.maxDepth ? "max_depth" : "max_pages";

/**
 * リンク 1 本がどうなったか。
 *
 * `rowFrom` は、行き先の URL の `crawl_pages` の行の `discovered_from` (行が無ければ `undefined`、起点の行なら
 * `null`)。**行が在って、見つけたのがこのページなら `followed`** (木の辺)。行が在って別のページ (か起点) なら
 * `known` —— 撮り済みへのリンク・起点へ戻るリンク・同じ段で先に別のページが見つけたリンク・自分自身への
 * リンクが入る。
 */
export const outcomeOf = (
  link: PageLink,
  from: string,
  rowFrom: string | null | undefined,
  cut: Cut,
): CrawlLinkOutcome => {
  if (link.nofollow) return "nofollow";
  if (link.action === "skip") return "skip";
  if (rowFrom === undefined) return cut;
  return rowFrom === from ? "followed" : "known";
};

export interface LinkRow {
  crawlId: string;
  fromPage: string;
  seq: number;
  url: string;
  hostname: string;
  text: string;
  rule: number | null;
  outcome: CrawlLinkOutcome;
}

/**
 * 1 ページのリンクを、URL ごとに 1 本にする。あった順のまま、最初の 1 本を残す。**同じ URL に `nofollow` の
 * 付いた物と付かない物があれば、付かない方を残す** —— 規則を当てて次の段に入るのは付かない方で、`nofollow` と
 * 書くと「外した」と読める。位置は最初の 1 本のまま。
 */
export const distinctLinks = (links: readonly PageLink[]): PageLink[] => {
  const at = new Map<string, number>();
  const kept: PageLink[] = [];
  for (const link of links) {
    const i = at.get(link.url);
    if (i === undefined) {
      at.set(link.url, kept.length);
      kept.push(link);
    } else if (kept[i]?.nofollow === true && !link.nofollow) {
      kept[i] = link;
    }
  }
  return kept;
};

/**
 * 1 段ぶんの行。`pages` は段のページ (行の id と、読んだリンク)、`rows` はクロールの `crawl_pages` の
 * URL → `discovered_from`。行の id が引けなかったページ (`from` が null) は書けないので飛ばす。
 * `dropped` は上限 (`LINKS_PER_PAGE`) で書かなかった本数。
 */
export const linkRows = (
  crawlId: string,
  pages: readonly { from: string | null; links: readonly PageLink[] }[],
  rows: ReadonlyMap<string, string | null>,
  cut: Cut,
): { rows: LinkRow[]; dropped: number } => {
  const out: LinkRow[] = [];
  let dropped = 0;
  for (const page of pages) {
    if (page.from === null) continue;
    const from = page.from;
    const links = distinctLinks(page.links);
    dropped += Math.max(0, links.length - LINKS_PER_PAGE);
    links.slice(0, LINKS_PER_PAGE).forEach((link, seq) => {
      out.push({
        crawlId,
        fromPage: from,
        seq,
        url: link.url,
        hostname: link.hostname,
        text: link.text,
        rule: link.nofollow ? null : link.rule,
        outcome: outcomeOf(link, from, rows.get(link.url), cut),
      });
    });
  }
  return { rows: out, dropped };
};
