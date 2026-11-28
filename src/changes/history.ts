/**
 * 同じ URL の取り込みの一覧と、好きな 2 本の差分 (CAPTURE-462) が読む SQL。認可 (`maySubmit`・`can_view`) は
 * エンドポイントの側 (`api/history.ts`)。
 *
 * **比べる行は SQL の中で選ばない。** 取り込みの `archive_pages` の行を引いてから、周回と同じ `comparedLineOf`
 * (`changes/pairs.ts`) で選ぶ。選び方を 1 か所に保ち、単体の試験で見られるようにするため。
 *
 * 一覧は `042` の生成列 (`archives.source_url_hash`) の索引で引く。本物の Postgres で索引が使われることは、CI の
 * smoke (`tools/history-smoke.ts`) が見る。
 */
import { sql, type Kysely } from "kysely";

import type { Database } from "../db/database.js";
import { comparedLineOf } from "./pairs.js";

/** 一覧 1 ページの取り込みの数。 */
export const HISTORY_PAGE_SIZE = 50;

/** 比べる行 (`archive_pages` の 1 行のうち、比べるのに要る欄)。 */
export interface ComparedLine {
  /** 写しなら `after-capture-scripts`、文書の行なら null。 */
  stage: string | null;
  textSha256: string | null;
  textChars: number | null;
  textWithheld: string | null;
}

/** 取り込みを比べられない訳のうち、DB の行だけで言える物。 */
export type NotComparable = "not_inspected" | "no_text" | "withheld";

/**
 * 取り込みを比べられない訳。上から順に見る: まだ検めていない・比べる行を伏せた・比べる行か文字の digest が無い。
 * 比べられるなら null (このとき比べる行は必ず在り、文字の digest を持つ)。
 */
export const notComparableOf = (
  inspectedAt: Date | null,
  line: ComparedLine | undefined,
): NotComparable | null => {
  if (inspectedAt === null) return "not_inspected";
  if (line !== undefined && line.textWithheld !== null) return "withheld";
  if (line === undefined || line.textSha256 === null) return "no_text";
  return null;
};

/** 一覧の 1 行。出どころ (クロールと予定) と撮り方つき。 */
export interface HistoryRow {
  id: string;
  capturedAt: Date;
  objectKey: string;
  browserhiveVersion: string | null;
  inspectedAt: Date | null;
  /** クロールに繋がらない行は null。 */
  crawlId: string | null;
  /** 手で始めたクロールは null。 */
  scheduleId: string | null;
  scheduleName: string | null;
  recipeSha256: string | null;
}

export interface HistoryPage {
  /** 新しい順に `HISTORY_PAGE_SIZE` 行まで。 */
  rows: HistoryRow[];
  /** 続きを引く `before` の値 (最後の行の撮った時刻)。続きが無ければ null。見てよい行の数には依らない。 */
  next: Date | null;
}

/** 差分の材料になる取り込み 1 本。 */
export interface HistoryArchive {
  id: string;
  bucket: string;
  objectKey: string;
  sourceUrl: string;
  capturedAt: Date;
  browserhiveVersion: string | null;
  inspectedAt: Date | null;
  /** WACZ の大きさ。検めた取り込みは必ず持つ (`027` の CHECK)。 */
  waczBytes: number | null;
  crawlId: string | null;
  /** クロールの組織 (要約の費用を数える先)。クロールに繋がらなければ null。 */
  orgId: string | null;
  recipeSha256: string | null;
  /** 比べる行。写しも文書の行も無ければ undefined。 */
  line: ComparedLine | undefined;
}

export interface HistoryReads {
  /** 同じ URL (正規化した形) の取り込み。`before` より前に撮った物を、新しい順に。 */
  list(url: string, before: Date | undefined): Promise<HistoryPage>;
  /** 取り込みごとの比べる行。行の無い取り込みは map に入らない。 */
  comparedLines(archiveIds: readonly string[]): Promise<Map<string, ComparedLine>>;
  /** 取り込み 2 本 (今と前)。無い物は undefined。 */
  pair(
    afterId: string,
    beforeId: string,
  ): Promise<{ after: HistoryArchive | undefined; before: HistoryArchive | undefined }>;
}

/**
 * 一覧の SQL。続きが在るかを見る 1 行を足して引く。組む所を分けてあるのは、smoke (`tools/history-smoke.ts`) が同じ
 * 物を `explain` に掛けて、`042` の索引が使われるのを見るため。
 */
export const historyListQuery = (db: Kysely<Database>, url: string, before: Date | undefined) => {
  const query = db
    .selectFrom("archives as a")
    .leftJoin("crawls as c", "c.id", "a.crawlId")
    // 消した予定の行は残っている (`032`)。名前はクロールの一覧と同じく、そのまま出す
    .leftJoin("crawlSchedules as s", "s.id", "c.scheduleId")
    .select([
      "a.id",
      "a.capturedAt",
      "a.objectKey",
      "a.browserhiveVersion",
      "a.inspectedAt",
      "c.id as crawlId",
      "c.scheduleId",
      "s.name as scheduleName",
      "c.recipeSha256",
    ])
    // 索引は digest の列 (`042`)。digest がぶつかった別の URL を返さないよう、URL そのものでも絞る
    .where("a.sourceUrlHash", "=", sql<Buffer>`digest(${url}::text, 'sha256')`)
    .where("a.sourceUrl", "=", url)
    .orderBy("a.capturedAt", "desc")
    .limit(HISTORY_PAGE_SIZE + 1);
  return before === undefined ? query : query.where("a.capturedAt", "<", before);
};

export const historyReadsOf = (db: Kysely<Database>): HistoryReads => {
  const comparedLines: HistoryReads["comparedLines"] = async (archiveIds) => {
    // 空の in は Postgres が断る
    if (archiveIds.length === 0) return new Map();
    const rows = await db
      .selectFrom("archivePages")
      .select(["archiveId", "stage", "textSha256", "textChars", "textWithheld"])
      .where("archiveId", "in", archiveIds)
      .orderBy("archiveId")
      .orderBy("ordinal")
      .execute();
    const byArchive = new Map<string, typeof rows>();
    for (const row of rows)
      byArchive.set(row.archiveId, [...(byArchive.get(row.archiveId) ?? []), row]);
    const lines = new Map<string, ComparedLine>();
    for (const [archiveId, pages] of byArchive) {
      const line = comparedLineOf(pages);
      if (line === undefined) continue;
      lines.set(archiveId, {
        stage: line.stage,
        textSha256: line.textSha256,
        textChars: line.textChars,
        textWithheld: line.textWithheld,
      });
    }
    return lines;
  };

  return {
    async list(url, before) {
      const found = await historyListQuery(db, url, before).execute();
      const rows = found.slice(0, HISTORY_PAGE_SIZE);
      const last = rows[rows.length - 1];
      return {
        rows,
        next: found.length > HISTORY_PAGE_SIZE && last !== undefined ? last.capturedAt : null,
      };
    },

    comparedLines,

    async pair(afterId, beforeId) {
      const rows = await db
        .selectFrom("archives as a")
        .leftJoin("crawls as c", "c.id", "a.crawlId")
        .select([
          "a.id",
          "a.bucket",
          "a.objectKey",
          "a.sourceUrl",
          "a.capturedAt",
          "a.browserhiveVersion",
          "a.inspectedAt",
          "a.waczBytes",
          "c.id as crawlId",
          "c.orgId",
          "c.recipeSha256",
        ])
        .where("a.id", "in", [...new Set([afterId, beforeId])])
        .execute();
      const after = rows.find((row) => row.id === afterId);
      const before = rows.find((row) => row.id === beforeId);
      // どちらかが無ければ、ページの行は読まない
      const lines =
        after === undefined || before === undefined
          ? new Map<string, ComparedLine>()
          : await comparedLines(rows.map((row) => row.id));
      const archive = (row: (typeof rows)[number] | undefined): HistoryArchive | undefined =>
        row === undefined
          ? undefined
          : {
              id: row.id,
              bucket: row.bucket,
              objectKey: row.objectKey,
              sourceUrl: row.sourceUrl,
              capturedAt: row.capturedAt,
              browserhiveVersion: row.browserhiveVersion,
              inspectedAt: row.inspectedAt,
              // bigint は node-pg が文字列で返す
              waczBytes: row.waczBytes === null ? null : Number(row.waczBytes),
              crawlId: row.crawlId,
              orgId: row.orgId,
              recipeSha256: row.recipeSha256,
              line: lines.get(row.id),
            };
      return { after: archive(after), before: archive(before) };
    },
  };
};
