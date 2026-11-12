/**
 * `crawl_links` (`039`) を読む。クロール 1 本のリンクの構成 (図 1 枚ぶん) と、1 ページの出入りのリンク。
 *
 * 数は **URL ごと** に数える。同じ URL を 3 ページが指していても 1 つで、その URL の「どうなったか」は、行き先の
 * `crawl_pages` の行が在ればその行の結末、無ければ最初に見つけたリンクの `outcome` (浅い段 → ページの id → ページの
 * 中の順。`nofollow` と規則を当てた物の両方が在れば、規則を当てた物が先)。こう数えると、内訳の合計が
 * 「見つけた別々の URL」と合う。辺の数で数えると、同じ URL を何度も数えて合わない。
 */
import { sql, type Kysely } from "kysely";

import type { CrawlLinkOutcome, CrawlPageState, Database } from "../db/database.js";

/** 規則が通した物 (行が在るか、上限か締めで入らなかった)。落とした物と nofollow は入らない。 */
const ACCEPTED = sql`('followed', 'known', 'max_pages', 'max_depth', 'closed')`;

/**
 * 規則が通した別々の URL の数。**起点は数えない** (起点へ戻るリンクは「見つけた」ではない)。リンクの記録が無い
 * クロール (`links_recorded_at` が NULL) は `null`。一覧の「リンク」(`crawls.pages_discovered`) に書く数。
 */
export const distinctDiscovered = async (
  db: Kysely<Database>,
  crawlId: string,
): Promise<number | null> => {
  const got = await sql<{ n: number | null }>`
    select case when c.links_recorded_at is null then null else (
             select count(distinct l.url_hash)::int
               from crawl_links l
              where l.crawl_id = c.id
                and l.outcome in ${ACCEPTED}
                and not exists (
                  select 1 from crawl_pages p
                   where p.crawl_id = l.crawl_id and p.url_hash = l.url_hash and p.discovered_from is null)
           ) end as n
      from crawls c
     where c.id = ${crawlId}`.execute(db);
  return got.rows[0]?.n ?? null;
};

type OutCounts = Record<
  "followed" | "known" | "maxPages" | "maxDepth" | "closed" | "skip" | "nofollow",
  number
>;
const KEY: Record<CrawlLinkOutcome, keyof OutCounts> = {
  followed: "followed",
  known: "known",
  max_pages: "maxPages",
  max_depth: "maxDepth",
  closed: "closed",
  skip: "skip",
  nofollow: "nofollow",
};
const noLinks = (): OutCounts => ({
  followed: 0,
  known: 0,
  maxPages: 0,
  maxDepth: 0,
  closed: 0,
  skip: 0,
  nofollow: 0,
});

/** 木に無い辺 (もう行があるページへのリンク) を、図 1 枚ぶんの答えに載せる上限。 */
export const CROSS_MAX = 2000;

export interface LinkGraph {
  crawlId: string;
  /** リンクの記録が在るか。無ければ `pages` の親 (木) までで、数は null。 */
  recorded: boolean;
  /**
   * 見つけた別々の URL (起点を除く) が、どうなったか。`captured`・`failed`・`skipped`・`pending` は行の在る URL の
   * 結末 (`crawl_pages.state`)、ほかは行の無い URL の入らなかった理由。`hosts` は規則で落とした URL のホスト名の数。
   */
  summary:
    | (Record<CrawlPageState, number> & {
        maxPages: number;
        maxDepth: number;
        closed: number;
        skip: number;
        nofollow: number;
        hosts: number;
      })
    | null;
  pages: {
    id: string;
    /** 見つけたページ (`discovered_from`)。起点は null。 */
    parent: string | null;
    depth: number;
    url: string;
    title: string | null;
    state: CrawlPageState;
    reason: string | null;
    /** このページから出るリンクの数 (URL ごと・どうなったかごと)。記録が無ければ null。 */
    out: OutCounts | null;
    /** このページへ入るリンクの数 (ほかのページから)。記録が無ければ null。 */
    in: number | null;
  }[];
  /** 行の無い URL を、最初に見つけたページと入らなかった理由で束ねた数。 */
  bundles: { from: string; outcome: "max_pages" | "max_depth" | "closed"; urls: number }[];
  /** 規則で落とした URL の、ホスト名ごとの数。多い順。 */
  hosts: { hostname: string; urls: number }[];
  /** 木に無い辺 (もう行があるページへ。自分自身へのリンクは除く)。`[リンクのあったページ, 行き先のページ]`。 */
  cross: [string, string][];
  /** `cross` を上限 (`CROSS_MAX`) で切った。 */
  crossTruncated: boolean;
}

/** クロール 1 本のリンクの構成。クロールが無ければ `undefined`。 */
export const readLinkGraph = async (
  db: Kysely<Database>,
  crawlId: string,
): Promise<LinkGraph | undefined> => {
  const crawl = await db
    .selectFrom("crawls")
    .select(["id", "linksRecordedAt"])
    .where("id", "=", crawlId)
    .executeTakeFirst();
  if (crawl === undefined) return undefined;
  const recorded = crawl.linksRecordedAt !== null;

  // ページと題。題は、そのページの WACZ の最初の行 (文書の行) から
  const pages = await sql<{
    id: string;
    parent: string | null;
    depth: number;
    url: string;
    title: string | null;
    state: CrawlPageState;
    reason: string | null;
  }>`
    select p.id, p.discovered_from as parent, p.depth, p.url, p.state, p.skip_reason as reason,
           (select ap.title from archives a
              join archive_pages ap on ap.archive_id = a.id and ap.ordinal = 0
             where a.task_id::text = p.task_id
             order by a.created_at limit 1) as title
      from crawl_pages p
     where p.crawl_id = ${crawlId}
     order by p.id`.execute(db);

  if (!recorded) {
    return {
      crawlId,
      recorded,
      summary: null,
      pages: pages.rows.map((page) => ({ ...page, out: null, in: null })),
      bundles: [],
      hosts: [],
      cross: [],
      crossTruncated: false,
    };
  }

  const outRows = await sql<{ fromPage: string; outcome: CrawlLinkOutcome; n: number }>`
    select from_page, outcome, count(*)::int as n
      from crawl_links where crawl_id = ${crawlId}
     group by from_page, outcome`.execute(db);
  const out = new Map<string, OutCounts>();
  for (const row of outRows.rows) {
    const counts = out.get(row.fromPage) ?? noLinks();
    counts[KEY[row.outcome]] = row.n;
    out.set(row.fromPage, counts);
  }

  const inRows = await sql<{ id: string; n: number }>`
    select p.id, count(*)::int as n
      from crawl_links l
      join crawl_pages p on p.crawl_id = l.crawl_id and p.url_hash = l.url_hash
     where l.crawl_id = ${crawlId} and l.from_page <> p.id
     group by p.id`.execute(db);
  const into = new Map(inRows.rows.map((row) => [row.id, row.n]));

  // 行の無い URL を、URL ごとに最初の 1 本にしてから数える
  const rowless = await sql<{
    fromPage: string;
    outcome: CrawlLinkOutcome;
    hostname: string;
    n: number;
  }>`
    with first as (
      select distinct on (l.url_hash) l.from_page, l.outcome, l.hostname
        from crawl_links l
        join crawl_pages fp on fp.id = l.from_page
       where l.crawl_id = ${crawlId}
         and not exists (
           select 1 from crawl_pages p where p.crawl_id = l.crawl_id and p.url_hash = l.url_hash)
       order by l.url_hash, (l.outcome = 'nofollow'), fp.depth, l.from_page, l.seq
    )
    select from_page, outcome, hostname, count(*)::int as n
      from first group by from_page, outcome, hostname`.execute(db);

  const summary = {
    pending: 0,
    captured: 0,
    failed: 0,
    skipped: 0,
    maxPages: 0,
    maxDepth: 0,
    closed: 0,
    skip: 0,
    nofollow: 0,
    hosts: 0,
  };
  for (const page of pages.rows) if (page.parent !== null) summary[page.state] += 1;
  const bundles = new Map<string, LinkGraph["bundles"][number]>();
  const hosts = new Map<string, number>();
  for (const row of rowless.rows) {
    if (row.outcome === "skip") {
      summary.skip += row.n;
      hosts.set(row.hostname, (hosts.get(row.hostname) ?? 0) + row.n);
    } else if (row.outcome === "nofollow") {
      summary.nofollow += row.n;
    } else if (
      row.outcome === "max_pages" ||
      row.outcome === "max_depth" ||
      row.outcome === "closed"
    ) {
      summary[KEY[row.outcome] as "maxPages" | "maxDepth" | "closed"] += row.n;
      const key = `${row.fromPage} ${row.outcome}`;
      const at = bundles.get(key) ?? { from: row.fromPage, outcome: row.outcome, urls: 0 };
      at.urls += row.n;
      bundles.set(key, at);
    }
  }
  summary.hosts = hosts.size;

  const crossRows = await sql<{ fromPage: string; to: string }>`
    select l.from_page, p.id as "to"
      from crawl_links l
      join crawl_pages p on p.crawl_id = l.crawl_id and p.url_hash = l.url_hash
     where l.crawl_id = ${crawlId} and l.outcome = 'known' and l.from_page <> p.id
     order by l.from_page, l.seq
     limit ${CROSS_MAX + 1}`.execute(db);

  return {
    crawlId,
    recorded,
    summary,
    pages: pages.rows.map((page) => ({
      ...page,
      out: out.get(page.id) ?? noLinks(),
      in: into.get(page.id) ?? 0,
    })),
    bundles: [...bundles.values()].sort(
      (a, b) => Number(a.from) - Number(b.from) || a.outcome.localeCompare(b.outcome),
    ),
    hosts: [...hosts.entries()]
      .map(([hostname, urls]) => ({ hostname, urls }))
      .sort((a, b) => b.urls - a.urls || a.hostname.localeCompare(b.hostname)),
    cross: crossRows.rows.slice(0, CROSS_MAX).map((row) => [row.fromPage, row.to]),
    crossTruncated: crossRows.rows.length > CROSS_MAX,
  };
};

export interface PageLinks {
  /** このページから出るリンク。あった順。`to` は行き先のページ (行が在れば)。 */
  out: {
    seq: number;
    url: string;
    text: string;
    rule: number | null;
    outcome: CrawlLinkOutcome;
    to: string | null;
  }[];
  /** このページへ入るリンク (ほかのページから)。リンクのあったページの順。 */
  in: { from: string; text: string }[];
}

/** 1 ページの出入りのリンク。そのクロールにページが無ければ `undefined`。 */
export const readPageLinksOf = async (
  db: Kysely<Database>,
  crawlId: string,
  pageId: string,
): Promise<PageLinks | undefined> => {
  const page = await db
    .selectFrom("crawlPages")
    .select("id")
    .where("crawlId", "=", crawlId)
    .where("id", "=", pageId)
    .executeTakeFirst();
  if (page === undefined) return undefined;
  const out = await sql<PageLinks["out"][number]>`
    select l.seq, l.url, l.text, l.rule, l.outcome, p.id as "to"
      from crawl_links l
      left join crawl_pages p on p.crawl_id = l.crawl_id and p.url_hash = l.url_hash
     where l.crawl_id = ${crawlId} and l.from_page = ${pageId}
     order by l.seq`.execute(db);
  const into = await sql<PageLinks["in"][number]>`
    select l.from_page as "from", l.text
      from crawl_links l
      join crawl_pages p on p.crawl_id = l.crawl_id and p.url_hash = l.url_hash
     where l.crawl_id = ${crawlId} and p.id = ${pageId} and l.from_page <> p.id
     order by l.from_page, l.seq`.execute(db);
  return { out: out.rows, in: into.rows };
};
