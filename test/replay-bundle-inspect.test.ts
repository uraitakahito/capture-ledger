import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { inspectArchive, readWaczFacts } from "../src/replay-bundle/inspect.js";
import { recordingDb } from "./recording-db.js";
import { storedZip } from "./zip.js";

/**
 * WACZ を検める道。zip は本物の読み手 (yauzl-promise) に通し (`zip.ts` で組む)、DB は組まれた SQL を記録する代役
 * (`recording-db.ts`)、保管庫は読みに来た鍵を数える偽物。**SQL が Postgres で本当に通るかはここでは言えない**
 * (この repo に DB の試験は無い)。
 */

const TASK = "550e8400-e29b-41d4-a716-446655440000";
const ARCHIVE = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const WACZ_KEY = `${TASK}_crawl.wacz`;
/** 報告が運んだ鍵。BrowserHive の命名規則では作れない綴り (組み直す実装なら別の鍵を読みに行く)。 */
const MANIFEST_KEY = "elsewhere/x y+z.result.json";

/** 文書の行の文字。digest と長さを `archive_pages` に入れる (`035`)。 */
const TEXT = "お知らせ\n2026-11-12 本文";
/** 撮った BrowserHive と Chrome の版 (`datapackage.json`)。 */
const DATAPACKAGE = JSON.stringify({
  "browserhive:capture": {
    build: { version: "29.0.1" },
    browser: { product: "Chrome/156.0.8078.73" },
  },
});

const HEADER = JSON.stringify({ format: "json-pages-1.0", id: "pages", title: "All Pages" });
const pagesJsonl = [
  HEADER,
  JSON.stringify({
    id: TASK,
    url: "http://site.test/a",
    ts: "2026-11-05T01:03:57.957Z",
    title: "a",
    text: TEXT,
  }),
  JSON.stringify({
    id: `${TASK}-after-load`,
    url: "urn:browserhive:snapshot:after-load:http://site.test/landed",
    ts: "2026-11-05T01:03:58.100Z",
    title: "a",
    stage: "after-load",
  }),
].join("\n");

/** 索引 (`indexes/index.cdxj`) の中身。null なら entry ごと無い。 */
const wacz = (index: string | null = "com,site)/a 20261105010357 {}\n") =>
  storedZip({
    "datapackage.json": DATAPACKAGE,
    ...(index !== null && { "indexes/index.cdxj": index }),
    "pages/pages.jsonl": `${pagesJsonl}\n`,
  });

/** BrowserHive が `.result.json` に書くとおりの答え。 */
const manifest = (totalRecorded = 3) => ({
  taskId: TASK,
  url: "http://site.test/a",
  labels: [],
  status: "success",
  timestamp: "2026-11-05T01:04:00.000Z",
  captureProcessingTimeMs: 100,
  artifacts: { wacz: `s3://browserhive/${WACZ_KEY}` },
  document: { url: "http://site.test/landed" },
  waczStats: {
    totalRecorded,
    totalBlocked: 0,
    totalSkippedContentType: 0,
    totalTruncatedTooLarge: 0,
    totalTruncatedTaskCap: 0,
    totalFailed: 0,
    totalIncomplete: 0,
    totalBodyBytes: 100,
    totalDenied: 0,
    totalSkippedUrlPolicy: 0,
    totalNotIntercepted: 0,
  },
});

/** 保管庫に置いた物。Buffer はバイト列、object は JSON、Error は投げる。無い鍵は NoSuchKey。 */
type Stored = Buffer | object | Error;

const fakeS3 = (store: Record<string, Stored>) => {
  const read: string[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string } }) => {
      const { Bucket, Key } = command.input;
      read.push(`${Bucket}/${Key}`);
      const stored = store[`${Bucket}/${Key}`];
      if (stored === undefined) {
        return Promise.reject(
          Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" }),
        );
      }
      if (stored instanceof Error) return Promise.reject(stored);
      const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(JSON.stringify(stored));
      return Promise.resolve({
        Body: {
          transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)),
          transformToString: () => Promise.resolve(bytes.toString("utf8")),
        },
      });
    },
  };
  return { s3: s3 as unknown as S3Client, read };
};

const NOW = new Date("2026-11-05T03:00:00.000Z");
const ARCHIVE_ROW = {
  id: ARCHIVE,
  bucket: "browserhive",
  objectKey: WACZ_KEY,
  manifestKey: MANIFEST_KEY,
};

const inspect = async (
  store: Record<string, Stored>,
  opts: { claimed?: boolean; archive?: typeof ARCHIVE_ROW | { manifestKey: null } } = {},
) => {
  // 立てる UPDATE が当たったか (先に検めた者が居なければ 1 行返る)
  const { db, queries } = recordingDb([opts.claimed === false ? [] : [{ id: ARCHIVE }]]);
  const { s3, read } = fakeS3(store);
  await inspectArchive(
    { ...ARCHIVE_ROW, ...opts.archive },
    { db, s3, bucket: "browserhive", now: () => NOW },
  );
  return { queries, read };
};

describe("WACZ のバイト列を検める", () => {
  it("sha256 と大きさはファイル全体から数え、頁の行は先頭の format の行を除く", async () => {
    const zip = wacz();
    const facts = await readWaczFacts(zip);
    expect(facts.sha256).toBe(createHash("sha256").update(zip).digest("hex"));
    expect(facts.bytes).toBe(zip.length);
    expect(facts.indexEmpty).toBe(false);
    expect(facts.lines.map((line) => line.id)).toEqual([TASK, `${TASK}-after-load`]);
  });

  it("索引が 0 バイトなら、記録が 0（中身は読まずに大きさで見る）", async () => {
    expect((await readWaczFacts(wacz(""))).indexEmpty).toBe(true);
  });

  it("索引が無くても、記録が 0", async () => {
    expect((await readWaczFacts(wacz(null))).indexEmpty).toBe(true);
  });

  it("zip でなければ投げる", async () => {
    await expect(readWaczFacts(Buffer.from("not a zip"))).rejects.toThrow();
  });
});

describe("アーカイブ 1 本を検めて書く", () => {
  it("6 つの列と頁の行を 1 つのトランザクションで書き、文書の行の keys に document.url を足す", async () => {
    const zip = wacz();
    const { queries, read } = await inspect({
      [`browserhive/${WACZ_KEY}`]: zip,
      [`browserhive/${MANIFEST_KEY}`]: manifest(),
    });
    expect(read).toEqual([`browserhive/${WACZ_KEY}`, `browserhive/${MANIFEST_KEY}`]);
    expect(queries.map((query) => query.sql)).toEqual([
      "begin",
      'update "archives" set "wacz_sha256" = $1, "wacz_bytes" = $2, "index_empty" = $3, "inspected_at" = $4, ' +
        '"browserhive_version" = $5, "browser_version" = $6 where "id" = $7 and "inspected_at" is null returning "id"',
      'insert into "archive_pages" ("archive_id", "ordinal", "page_id", "url", "ts", "title", "stage", "keys", ' +
        '"text_sha256", "text_chars", "text_withheld") ' +
        "values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11), ($12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)",
      "commit",
    ]);
    expect(queries[1]?.parameters).toEqual([
      createHash("sha256").update(zip).digest("hex"),
      zip.length,
      false,
      NOW.toISOString(),
      "29.0.1",
      "Chrome/156.0.8078.73",
      ARCHIVE,
    ]);
    expect(queries[2]?.parameters).toEqual([
      ARCHIVE,
      0,
      TASK,
      "http://site.test/a",
      "2026-11-05T01:03:57.957Z",
      "a",
      null,
      ["http://site.test/a", "http://site.test/landed"],
      createHash("sha256").update(TEXT).digest("hex"),
      TEXT.length,
      null,
      ARCHIVE,
      1,
      `${TASK}-after-load`,
      "urn:browserhive:snapshot:after-load:http://site.test/landed",
      "2026-11-05T01:03:58.100Z",
      "a",
      "after-load",
      [],
      // 文字の無い写しの行は digest も長さも null
      null,
      null,
      null,
    ]);
  });

  it("答えの waczStats.totalRecorded が 0 なら、索引が在っても記録が 0", async () => {
    const { queries } = await inspect({
      [`browserhive/${WACZ_KEY}`]: wacz(),
      [`browserhive/${MANIFEST_KEY}`]: manifest(0),
    });
    expect(queries[1]?.parameters[2]).toBe(true);
  });

  it("答えが無くても検め、keys は頼んだ URL だけ", async () => {
    const { queries } = await inspect({ [`browserhive/${WACZ_KEY}`]: wacz() });
    expect(queries[1]?.parameters[2]).toBe(false);
    expect(queries[2]?.parameters[7]).toEqual(["http://site.test/a"]);
  });

  it("答えの鍵が記録されていなければ、答えを読みに行かない", async () => {
    const { read, queries } = await inspect(
      { [`browserhive/${WACZ_KEY}`]: wacz() },
      { archive: { manifestKey: null } },
    );
    expect(read).toEqual([`browserhive/${WACZ_KEY}`]);
    expect(queries[2]?.parameters[7]).toEqual(["http://site.test/a"]);
  });

  it("答えが契約に合わなくても検める（keys は頼んだ URL だけ）", async () => {
    const { queries } = await inspect({
      [`browserhive/${WACZ_KEY}`]: wacz(),
      [`browserhive/${MANIFEST_KEY}`]: { ...manifest(), status: "CAPTURE_STATUS_SUCCESS" },
    });
    expect(queries[2]?.parameters[7]).toEqual(["http://site.test/a"]);
  });

  it("答えのある保管庫に届かなければ投げ、何も書かない（次の合本が拾い直す）", async () => {
    await expect(
      inspect({
        [`browserhive/${WACZ_KEY}`]: wacz(),
        [`browserhive/${MANIFEST_KEY}`]: new Error("connect ECONNREFUSED 127.0.0.1:8333"),
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("WACZ が保管庫に無ければ投げ、何も書かない", async () => {
    const { db, queries } = recordingDb();
    const { s3 } = fakeS3({});
    await expect(
      inspectArchive(ARCHIVE_ROW, { db, s3, bucket: "browserhive", now: () => NOW }),
    ).rejects.toThrow("the WACZ is not in the store");
    expect(queries).toEqual([]);
  });

  it("先に検めた者が居れば（立てる UPDATE が当たらなければ）、頁の行を入れない", async () => {
    const { queries } = await inspect(
      { [`browserhive/${WACZ_KEY}`]: wacz(), [`browserhive/${MANIFEST_KEY}`]: manifest() },
      { claimed: false },
    );
    expect(queries.map((query) => query.sql.split(" ")[0])).toEqual(["begin", "update", "commit"]);
  });
});
