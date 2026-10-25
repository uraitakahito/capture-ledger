/**
 * 1 段で規則が決めたことを、`crawl_decisions` (`023`) の行にまとめる。
 *
 * 純粋な関数にしてあるのは、数え方が静かに壊れるところだから。延べで数えても、同じ URL を 2 度
 * 数えても、クロールは普通に終わる。この repo に DB の試験は無いので、DB を立てないと確かめられない
 * 形にすると、その誤りが試験の外に出る。
 */
import type { CrawlRuleAction } from "../db/database.js";
import type { DecidedLink } from "./rules.js";

/** 例の URL の上限。表の 1 行が大きくなりすぎないように。 */
export const SAMPLES = 10;

export interface DecisionRow {
  depth: number;
  rule: number;
  action: CrawlRuleAction;
  hostname: string;
  links: number;
  samples: string[];
}

/**
 * 規則 × ホスト名で 1 行。数えるのは**別々の URL** —— 同じ URL を 3 ページで見つけても 1。例は
 * 見つけた順に `SAMPLES` 本まで。
 *
 * 鍵は規則の番号とホスト名で足りる。同じ並びの同じ番号なら動きも同じ (どれにも当たらない 0 は落とす)。
 * `depth` はリンク先の深さ (見つけたページの深さ + 1)。
 */
export const aggregateDecisions = (
  decided: readonly DecidedLink[],
  depth: number,
): DecisionRow[] => {
  const rows = new Map<string, { row: DecisionRow; urls: Set<string> }>();
  for (const link of decided) {
    const key = `${String(link.rule)} ${link.hostname}`;
    let at = rows.get(key);
    if (at === undefined) {
      at = {
        row: {
          depth,
          rule: link.rule,
          action: link.action,
          hostname: link.hostname,
          links: 0,
          samples: [],
        },
        urls: new Set(),
      };
      rows.set(key, at);
    }
    if (at.urls.has(link.url)) continue;
    at.urls.add(link.url);
    at.row.links += 1;
    if (at.row.samples.length < SAMPLES) at.row.samples.push(link.url);
  }
  return [...rows.values()].map((at) => at.row);
};
