/**
 * WACZ を 1 度だけ検める: sha256 と大きさを数え、索引 (`indexes/index.cdxj`) が空かを見て、`pages/pages.jsonl` の
 * 行を `archive_pages` に入れる (`027`)。合本はここに残した物から組むので、段ごとに全部の WACZ を読み直さない。
 * 行には文字の sha256 と長さ (`035`) も入れ、`datapackage.json` から撮った BrowserHive と Chrome の版を `archives` に
 * 入れる。前回からの変化 (CAPTURE-167) は、digest が同じページの WACZ を開かずに済む。
 *
 * ## 読む物
 *
 * - WACZ は丸ごと (`archive/s3.ts` の `getObjectBytes`)。sha256 と大きさは、そのバイト列から数える (保管庫の
 *   ETag は MD5 で、大きさだけでは中身を言えない)。zip の中は `archive/wacz.ts` (全文検索の索引と共有)
 * - BrowserHive の答え (`.result.json`)。鍵は段の報告が書き留めた `capture_submissions.manifest_key` で、
 *   capture-ledger は組まない (`014`)。読むのは `document.url` (リダイレクトの後の文書。文書の行の `keys` に足す) と
 *   `waczStats.totalRecorded` (0 なら記録が 0)。**無くても検める** —— 鍵が無い・保管庫に無い・契約に合わない
 *   答えは、頼んだ URL だけを `keys` にする。保管庫に届かないときだけ投げる (次に拾い直す)
 *
 * ## 失敗しても `inspected_at` を立てない
 *
 * 立てるのは読み終えてから、行と同じトランザクションで。WACZ が保管庫に無い・zip として読めない・保管庫に届かない
 * ときは投げ、呼ぶ側 (`replay-bundle/write.ts`) が数えて続ける。列は NULL のままなので、次の合本が拾い直す。
 *
 * **2 本が同じ WACZ を同時に検めても、行は 1 組だけ。** 立てる UPDATE が `inspected_at IS NULL` を条件にするので、
 * 後のほうは行の鍵で前を待ち、条件に外れて何も入れない。
 */
import { createHash } from "node:crypto";
import type { Insertable, Kysely } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import { getJsonObject, getObjectBytes } from "../archive/s3.js";
import { readManifest } from "../archive/manifest.js";
import { entrySize, INDEX_ENTRY_PATH, PAGES_ENTRY_PATH, readEntry } from "../archive/wacz.js";

/** 版を読む entry。WACZ の決まりの名前。 */
const DATAPACKAGE_ENTRY_PATH = "datapackage.json";
import type { ArchivePagesTable, Database } from "../db/database.js";
import { parsePagesJsonl, type PageLine } from "../search/document.js";
import { createChildLogger } from "../logger.js";
import { archivePageRows } from "./format.js";

const log = createChildLogger({ module: "replay-bundle-inspect" });

/** まだ検めていないアーカイブ 1 本。 */
export interface UninspectedArchive {
  id: string;
  bucket: string;
  objectKey: string;
  /** その取り込みの `.result.json` の鍵 (bucket を除く)。記録が無ければ null。 */
  manifestKey: string | null;
}

/** WACZ のバイト列から読める物。 */
export interface WaczFacts {
  sha256: string;
  bytes: number;
  /** `indexes/index.cdxj` が無いか、0 バイト。 */
  indexEmpty: boolean;
  /** `pages.jsonl` の頁の行 (先頭の format の行は除く)。 */
  lines: PageLine[];
  /** 撮った BrowserHive と Chrome の版 (`datapackage.json`)。読めなければ null。 */
  browserhiveVersion: string | null;
  browserVersion: string | null;
}

const stringAt = (value: unknown, ...path: string[]): string | null => {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object") return null;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === "string" ? at : null;
};

/** `datapackage.json` から版を読む。無い・JSON でない・欄が無いときは null (検めは続ける)。 */
const versionsOf = (
  raw: string | undefined,
): Pick<WaczFacts, "browserhiveVersion" | "browserVersion"> => {
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return {
    browserhiveVersion: stringAt(parsed, "browserhive:capture", "build", "version"),
    browserVersion: stringAt(parsed, "browserhive:capture", "browser", "product"),
  };
};

/** WACZ のバイト列を検める。zip として読めなければ投げる。 */
export const readWaczFacts = async (zip: Buffer): Promise<WaczFacts> => {
  const raw = await readEntry(zip, PAGES_ENTRY_PATH);
  const indexBytes = await entrySize(zip, INDEX_ENTRY_PATH);
  const datapackage = await readEntry(zip, DATAPACKAGE_ENTRY_PATH);
  return {
    sha256: createHash("sha256").update(zip).digest("hex"),
    bytes: zip.length,
    indexEmpty: indexBytes === undefined || indexBytes === 0,
    lines: raw === undefined ? [] : parsePagesJsonl(raw),
    ...versionsOf(datapackage),
  };
};

/** BrowserHive の答えから読む物。 */
interface ManifestFacts {
  documentUrl: string | undefined;
  totalRecorded: number | undefined;
}

/**
 * 答えを読む。無い・JSON でない・契約に合わないときは `undefined` (検めは続ける)。保管庫に届かなければ投げる。
 */
const readManifestFacts = async (
  s3: S3Client,
  bucket: string,
  key: string,
  archiveId: string,
): Promise<ManifestFacts | undefined> => {
  let raw: unknown;
  try {
    raw = await getJsonObject(s3, bucket, key);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    log.warn({ err, archiveId, key }, "Manifest is not JSON; keys carry the requested URL only");
    return undefined;
  }
  if (raw === undefined) {
    log.warn({ archiveId, key }, "Manifest is not where the capture reported writing it");
    return undefined;
  }
  try {
    const report = readManifest(raw);
    return { documentUrl: report.document?.url, totalRecorded: report.waczStats?.totalRecorded };
  } catch (err) {
    log.warn({ err, archiveId, key }, "Manifest is not a report the ledger can read");
    return undefined;
  }
};

export interface InspectOptions {
  db: Kysely<Database>;
  s3: S3Client;
  /** `.result.json` を読む bucket (設定の物。段の登録と同じ)。 */
  bucket: string;
  now?: () => Date;
}

/** 1 本を検め、`archives` の 6 つの列と `archive_pages` の行を 1 つのトランザクションで書く。 */
export const inspectArchive = async (
  archive: UninspectedArchive,
  options: InspectOptions,
): Promise<void> => {
  const zip = await getObjectBytes(options.s3, archive.bucket, archive.objectKey);
  if (zip === undefined) {
    throw new Error(`the WACZ is not in the store (${archive.bucket}/${archive.objectKey})`);
  }
  const facts = await readWaczFacts(zip);
  const manifest =
    archive.manifestKey === null
      ? undefined
      : await readManifestFacts(options.s3, options.bucket, archive.manifestKey, archive.id);
  const rows = archivePageRows(facts.lines, manifest?.documentUrl);
  const indexEmpty = facts.indexEmpty || manifest?.totalRecorded === 0;
  const inspectedAt = (options.now?.() ?? new Date()).toISOString();

  await options.db.transaction().execute(async (trx) => {
    const claimed = await trx
      .updateTable("archives")
      .set({
        waczSha256: facts.sha256,
        waczBytes: facts.bytes,
        indexEmpty,
        inspectedAt,
        browserhiveVersion: facts.browserhiveVersion,
        browserVersion: facts.browserVersion,
      })
      .where("id", "=", archive.id)
      // 先に検めた者が居れば何もしない (行の鍵で待ち、条件に外れる)
      .where("inspectedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (claimed === undefined || rows.length === 0) return;
    await trx
      .insertInto("archivePages")
      .values(
        // **戻り値の型を書く** (`api/crawls.ts` の capture_submissions と同じ理由)。無いと存在しない列を書いても
        // typecheck が緑になる。この repo に DB の試験は無い
        rows.map((row): Insertable<ArchivePagesTable> => ({
          archiveId: archive.id,
          ordinal: row.ordinal,
          pageId: row.pageId,
          url: row.url,
          ts: row.ts,
          title: row.title,
          stage: row.stage,
          keys: row.keys,
          textSha256: row.textSha256,
          textChars: row.textChars,
          textWithheld: row.textWithheld,
        })),
      )
      .execute();
  });
  log.info(
    { archiveId: archive.id, pages: rows.length, indexEmpty, bytes: facts.bytes },
    "archive inspected",
  );
};

/**
 * クロール 1 本の、まだ検めていないアーカイブ。答えの鍵は `capture_submissions` から (task_id はどちらも uuid)。
 */
export const uninspectedArchives = (
  db: Kysely<Database>,
  crawlId: string,
): Promise<UninspectedArchive[]> =>
  db
    .selectFrom("archives as a")
    .leftJoin("captureSubmissions as s", "s.taskId", "a.taskId")
    .select(["a.id", "a.bucket", "a.objectKey", "s.manifestKey"])
    .where("a.crawlId", "=", crawlId)
    .where("a.inspectedAt", "is", null)
    .orderBy("a.capturedAt")
    .execute();
