import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { locateStageScreenshots } from "../src/archive/stage-screenshots.js";
import {
  backfillStageScreenshots,
  verifyStageScreenshots,
} from "../src/archive/stage-screenshots-store.js";
import { recordingDb } from "./recording-db.js";
import { screenshotWacz, webpBytes } from "./stage-screenshot-wacz.js";

/**
 * 埋め直しと確かめ (`archive/stage-screenshots-store.ts`)。DB は組まれた SQL を記録する代役、保管庫は鍵と Range を
 * 記録する偽物 (Range なら、その範囲ちょうどを返す)。
 */
const ARCHIVE = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const KEY = "task_crawl.browserhive.wacz";
const shot = {
  stage: "after-load",
  documentUrl: "http://site.test/a",
  date: "2026-11-15T01:00:00.100Z",
  record: "urn:uuid:11111111-1111-4111-8111-111111111111",
  picture: webpBytes("L"),
};

const fakeS3 = (store: Record<string, Buffer>) => {
  const read: string[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string; Range?: string } }) => {
      const { Bucket, Key, Range } = command.input;
      read.push(`${Bucket}/${Key}${Range === undefined ? "" : ` ${Range}`}`);
      const object = store[`${Bucket}/${Key}`];
      if (object === undefined) {
        return Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec(Range ?? "");
      const bytes = m === null ? object : object.subarray(Number(m[1]), Number(m[2]) + 1);
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)) },
      });
    },
  };
  return { s3: s3 as unknown as S3Client, read };
};

const NOW = new Date("2026-11-15T03:00:00.000Z");

describe("節目のスクリーンショットを埋め直す", () => {
  it("検め済みで印の無い WACZ だけを引き、行と印を書く", async () => {
    const { db, queries } = recordingDb([
      [{ id: ARCHIVE, bucket: "browserhive", objectKey: KEY }],
      [{ id: ARCHIVE }],
    ]);
    const { s3 } = fakeS3({ [`browserhive/${KEY}`]: screenshotWacz([shot]) });
    const counts = await backfillStageScreenshots({ db, s3, now: () => NOW });
    expect(counts).toEqual({ candidates: 1, recorded: 1, noField: 0, missing: 0, failed: [] });
    expect(queries[0]?.sql).toBe(
      'select "id", "bucket", "object_key" from "archives" where "inspected_at" is not null ' +
        'and "screenshots_recorded_at" is null order by "captured_at"',
    );
    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual([
      "select",
      "begin",
      "update",
      "insert",
      "commit",
    ]);
  });

  it("保管庫に無い WACZ は数えて飛ばし、印を立てない", async () => {
    const { db, queries } = recordingDb([[{ id: ARCHIVE, bucket: "browserhive", objectKey: KEY }]]);
    const { s3 } = fakeS3({});
    const counts = await backfillStageScreenshots({ db, s3, now: () => NOW });
    expect(counts.missing).toBe(1);
    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual(["select"]);
  });

  it("欄の無い WACZ は、印だけ立てて noField に数える", async () => {
    const { db, queries } = recordingDb([
      [{ id: ARCHIVE, bucket: "browserhive", objectKey: KEY }],
      [{ id: ARCHIVE }],
    ]);
    const { s3 } = fakeS3({ [`browserhive/${KEY}`]: screenshotWacz(null) });
    expect((await backfillStageScreenshots({ db, s3, now: () => NOW })).noField).toBe(1);
    expect(queries.some((q) => q.sql.startsWith('insert into "archive_screenshots"'))).toBe(false);
  });

  it("2 度目は何も書かない（印の無い行が無い）", async () => {
    const { db, queries } = recordingDb([[]]);
    const { s3, read } = fakeS3({});
    expect((await backfillStageScreenshots({ db, s3 })).candidates).toBe(0);
    expect(read).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it("--crawl を渡すと、そのクロールの WACZ だけを引く", async () => {
    const { db, queries } = recordingDb([[]]);
    const { s3 } = fakeS3({});
    await backfillStageScreenshots({ db, s3, crawlId: "c0000000-0000-4000-8000-000000000000" });
    expect(queries[0]?.sql).toContain('and "crawl_id" = $1');
  });
});

describe("書いた位置を確かめる（書かない）", () => {
  it("覚えた位置を Range で 1 本読み、名指しの絵なら ok に数える", async () => {
    const zip = screenshotWacz([shot]);
    const located = (await locateStageScreenshots(zip))?.[0];
    if (located?.kind !== "located") throw new Error("not located");
    const { db, queries } = recordingDb([
      [
        {
          archiveId: ARCHIVE,
          stage: "after-load",
          waczOffset: String(located.waczOffset),
          waczLength: located.waczLength,
          bytes: located.bytes,
          recordId: located.recordId,
          bucket: "browserhive",
          objectKey: KEY,
        },
      ],
    ]);
    const { s3, read } = fakeS3({ [`browserhive/${KEY}`]: zip });
    expect(await verifyStageScreenshots({ db, s3 })).toEqual({
      located: 1,
      ok: 1,
      missing: 0,
      failed: [],
    });
    expect(read).toEqual([
      `browserhive/${KEY} bytes=${String(located.waczOffset)}-${String(located.waczOffset + located.waczLength - 1)}`,
    ]);
    // 書かない
    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual(["select"]);
  });

  it("位置がずれていれば failed に数える", async () => {
    const zip = screenshotWacz([shot]);
    const located = (await locateStageScreenshots(zip))?.[0];
    if (located?.kind !== "located") throw new Error("not located");
    const { db } = recordingDb([
      [
        {
          archiveId: ARCHIVE,
          stage: "after-load",
          waczOffset: String(located.waczOffset + 1),
          waczLength: located.waczLength,
          bytes: located.bytes,
          recordId: located.recordId,
          bucket: "browserhive",
          objectKey: KEY,
        },
      ],
    ]);
    const { s3 } = fakeS3({ [`browserhive/${KEY}`]: zip });
    const counts = await verifyStageScreenshots({ db, s3 });
    expect(counts.ok).toBe(0);
    expect(counts.failed).toHaveLength(1);
  });
});
