/**
 * 節目のスクリーンショットの記録 (`archive/stage-screenshots.ts`) を `archive_screenshots` に書く (`041`)。WACZ を
 * 検める時 (`replay-bundle/inspect.ts`) と、埋め直しの道具 (`archive/screenshots-backfill-cli.ts`) が使う。
 *
 * **1 本につき 1 度だけ書く。** 印 (`archives.screenshots_recorded_at`) を立てる UPDATE が「検め済みで、まだ印が無い」を
 * 条件にするので、2 本が同じ WACZ を同時に書いても、後のほうは行の鍵で前を待ち、条件に外れて何も入れない。
 */
import type { S3Client } from "@aws-sdk/client-s3";
import type { Insertable, Kysely } from "kysely";
import type { ArchiveScreenshotsTable, Database } from "../db/database.js";
import { getObjectBytes, getObjectRange } from "./s3.js";
import { locateStageScreenshots, pictureOf, type StageScreenshotRow } from "./stage-screenshots.js";

/** 行 1 つ。3 つの形で、使わない列は NULL (CHECK)。 */
const insertableOf = (
  archiveId: string,
  row: StageScreenshotRow,
): Insertable<ArchiveScreenshotsTable> => {
  const empty = {
    skipped: null,
    waczOffset: null,
    waczLength: null,
    bytes: null,
    recordId: null,
    problem: null,
  };
  switch (row.kind) {
    case "skipped":
      return { archiveId, stage: row.stage, ...empty, skipped: row.skipped };
    case "problem":
      return { archiveId, stage: row.stage, ...empty, problem: row.problem };
    case "located":
      return {
        archiveId,
        stage: row.stage,
        ...empty,
        waczOffset: row.waczOffset,
        waczLength: row.waczLength,
        bytes: row.bytes,
        recordId: row.recordId,
      };
  }
};

/**
 * 印を立て、行を入れる (1 つのトランザクション)。`rows` が undefined (欄の無い WACZ) なら印だけ。印を立てられた
 * (先に書いた者が居なかった) なら true。
 */
export const recordStageScreenshots = async (
  db: Kysely<Database>,
  archiveId: string,
  rows: readonly StageScreenshotRow[] | undefined,
  recordedAt: string,
): Promise<boolean> =>
  db.transaction().execute(async (trx) => {
    const claimed = await trx
      .updateTable("archives")
      .set({ screenshotsRecordedAt: recordedAt })
      .where("id", "=", archiveId)
      .where("inspectedAt", "is not", null)
      .where("screenshotsRecordedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (claimed === undefined) return false;
    if (rows !== undefined && rows.length > 0) {
      await trx
        .insertInto("archiveScreenshots")
        .values(rows.map((row) => insertableOf(archiveId, row)))
        .execute();
    }
    return true;
  });

/** 埋め直しの数。 */
export interface BackfillCounts {
  /** 引いた本数 (検め済みで、まだ印の無い WACZ)。 */
  candidates: number;
  /** 行を 1 つ以上書いた本数。 */
  recorded: number;
  /** 欄の無い WACZ で、印だけ立てた本数。 */
  noField: number;
  /** 保管庫に無い本数 (印を立てない。次の回も 1 本の 404 で済む)。 */
  missing: number;
  /** 読めなかった本 (id と理由)。印を立てない。 */
  failed: string[];
}

/**
 * 検め済みで、まだ印の無い WACZ を読み直して書く (`pnpm run screenshots:backfill`)。何度流しても同じ —— 引く条件と
 * 書く UPDATE の条件が、どちらも「印が無い」。`crawlId` を渡せば、そのクロールの WACZ だけ。
 */
export const backfillStageScreenshots = async (options: {
  db: Kysely<Database>;
  s3: S3Client;
  crawlId?: string | undefined;
  now?: () => Date;
}): Promise<BackfillCounts> => {
  let query = options.db
    .selectFrom("archives")
    .select(["id", "bucket", "objectKey"])
    .where("inspectedAt", "is not", null)
    .where("screenshotsRecordedAt", "is", null);
  if (options.crawlId !== undefined) query = query.where("crawlId", "=", options.crawlId);
  const archives = await query.orderBy("capturedAt").execute();
  const counts: BackfillCounts = {
    candidates: archives.length,
    recorded: 0,
    noField: 0,
    missing: 0,
    failed: [],
  };
  for (const archive of archives) {
    try {
      const zip = await getObjectBytes(options.s3, archive.bucket, archive.objectKey);
      if (zip === undefined) {
        counts.missing += 1;
        continue;
      }
      const rows = await locateStageScreenshots(zip);
      const at = (options.now?.() ?? new Date()).toISOString();
      if (!(await recordStageScreenshots(options.db, archive.id, rows, at))) continue;
      if (rows === undefined || rows.length === 0) counts.noField += 1;
      else counts.recorded += 1;
    } catch (err) {
      counts.failed.push(`${archive.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return counts;
};

/** 確かめの数。 */
export interface VerifyCounts {
  /** 位置の在る行の数。 */
  located: number;
  /** Range で読んで、名指しの絵だった数。 */
  ok: number;
  /** WACZ が保管庫に無い数。 */
  missing: number;
  /** 読めなかった・名指しの絵でなかった行 (id・時点と理由)。 */
  failed: string[];
}

/**
 * 書いた位置を、読み出しと同じ道 (保管庫への Range の読み 1 本と `pictureOf`) で確かめる。**書かない**
 * (`pnpm run screenshots:backfill --verify`)。保管庫が Range に正しく答えるかも、ここで分かる。
 */
export const verifyStageScreenshots = async (options: {
  db: Kysely<Database>;
  s3: S3Client;
  crawlId?: string | undefined;
}): Promise<VerifyCounts> => {
  let query = options.db
    .selectFrom("archiveScreenshots as sh")
    .innerJoin("archives as a", "a.id", "sh.archiveId")
    .select([
      "sh.archiveId",
      "sh.stage",
      "sh.waczOffset",
      "sh.waczLength",
      "sh.bytes",
      "sh.recordId",
      "a.bucket",
      "a.objectKey",
    ])
    .where("sh.waczOffset", "is not", null);
  if (options.crawlId !== undefined) query = query.where("a.crawlId", "=", options.crawlId);
  const rows = await query.orderBy("sh.archiveId").orderBy("sh.stage").execute();
  const counts: VerifyCounts = { located: rows.length, ok: 0, missing: 0, failed: [] };
  for (const row of rows) {
    const label = `${row.archiveId} ${row.stage}`;
    try {
      if (row.waczOffset === null || row.waczLength === null || row.recordId === null) {
        throw new Error("the row has no place");
      }
      const member = await getObjectRange(
        options.s3,
        row.bucket,
        row.objectKey,
        Number(row.waczOffset),
        row.waczLength,
      );
      if (member === undefined) {
        counts.missing += 1;
        continue;
      }
      pictureOf(member, {
        stage: row.stage,
        recordId: row.recordId,
        bytes: row.bytes ?? undefined,
      });
      counts.ok += 1;
    } catch (err) {
      counts.failed.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return counts;
};
