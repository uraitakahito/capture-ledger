/**
 * 前回からの変化 (CAPTURE-167) の store。周回 (`changes/worker.ts`) とエンドポイント (`api/changes.ts`) は直に SQL を
 * 書かず、これを deps で受ける。形は `test/changes-store.test.ts` が記録する DB で照らし、Postgres で本当に通るか
 * (`for update skip locked`・部分の一意・jsonb) は CI の `changes-smoke` が本物の DB に当てる。
 *
 * ## 拾う回
 *
 * 予定の回で、締まっていて (`state <> 'running'`)、締まって 48 時間以内で、撮り方の digest が在り、まだ行が無く、
 * その回の WACZ を全部検め終えた物 (検めが失敗して残る WACZ のために、締まって 10 分を過ぎたら残りを待たない)。
 * 古い回は拾わない —— 遡るのは `changes:backfill` を打った人の判断。
 *
 * ## lease
 *
 * 拾うときに `lease_until` を立てて確定し、保管庫と Claude を待つ間はトランザクションを持たない。API が途中で
 * 落ちても、期限を過ぎた `comparing`・`summarizing` は次の周回が拾い直す。
 */
import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";

import type { ChangeSignificance, CrawlChangeState, Database } from "../db/database.js";
import type { DiffLine } from "./change-of.js";

/** 拾う回の窓。締まってからこれより古い回は、周回は拾わない。 */
export const PICK_WINDOW_HOURS = 48;
/** 検めの残りを待つ時間。締まってからこれを過ぎたら、検めていない WACZ は比べない。 */
export const INSPECT_GRACE_MINUTES = 10;

export interface RunToCompare {
  crawlId: string;
  scheduleId: string;
  orgId: string;
  startedAt: Date;
  recipeSha256: string;
}

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

export interface NewPageChange {
  url: string;
  archiveId: string;
  prevArchiveId: string;
  stage: string | null;
  state: "diffed" | "prev_missing";
  added: number;
  removed: number;
  hunks: DiffLine[][];
}

export interface CompareOutcome {
  state: Extract<CrawlChangeState, "no_previous" | "unchanged" | "diffed">;
  prevCrawlId: string | null;
  pagesCompared: number;
  pagesChanged: number;
  pages: readonly NewPageChange[];
}

export interface RunToSummarize {
  crawlId: string;
  orgId: string;
  prevCrawlId: string | null;
  attempts: number;
}

export interface StoredPageChange {
  url: string;
  state: "diffed" | "prev_missing";
  hunks: DiffLine[][];
}

/** 派生の層に残す要約 1 行 (`derivations` の `kind = 'change'`)。 */
export interface NewChangeDerivation {
  orgId: string;
  crawlId: string;
  target: Record<string, unknown>;
  inputSha256: string;
  model: string;
  promptVersion: string;
  effort: string;
  output: Record<string, unknown>;
  usage: Record<string, unknown>;
  usd: number;
}

export interface ChangeStore {
  /** 期限の切れた `comparing` か、新しい回を 1 本拾う。無ければ undefined。 */
  claimRunToCompare(now: Date, leaseMs: number): Promise<RunToCompare | undefined>;
  /** 同じ予定・同じ撮り方の、締まった 1 つ前の回。 */
  previousRun(run: RunToCompare): Promise<string | undefined>;
  /** 回のページ。URL ごとに 1 つ、比べる行 (after-behaviors の写し、無ければ文書の行)。 */
  comparedPages(crawlId: string): Promise<ComparedPage[]>;
  finishCompare(crawlId: string, outcome: CompareOutcome, now: Date): Promise<void>;
  /** 要約を待つ回 (差分あり・上限で待つ・期限の切れた要約中) を 1 本拾い、要約中にする。 */
  claimRunToSummarize(now: Date, leaseMs: number): Promise<RunToSummarize | undefined>;
  pageChangesOf(crawlId: string): Promise<StoredPageChange[]>;
  /** 同じ入力・同じ決まりの文の版の要約が在れば、その行。 */
  findSummary(
    inputSha256: string,
    promptVersion: string,
  ): Promise<{ id: string; output: Record<string, unknown> } | undefined>;
  /** 要約を残して終える。`derivation` が無ければ `derivationId` (前に払った行) を指す。 */
  finishSummary(
    crawlId: string,
    result: {
      derivation?: NewChangeDerivation;
      derivationId?: string;
      headline: string | null;
      significance: ChangeSignificance | null;
    },
    now: Date,
  ): Promise<void>;
  /** 失敗した試みの費用を残す (月の上限に数える)。 */
  recordAttempt(derivation: NewChangeDerivation): Promise<void>;
  deferForBudget(crawlId: string, nextAttemptAt: Date, now: Date): Promise<void>;
  /** 試みを 1 つ数える。`terminal` なら失敗で終え、でなければ差分ありに戻して `nextAttemptAt` に拾い直す。 */
  failAttempt(
    crawlId: string,
    failure: { error: string; terminal: boolean; nextAttemptAt: Date },
    now: Date,
  ): Promise<void>;
}

/** 比べる行の選び方。after-behaviors の写し、無ければ文書の行 (stage の無い行)。after-load だけの回は文書の行。 */
export const comparedLineOf = <T extends { stage: string | null }>(
  rows: readonly T[],
): T | undefined =>
  rows.find((row) => row.stage === "after-behaviors") ?? rows.find((row) => row.stage === null);

const iso = (date: Date) => date.toISOString();
const later = (now: Date, ms: number) => iso(new Date(now.getTime() + ms));

export const changeStoreOf = (db: Kysely<Database>): ChangeStore => ({
  async claimRunToCompare(now, leaseMs) {
    const lease = later(now, leaseMs);
    const stale = await sql<{ crawlId: string }>`
      update crawl_changes set lease_until = ${lease}, updated_at = ${iso(now)}
      where crawl_id = (
        select crawl_id from crawl_changes
        where state = 'comparing' and lease_until < ${iso(now)}
        order by created_at limit 1 for update skip locked
      )
      returning crawl_id`.execute(db);
    let crawlId = stale.rows[0]?.crawlId;
    if (crawlId === undefined) {
      const fresh = await sql<{ crawlId: string }>`
        insert into crawl_changes (crawl_id, schedule_id, org_id, state, lease_until)
        select c.id, c.schedule_id, c.org_id, 'comparing', ${lease}
        from crawls c
        where c.schedule_id is not null
          and c.state <> 'running'
          and c.recipe_sha256 is not null
          and c.finished_at > ${iso(now)}::timestamptz - make_interval(hours => ${PICK_WINDOW_HOURS})
          and not exists (select 1 from crawl_changes cc where cc.crawl_id = c.id)
          and (
            c.finished_at < ${iso(now)}::timestamptz - make_interval(mins => ${INSPECT_GRACE_MINUTES})
            or not exists (select 1 from archives a where a.crawl_id = c.id and a.inspected_at is null)
          )
        order by c.finished_at
        limit 1
        on conflict (crawl_id) do nothing
        returning crawl_id`.execute(db);
      crawlId = fresh.rows[0]?.crawlId;
    }
    if (crawlId === undefined) return undefined;
    const crawl = await db
      .selectFrom("crawls")
      .select(["id", "scheduleId", "orgId", "startedAt", "recipeSha256"])
      .where("id", "=", crawlId)
      .executeTakeFirstOrThrow();
    return {
      crawlId,
      scheduleId: crawl.scheduleId ?? "",
      orgId: crawl.orgId,
      startedAt: crawl.startedAt,
      recipeSha256: crawl.recipeSha256 ?? "",
    };
  },

  async previousRun(run) {
    const row = await db
      .selectFrom("crawls")
      .select("id")
      .where("scheduleId", "=", run.scheduleId)
      .where("recipeSha256", "=", run.recipeSha256)
      .where("state", "<>", "running")
      .where("startedAt", "<", run.startedAt)
      .where("id", "<>", run.crawlId)
      .orderBy("startedAt", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.id;
  },

  async comparedPages(crawlId) {
    const rows = await db
      .selectFrom("archives")
      .innerJoin("archivePages", "archivePages.archiveId", "archives.id")
      .select([
        "archives.id as archiveId",
        "archives.bucket",
        "archives.objectKey",
        "archives.sourceUrl as url",
        "archivePages.stage",
        "archivePages.textSha256",
        "archivePages.textWithheld",
      ])
      .where("archives.crawlId", "=", crawlId)
      .where("archives.inspectedAt", "is not", null)
      .orderBy("archives.capturedAt")
      .orderBy("archivePages.ordinal")
      .execute();
    const byArchive = new Map<string, ComparedPage[]>();
    for (const row of rows)
      byArchive.set(row.archiveId, [...(byArchive.get(row.archiveId) ?? []), row]);
    const byUrl = new Map<string, ComparedPage>();
    for (const pages of byArchive.values()) {
      const line = comparedLineOf(pages);
      // 回の中で同じ URL は 1 度しか撮らない (`crawl_pages` の重複排除)。在れば先の物
      if (line !== undefined && !byUrl.has(line.url)) byUrl.set(line.url, line);
    }
    return [...byUrl.values()];
  },

  async finishCompare(crawlId, outcome, now) {
    await db.transaction().execute(async (trx) => {
      if (outcome.pages.length > 0) {
        await trx
          .insertInto("pageChanges")
          .values(
            outcome.pages.map((page) => ({
              crawlId,
              prevCrawlId: outcome.prevCrawlId ?? "",
              url: page.url,
              archiveId: page.archiveId,
              prevArchiveId: page.prevArchiveId,
              stage: page.stage,
              state: page.state,
              added: page.added,
              removed: page.removed,
              hunks: JSON.stringify(page.hunks),
              diffVersion: 1,
            })),
          )
          // 期限が切れて拾い直した回が、前の行を書き終えていたら上書きしない (差分は同じ物)
          .onConflict((oc) => oc.columns(["crawlId", "url"]).doNothing())
          .execute();
      }
      await trx
        .updateTable("crawlChanges")
        .set({
          state: outcome.state,
          prevCrawlId: outcome.prevCrawlId,
          pagesCompared: outcome.pagesCompared,
          pagesChanged: outcome.pagesChanged,
          leaseUntil: null,
          nextAttemptAt: iso(now),
          updatedAt: iso(now),
        })
        .where("crawlId", "=", crawlId)
        .where("state", "=", "comparing")
        .execute();
    });
  },

  async claimRunToSummarize(now, leaseMs) {
    const result = await sql<RunToSummarize>`
      update crawl_changes set state = 'summarizing', lease_until = ${later(now, leaseMs)}, updated_at = ${iso(now)}
      where crawl_id = (
        select crawl_id from crawl_changes
        where (state in ('diffed', 'budget_wait') or (state = 'summarizing' and lease_until < ${iso(now)}))
          and next_attempt_at <= ${iso(now)}
        order by created_at limit 1 for update skip locked
      )
      returning crawl_id, org_id, prev_crawl_id, attempts`.execute(db);
    return result.rows[0];
  },

  async pageChangesOf(crawlId) {
    return db
      .selectFrom("pageChanges")
      .select(["url", "state", "hunks"])
      .where("crawlId", "=", crawlId)
      .orderBy("url")
      .execute() as Promise<StoredPageChange[]>;
  },

  async findSummary(inputSha256, promptVersion) {
    return db
      .selectFrom("derivations")
      .select(["id", "output"])
      .where("kind", "=", "change")
      .where("inputSha256", "=", inputSha256)
      .where("promptVersion", "=", promptVersion)
      .executeTakeFirst();
  },

  async finishSummary(crawlId, result, now) {
    await db.transaction().execute(async (trx) => {
      let derivationId = result.derivationId ?? null;
      if (result.derivation !== undefined) {
        const d = result.derivation;
        const inserted = await trx
          .insertInto("derivations")
          .values({
            id: randomUUID(),
            kind: "change",
            orgId: d.orgId,
            crawlId: d.crawlId,
            target: JSON.stringify(d.target),
            inputSha256: d.inputSha256,
            model: d.model,
            promptVersion: d.promptVersion,
            effort: d.effort,
            rounds: 1,
            output: JSON.stringify(d.output),
            usage: JSON.stringify(d.usage),
            usd: d.usd.toFixed(6),
            createdBy: "capture-ledger",
          })
          // 同じ入力を同じ版で 2 度残さない (`034` の部分の一意)。ぶつかったら前の行を指す
          .onConflict((oc) =>
            oc.columns(["inputSha256", "promptVersion"]).where("kind", "=", "change").doNothing(),
          )
          .returning("id")
          .executeTakeFirst();
        derivationId =
          inserted?.id ??
          (
            await trx
              .selectFrom("derivations")
              .select("id")
              .where("kind", "=", "change")
              .where("inputSha256", "=", d.inputSha256)
              .where("promptVersion", "=", d.promptVersion)
              .executeTakeFirst()
          )?.id ??
          null;
      }
      await trx
        .updateTable("crawlChanges")
        .set({
          state: "summarized",
          derivationId,
          headline: result.headline,
          significance: result.significance,
          error: null,
          leaseUntil: null,
          updatedAt: iso(now),
        })
        .where("crawlId", "=", crawlId)
        .where("state", "=", "summarizing")
        .execute();
    });
  },

  async recordAttempt(d) {
    await db
      .insertInto("derivations")
      .values({
        id: randomUUID(),
        kind: "change",
        orgId: d.orgId,
        crawlId: d.crawlId,
        target: JSON.stringify(d.target),
        inputSha256: d.inputSha256,
        model: d.model,
        promptVersion: d.promptVersion,
        effort: d.effort,
        rounds: 1,
        output: JSON.stringify(d.output),
        usage: JSON.stringify(d.usage),
        usd: d.usd.toFixed(6),
        createdBy: "capture-ledger",
      })
      .execute();
  },

  async deferForBudget(crawlId, nextAttemptAt, now) {
    await db
      .updateTable("crawlChanges")
      .set({
        state: "budget_wait",
        nextAttemptAt: iso(nextAttemptAt),
        leaseUntil: null,
        updatedAt: iso(now),
      })
      .where("crawlId", "=", crawlId)
      .where("state", "=", "summarizing")
      .execute();
  },

  async failAttempt(crawlId, failure, now) {
    await db
      .updateTable("crawlChanges")
      .set((eb) => ({
        state: failure.terminal ? "failed" : "diffed",
        attempts: eb("attempts", "+", 1),
        error: failure.error.slice(0, 500),
        nextAttemptAt: iso(failure.nextAttemptAt),
        leaseUntil: null,
        updatedAt: iso(now),
      }))
      .where("crawlId", "=", crawlId)
      .where("state", "=", "summarizing")
      .execute();
  },
});
