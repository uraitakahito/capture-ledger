/**
 * 段を起こすたびに、その段に効く robots.txt の例外 (`046`) を引き、flow へ渡す形にする (t-6bc6)。
 *
 * **判じるのは capture-scheduler の `plan_level` の 1 か所。** ここが決めるのは「どの行が、このクロールのこの段に
 * 効きうるか」(組織・ホスト・期限と取り消し・範囲と深さ・資格・残りの枚数) までで、robots.txt が断っているか・
 * path が型に当たるかは見ない。呼ぶ所は 2 つ: 最初の段 (`crawl/launch.ts` の `insertCrawl`) と、次の段
 * (`api/crawls.ts` の段の報告)。
 *
 * ## 引いた物は段の行に残る
 *
 * 答えは `DispatchedCrawl.robotsExemptions` になり、段の行 (`crawl_levels.args`) に残る。**送り直しは、残した引数を
 * そのまま送る** (`levelDispatcher` の `tick`) ので、取り消しと期限切れは**次に起こす段から**効く —— もう起こした段の
 * 送り直し (10 分まで) では変わらない。どの段に、どの行を、残り何枚で渡したかも、段の行から後で引ける。
 *
 * ## 残りの枚数
 *
 * 行の上限は 2 つ: 24 時間で外す枚数 (`daily_limit`) と、1 クロールの辿ったリンクで外す枚数 (`link_limit`。深さ 1
 * から先だけ)。外した頁は `crawl_pages.robots_exemption_id` に残る (`047`) ので、そこから数えて引く。
 * 走るクロールは全体で 1 本 (`crawls_single_active`) で、段は前の段の報告の後に起こすので、数える時に
 * 「いま外している途中の頁」は無い。24 時間は、頁を触り終えた時刻 (`finished_at`) で測る。
 * **撮れなかった頁も数える** —— flow は、外して撮りに行き撮れなかった頁にも行の番号を付けて報告する (相手に要求は
 * 届いている)。上限は「相手に送った要求」の数に掛ける。
 *
 * ## 形が外れた行は、flow で黙って当たらない
 *
 * `plan_level` は行の形を検査し、通らない行を当てない (log に出すだけ)。`id` は数字だけの字 (bigserial を node-pg が
 * 字で返す)、`remaining` は数の型の 0 以上の整数 (数える式を `::int` にして、int8 の字で返らないようにしてある)、
 * `declaration` は 7 つとも字で、時刻は `toISOString()`。`test/exemptions-dispatch.test.ts` が型まで見る。
 *
 * 残りが 0 の行も渡す —— `plan_level` が、型に当たった頁を理由 `robots-exemption-limit` で見送る (上限で止まった
 * ことが頁に残る)。
 */
import { sql, type Kysely } from "kysely";

import type { Database, ExemptionEligibility, RobotsExemptionScope } from "../db/database.js";
import { DAY_MS, usedSince } from "./store.js";

/**
 * flow の引数 `robots_exemptions` の要素。capture-scheduler の plan_level の `RobotsExemption` と同じ形 ——
 * 欄を変える時は、向こうと揃える。
 */
export interface DispatchedRobotsExemption {
  /** 行の番号 (数字の字)。 */
  id: string;
  /** 行のホスト。`frontier` の要素の `host` と同じ語彙。 */
  host: string;
  pathPattern: string;
  scope: RobotsExemptionScope;
  /** このホストで名乗る名。 */
  userAgent: string;
  /** この段で、この行で外してよい残りの枚数 (0 以上の整数)。 */
  remaining: number;
  /**
   * WACZ に書く申告。flow が、外した頁の撮る要求にだけ付ける (BrowserHive の `POST /captures` の `robotsOverride`)。
   * 7 つとも文字列。時刻は UTC の ISO (`Z` で終わる) —— BrowserHive は `Z` 以外を 400 で断る。
   */
  declaration: {
    exemptionId: string;
    reason: string;
    pathPattern: string;
    scope: RobotsExemptionScope;
    /** 登録した人の名。名が無ければ主体の ID。 */
    grantedBy: string;
    grantedAt: string;
    expiresAt: string;
  };
}

export interface LevelOf {
  crawlId: string;
  /** クロールの組織 (`crawls.org_id`)。 */
  orgId: string;
  /** 始める時に決めた資格 (`crawls.exemption_eligibility`)。 */
  eligibility: ExemptionEligibility;
  /** 起こす段の深さ。 */
  depth: number;
  /** その段の frontier のホスト。 */
  hosts: readonly string[];
  /** API の時計。期限と 24 時間を、これで測る (登録の検査と同じ時計)。 */
  now: Date;
}

/** その段に効きうる行を、番号の順に。当たる行が無ければ空。`db` はトランザクションでもよい。 */
export const exemptionsForLevel = async (
  db: Kysely<Database>,
  { crawlId, orgId, eligibility, depth, hosts, now }: LevelOf,
): Promise<DispatchedRobotsExemption[]> => {
  // 資格の無いクロールは、DB も引かない。知らない字も同じ側に倒す (今までどおり robots.txt に従う)
  if (eligibility !== "human" && eligibility !== "machine") return [];
  const frontierHosts = [...new Set(hosts)];
  if (frontierHosts.length === 0) return [];

  const rows = await db
    .selectFrom("robotsExemptions")
    .select([
      "id",
      "host",
      "pathPattern",
      "scope",
      "userAgent",
      "reason",
      "dailyLimit",
      "linkLimit",
      "createdBy",
      "createdByName",
      "createdAt",
      "expiresAt",
    ])
    .select((eb) => [
      usedSince(eb, new Date(now.getTime() - DAY_MS)).as("usedLast24h"),
      // このクロールの、辿ったリンク (深さ 1 から先) で外した枚数。起点 (深さ 0) は数えない
      eb
        .selectFrom("crawlPages")
        .select(sql<number>`count(*)::int`.as("n"))
        .whereRef("crawlPages.robotsExemptionId", "=", "robotsExemptions.id")
        .where("crawlPages.crawlId", "=", crawlId)
        .where("crawlPages.depth", ">=", 1)
        .as("usedLinks"),
    ])
    .where("orgId", "=", orgId)
    .where("host", "in", frontierHosts)
    // 効いている行だけ (`exemptions/store.ts` の「効いている行」)
    .where("revokedAt", "is", null)
    .where("expiresAt", ">", now)
    // 範囲: 起点 (深さ 0) には seeds と links、辿ったリンクには links だけ
    .$if(depth >= 1, (qb) => qb.where("scope", "=", "links"))
    // 資格: human は全ての行、machine は applies_to = 'all' の行だけ
    .$if(eligibility === "machine", (qb) => qb.where("appliesTo", "=", "all"))
    .orderBy("id")
    .execute();

  return rows.map((row) => {
    const daily = row.dailyLimit - (row.usedLast24h ?? 0);
    const left = depth >= 1 ? Math.min(daily, row.linkLimit - (row.usedLinks ?? 0)) : daily;
    return {
      id: row.id,
      host: row.host,
      pathPattern: row.pathPattern,
      scope: row.scope,
      userAgent: row.userAgent,
      remaining: Math.max(0, left),
      declaration: {
        exemptionId: row.id,
        reason: row.reason,
        pathPattern: row.pathPattern,
        scope: row.scope,
        // 名は表示の物で、無いことがある (`config/identity.ts`)。申告の欄は 1 字以上なので、主体の ID を書く
        grantedBy:
          row.createdByName === null || row.createdByName === ""
            ? row.createdBy
            : row.createdByName,
        grantedAt: new Date(row.createdAt).toISOString(),
        expiresAt: new Date(row.expiresAt).toISOString(),
      },
    };
  });
};
