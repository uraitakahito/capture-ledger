/**
 * 段の行 (`crawl_levels`・CAPTURE-180) の問い合わせに答える係。`recording-db.ts` の `recordingDb` に渡す。
 *
 * 段の報告は、記録の前後に段の行を読み書きする (鍵の照らし・取る・終わりの commit の印・数・報告済み・次の段の行)。
 * 段の報告の試験は、行を問い合わせの順に並べて渡す形で書いてあるので、**段の行の問い合わせはここが答え、並べた行を
 * 使わない** —— 並べた行は、段の行が入る前と同じ意味のまま読める。
 *
 * 次の段の行は、並べた行の「次の段の行」(以前は `returning` の答え、いまは深さ n+1 の pending の行を読む答え) を使う。
 * クロールの合計は、並べたクロールの行の数 (前の段までの和) に、この段の行に書いた数を足して答える。
 *
 * リンクを 1 本ずつ残す問い合わせ (`crawl_links`・`039`) も、ここが答える。
 */
import type { CrawlLevelState } from "../src/db/database.js";
import type { Responder } from "./recording-db.js";

/** 試験の段の鍵。段の報告は `Idempotency-Key` にこれを付ける。 */
export const LEVEL_KEY = "6f0b7c1e-1b2a-4c3d-8e4f-000000000180";

export interface LevelOptions {
  /** 段の行の状態。省けば受け取り確認済み */
  state?: CrawlLevelState;
  /** 報告済みの段の答え */
  answer?: object | null;
  /** 取れない (別の試みが報告中) */
  busy?: boolean;
  /** 終わりの commit の前に印が替わっていた (期限切れで取り直された) */
  superseded?: boolean;
  /** 段の行が無い (段の行を入れる前に始めたクロール) */
  missing?: boolean;
  /** 一番新しい段の深さ (`/failed` の照らし)。省けば 0 */
  newestDepth?: number;
  /**
   * リンクを残すとき (`039`) に読む、クロールの `crawl_pages` の URL → 見つけたページ。省けば行が無い
   * (規則が通したリンクは、どれも上限で切ったと残る)
   */
  pageParents?: { url: string; discoveredFrom: string | null }[];
  /** 規則が通した別々の URL の数 (リンクの記録から数えた答え)。省けば null (記録の無いクロール) */
  distinctDiscovered?: number;
}

const has = (sql: string, ...parts: string[]): boolean => parts.every((part) => sql.includes(part));

export const levelResponder = (opts: LevelOptions = {}) => {
  const state = opts.state ?? "accepted";
  let crawl: {
    state?: string;
    stopReason?: string | null;
    pagesCaptured?: number;
    pagesDiscovered?: number;
  } = {};
  let levelCaptured = 0;
  let levelDiscovered = 0;
  const responder: Responder = {
    answer: (sql, parameters) => {
      // 始める要求の鍵 (`037`)
      if (has(sql, '"crawl_requests"')) return [];
      if (!has(sql, '"crawl_levels"') && !has(sql, "sum(pages_captured)")) {
        // 終わりの commit の、クロールの行を取る問い合わせ
        if (has(sql, 'select "state", "stop_reason" from "crawls"', "for update")) {
          return [{ state: crawl.state ?? "running", stopReason: crawl.stopReason ?? null }];
        }
        // 合計の書き直し (`writeTotals`)
        if (has(sql, 'update "crawls" set "pages_captured" = $1, "pages_discovered" = $2 where'))
          return [];
        // シークレットの更新時刻の書き直し。答える行を持たず、書くかどうかは替わったときだけ (並べた行の数が揺れない)
        if (has(sql, 'update "crawls" set "secrets"')) return [];
        // 次の段のページを入れる (段の報告は returning を使わない)
        if (has(sql, 'insert into "crawl_pages"') && !has(sql, "returning")) return [];
        // リンクを 1 本ずつ残す (`039`): 行を読み、置き換え、記録した時刻を立てる。並べた行は使わない
        if (has(sql, 'select "url", "discovered_from" from "crawl_pages"')) {
          return opts.pageParents ?? [];
        }
        if (has(sql, '"crawl_links"')) return [];
        if (has(sql, 'update "crawls" set "links_recorded_at"')) return [];
        // 規則が通した別々の URL の数 (`links-read.ts` の `distinctDiscovered`)。省けば、記録の無いクロール
        if (has(sql, "count(distinct l.url_hash)")) return [{ n: opts.distinctDiscovered ?? null }];
        return undefined;
      }
      if (has(sql, "sum(pages_captured)")) {
        return [
          {
            pagesCaptured: (crawl.pagesCaptured ?? 0) + levelCaptured,
            pagesDiscovered: (crawl.pagesDiscovered ?? 0) + levelDiscovered,
          },
        ];
      }
      if (has(sql, 'select "job_id", "state", "answer" from "crawl_levels"')) {
        return opts.missing === true
          ? []
          : [{ jobId: LEVEL_KEY, state, answer: opts.answer ?? null }];
      }
      if (has(sql, 'update "crawl_levels" set "state" = $1, "report_token" = $2')) {
        return opts.busy === true ? [] : [{ depth: 0 }];
      }
      if (has(sql, 'select "state", "answer" from "crawl_levels"')) {
        return [{ state: opts.busy === true ? "reporting" : state, answer: opts.answer ?? null }];
      }
      if (has(sql, 'from "crawl_levels"', "for update")) {
        return opts.superseded === true ? [] : [{ depth: 0 }];
      }
      if (has(sql, 'update "crawl_levels" set "pages_captured" = $1, "pages_discovered" = $2')) {
        levelCaptured = Number(parameters[0]);
        levelDiscovered = Number(parameters[1]);
        return [];
      }
      if (has(sql, 'select "depth", "job_id" from "crawl_levels"')) {
        return [{ depth: opts.newestDepth ?? 0, jobId: LEVEL_KEY }];
      }
      // ほか (取る・報告済み・次の段の行・投げる係の状態・締めた) は答える行を持たない
      return [];
    },
    seen: (sql, rows) => {
      // 最初に読んだクロールの行を覚える (終わりの commit の状態と、合計の前の段までの和)
      if (crawl.state === undefined && has(sql, 'from "crawls"') && rows[0] !== undefined) {
        crawl = rows[0];
      }
    },
  };
  return responder;
};
