/**
 * 前回からの変化を読むエンドポイント (`api/changes.ts`) の SQL。認可 (`maySubmit`・`can_view`) はエンドポイントの側。
 */
import { sql, type Kysely } from "kysely";

import type { ChangeSignificance, CrawlChangeState, Database } from "../db/database.js";
import type { DiffLine } from "./change-of.js";

/** 一覧 1 ページの回の数。 */
export const CHANGES_PAGE_SIZE = 50;

export interface ChangeRunRow {
  crawlId: string;
  scheduleId: string;
  scheduleName: string | null;
  startedAt: Date;
  scheduledFor: Date | null;
  prevCrawlId: string | null;
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

export interface ChangeRunDetail {
  run: ChangeRunRow;
  summary: {
    model: string;
    promptVersion: string;
    usd: string;
    output: Record<string, unknown>;
  } | null;
  pages: PageChangeRow[];
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
    .select([
      "cc.crawlId",
      "cc.scheduleId",
      "s.name as scheduleName",
      "c.startedAt",
      "c.scheduledFor",
      "cc.prevCrawlId",
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
    const [summary, rows] = await Promise.all([
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
    };
  },
});
