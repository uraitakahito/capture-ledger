/**
 * 前回からの変化を読むエンドポイント (`api/changes.ts`) の SQL。認可 (`maySubmit`・`can_view`) はエンドポイントの側。
 */
import { sql, type Kysely } from "kysely";

import type { ChangeSignificance, CrawlChangeState, Database } from "../db/database.js";
import type { DiffLine } from "./change-of.js";
import { comparedPagesOf, pairsOf, type ComparedRow } from "./pairs.js";

/** 一覧 1 ページの回の数。 */
export const CHANGES_PAGE_SIZE = 50;

export interface ChangeRunRow {
  crawlId: string;
  scheduleId: string;
  scheduleName: string | null;
  startedAt: Date;
  scheduledFor: Date | null;
  prevCrawlId: string | null;
  /** 前の回の始まった時刻と本来の時刻 (CAPTURE-236)。前の回が無ければ null。 */
  prevStartedAt: Date | null;
  prevScheduledFor: Date | null;
  state: CrawlChangeState;
  pagesCompared: number;
  pagesChanged: number;
  significance: ChangeSignificance | null;
  headline: string | null;
  error: string | null;
  /** 今回と前の回の WACZ の id (見てよいかを訊くため)。 */
  archiveIds: string[];
}

export interface ArchiveRef {
  archiveId: string;
  objectKey: string;
  sourceUrl: string;
  capturedAt: Date;
  browserhiveVersion: string | null;
}

export interface PageChangeRow {
  url: string;
  stage: string | null;
  state: "diffed" | "prev_missing";
  added: number;
  removed: number;
  hunks: DiffLine[][];
  after: ArchiveRef | null;
  before: ArchiveRef | null;
}

/**
 * 比べた組のうち、差分の無いページ (CAPTURE-236)。文字の digest が同じ組と、digest は違うが空行と字下げだけが
 * 違った組 (周回は `page_changes` に残さない)。
 */
export interface UnchangedPageRow {
  url: string;
  stage: string | null;
  after: ArchiveRef;
  before: ArchiveRef;
}

export interface ChangeRunDetail {
  run: ChangeRunRow;
  summary: {
    model: string;
    promptVersion: string;
    usd: string;
    output: Record<string, unknown>;
  } | null;
  pages: PageChangeRow[];
  /** 並びは URL の順。前の回が無ければ空。 */
  unchanged: UnchangedPageRow[];
}

export interface ChangeReads {
  listRuns(before: Date | undefined): Promise<ChangeRunRow[]>;
  runDetail(crawlId: string): Promise<ChangeRunDetail | undefined>;
}

const runQuery = (db: Kysely<Database>) =>
  db
    .selectFrom("crawlChanges as cc")
    .innerJoin("crawls as c", "c.id", "cc.crawlId")
    .leftJoin("crawlSchedules as s", "s.id", "cc.scheduleId")
    .leftJoin("crawls as p", "p.id", "cc.prevCrawlId")
    .select([
      "cc.crawlId",
      "cc.scheduleId",
      "s.name as scheduleName",
      "c.startedAt",
      "c.scheduledFor",
      "cc.prevCrawlId",
      "p.startedAt as prevStartedAt",
      "p.scheduledFor as prevScheduledFor",
      "cc.state",
      "cc.pagesCompared",
      "cc.pagesChanged",
      "cc.significance",
      "cc.headline",
      "cc.error",
      sql<
        string[]
      >`array(select a.id from archives a where a.crawl_id in (cc.crawl_id, cc.prev_crawl_id))`.as(
        "archiveIds",
      ),
    ])
    // 比べている途中の回はまだ何も言えない
    .where("cc.state", "<>", "comparing");

export const changeReadsOf = (db: Kysely<Database>): ChangeReads => ({
  async listRuns(before) {
    let query = runQuery(db).orderBy("c.startedAt", "desc").limit(CHANGES_PAGE_SIZE);
    if (before !== undefined) query = query.where("c.startedAt", "<", before);
    return query.execute();
  },

  async runDetail(crawlId) {
    const run = await runQuery(db).where("cc.crawlId", "=", crawlId).executeTakeFirst();
    if (run === undefined) return undefined;
    const prevCrawlId = run.prevCrawlId;
    const [summary, rows, pairs] = await Promise.all([
      db
        .selectFrom("crawlChanges as cc")
        .innerJoin("derivations as d", "d.id", "cc.derivationId")
        .select(["d.model", "d.promptVersion", "d.usd", "d.output"])
        .where("cc.crawlId", "=", crawlId)
        .executeTakeFirst(),
      db
        .selectFrom("pageChanges as pc")
        .leftJoin("archives as a", "a.id", "pc.archiveId")
        .leftJoin("archives as b", "b.id", "pc.prevArchiveId")
        .select([
          "pc.url",
          "pc.stage",
          "pc.state",
          "pc.added",
          "pc.removed",
          "pc.hunks",
          "a.id as afterId",
          "a.objectKey as afterKey",
          "a.sourceUrl as afterUrl",
          "a.capturedAt as afterAt",
          "a.browserhiveVersion as afterVersion",
          "b.id as beforeId",
          "b.objectKey as beforeKey",
          "b.sourceUrl as beforeUrl",
          "b.capturedAt as beforeAt",
          "b.browserhiveVersion as beforeVersion",
        ])
        .where("pc.crawlId", "=", crawlId)
        .orderBy("pc.url")
        .execute(),
      // 前の回が無ければページを読まない
      prevCrawlId === null
        ? []
        : Promise.all([comparedPagesOf(db, crawlId), comparedPagesOf(db, prevCrawlId)]).then(
            ([current, previous]) => pairsOf(current, previous),
          ),
    ]);
    const ref = (
      id: string | null,
      objectKey: string | null,
      sourceUrl: string | null,
      capturedAt: Date | null,
      version: string | null,
    ): ArchiveRef | null =>
      id === null || objectKey === null || sourceUrl === null || capturedAt === null
        ? null
        : { archiveId: id, objectKey, sourceUrl, capturedAt, browserhiveVersion: version };
    const archive = (page: ComparedRow): ArchiveRef => ({
      archiveId: page.archiveId,
      objectKey: page.objectKey,
      sourceUrl: page.url,
      capturedAt: page.capturedAt,
      browserhiveVersion: page.browserhiveVersion,
    });
    const changed = new Set(rows.map((r) => r.url));
    return {
      run,
      summary: summary ?? null,
      pages: rows.map((r) => ({
        url: r.url,
        stage: r.stage,
        state: r.state,
        added: r.added,
        removed: r.removed,
        hunks: r.hunks as DiffLine[][],
        after: ref(r.afterId, r.afterKey, r.afterUrl, r.afterAt, r.afterVersion),
        before: ref(r.beforeId, r.beforeKey, r.beforeUrl, r.beforeAt, r.beforeVersion),
      })),
      unchanged: pairs
        .filter((pair) => !changed.has(pair.after.url))
        .sort((a, b) => (a.after.url < b.after.url ? -1 : a.after.url > b.after.url ? 1 : 0))
        .map((pair) => ({
          url: pair.after.url,
          stage: pair.after.stage,
          after: archive(pair.after),
          before: archive(pair.before),
        })),
    };
  },
});
