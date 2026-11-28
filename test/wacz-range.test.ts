/**
 * 保管庫の WACZ から entry 1 つを Range だけで読む (`archive/wacz-range.ts`。CAPTURE-462)。
 *
 * 作り物の WACZ は、WARC の代わりの大きい entry (stored) を持つ。**末尾の控え (256 KiB) より大きくする** ——
 * 小さい WACZ は、控えが全体を覆ってしまい、丸ごと読む実装と区別できない。偽の保管庫は、頼まれた Range を記録して
 * その範囲ちょうどを返す。
 */
import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { PAGES_ENTRY_PATH, readEntry } from "../src/archive/wacz.js";
import {
  ENTRY_MAX_BYTES,
  readWaczEntryByRange,
  TAIL_BYTES,
  WaczStoreError,
} from "../src/archive/wacz-range.js";
import { storedZip } from "./zip.js";

const KEY = "task_crawl.browserhive.wacz";
/** WARC の代わり。末尾の控えより大きい。 */
const WARC = Buffer.alloc(TAIL_BYTES + 44 * 1024, "W");
const PAGES = [
  JSON.stringify({ format: "json-pages-1.0", id: "pages" }),
  JSON.stringify({ url: "https://site.test/", text: "お知らせ\n更新: 2026-11-22" }),
  JSON.stringify({
    url: "urn:browserhive:snapshot:after-capture-scripts:https://site.test/",
    stage: "after-capture-scripts",
    text: "お知らせ\n".repeat(400),
  }),
].join("\n");
const SMALL = {
  "indexes/index.cdxj": "com,test)/ 20261122000000 {}\n",
  "datapackage.json": '{"profile":"data-package"}',
  "datapackage-digest.json": '{"path":"datapackage.json"}',
};

/** BrowserHive と同じ並び: WARC が前、`pages.jsonl` はその後ろ (末尾の近く)。 */
const waczWithPagesAtTail = (pages = PAGES) =>
  storedZip(
    { "archive/data.browserhive.warc.gz": WARC, [PAGES_ENTRY_PATH]: pages, ...SMALL },
    { deflate: [PAGES_ENTRY_PATH] },
  );
/** `pages.jsonl` が頭に在り、末尾の控えに入らない並び。 */
const waczWithPagesAtHead = (pages = PAGES) =>
  storedZip(
    { [PAGES_ENTRY_PATH]: pages, "archive/data.browserhive.warc.gz": WARC, ...SMALL },
    { deflate: [PAGES_ENTRY_PATH] },
  );

const fakeS3 = (object: Buffer | undefined | Error, opts: { ignoreRange?: boolean } = {}) => {
  const ranges: string[] = [];
  let bytes = 0;
  const s3 = {
    send: (command: { input: { Range?: string } }) => {
      ranges.push(command.input.Range ?? "(whole)");
      if (object === undefined) {
        return Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
      }
      if (object instanceof Error) return Promise.reject(object);
      const m = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? "");
      const part =
        opts.ignoreRange === true || m === null
          ? object
          : object.subarray(Number(m[1]), Number(m[2]) + 1);
      bytes += part.length;
      return Promise.resolve({
        ContentLength: part.length,
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(part)) },
      });
    },
  };
  return { s3: s3 as unknown as S3Client, ranges, sent: () => bytes };
};

const read = (s3: S3Client, zip: Buffer, maxBytes?: number) =>
  readWaczEntryByRange(
    s3,
    { bucket: "browserhive", objectKey: KEY, size: zip.length },
    PAGES_ENTRY_PATH,
    maxBytes,
  );

describe("保管庫の WACZ から entry 1 つを Range だけで読む", () => {
  it("作り物の WACZ は末尾の控えより大きい（小さいと、丸ごと読む実装と区別できない）", () => {
    expect(waczWithPagesAtTail().length).toBeGreaterThan(TAIL_BYTES + 40 * 1024);
    expect(TAIL_BYTES).toBe(256 * 1024);
  });

  it("WARC の後ろの pages.jsonl は、末尾の 256 KiB を 1 度取るだけで読める（文字は丸ごと読んだときと同じ）", async () => {
    const zip = waczWithPagesAtTail();
    const { s3, ranges, sent } = fakeS3(zip);
    const got = await read(s3, zip);
    expect(got.kind).toBe("entry");
    expect(got.kind === "entry" && got.text).toBe(await readEntry(zip, PAGES_ENTRY_PATH));
    // 目次も pages.jsonl も控えから読む。要求は末尾の 1 回だけ
    expect(ranges).toEqual([`bytes=${String(zip.length - TAIL_BYTES)}-${String(zip.length - 1)}`]);
    expect(got.requests).toBeLessThanOrEqual(3);
    expect(got.requests).toBe(ranges.length);
    // 取った量は全体より小さい (丸ごと読んでいない)
    expect(got.bytes).toBe(TAIL_BYTES);
    expect(got.bytes).toBe(sent());
    expect(got.bytes).toBeLessThan(zip.length);
  });

  it("pages.jsonl が末尾の 256 KiB より前に在る WACZ でも読める（控えの外だけを追加で取る）", async () => {
    const zip = waczWithPagesAtHead();
    const { s3, ranges, sent } = fakeS3(zip);
    const got = await read(s3, zip);
    expect(got.kind === "entry" && got.text).toBe(PAGES);
    expect(ranges[0]).toBe(`bytes=${String(zip.length - TAIL_BYTES)}-${String(zip.length - 1)}`);
    // 追加の読みは、local header と中身
    expect(ranges.length).toBeGreaterThan(1);
    expect(got.requests).toBeLessThanOrEqual(3);
    expect(ranges.every((range) => range.startsWith("bytes="))).toBe(true);
    expect(got.bytes).toBe(sent());
    expect(got.bytes).toBeLessThan(zip.length);
  });

  it("末尾の控えより小さい WACZ は、全体を 1 度で取る", async () => {
    const zip = storedZip({ [PAGES_ENTRY_PATH]: PAGES, ...SMALL });
    const { s3, ranges } = fakeS3(zip);
    const got = await read(s3, zip);
    expect(got.kind === "entry" && got.text).toBe(PAGES);
    expect(ranges).toEqual([`bytes=0-${String(zip.length - 1)}`]);
  });

  it("WACZ が保管庫に無ければ「無い」", async () => {
    const { s3 } = fakeS3(undefined);
    expect(await read(s3, waczWithPagesAtTail())).toMatchObject({
      kind: "wacz_missing",
      bytes: 0,
    });
  });

  it("その名前の entry が無ければ「entry が無い」", async () => {
    const zip = storedZip({ "archive/data.browserhive.warc.gz": WARC, ...SMALL });
    const { s3 } = fakeS3(zip);
    expect(await read(s3, zip)).toMatchObject({ kind: "no_entry", requests: 1 });
  });

  it("解いた後が上限より大きい pages.jsonl は読まない（中身を取りに行かない）", async () => {
    // 控えの外に置く。読めば、追加の要求が出る
    const zip = waczWithPagesAtHead();
    const { s3, ranges } = fakeS3(zip);
    const got = await read(s3, zip, Buffer.byteLength(PAGES) - 1);
    expect(got).toMatchObject({ kind: "too_large", uncompressedSize: Buffer.byteLength(PAGES) });
    expect(ranges).toHaveLength(1);
    // ちょうど上限なら読む
    const exact = await read(fakeS3(zip).s3, zip, Buffer.byteLength(PAGES));
    expect(exact.kind).toBe("entry");
  });

  it("上限の既定は 8 MiB", async () => {
    expect(ENTRY_MAX_BYTES).toBe(8 * 1024 * 1024);
    const zip = waczWithPagesAtTail("a".repeat(ENTRY_MAX_BYTES + 1));
    expect(await read(fakeS3(zip).s3, zip)).toMatchObject({
      kind: "too_large",
      uncompressedSize: ENTRY_MAX_BYTES + 1,
    });
  });

  it("保管庫が答えなければ WaczStoreError を投げる", async () => {
    const { s3 } = fakeS3(new Error("connect ECONNREFUSED 127.0.0.1:8333"));
    await expect(read(s3, waczWithPagesAtTail())).rejects.toBeInstanceOf(WaczStoreError);
  });

  it("Range を聞かない保管庫（全文を返す）も WaczStoreError", async () => {
    const zip = waczWithPagesAtTail();
    const { s3 } = fakeS3(zip, { ignoreRange: true });
    await expect(read(s3, zip)).rejects.toBeInstanceOf(WaczStoreError);
  });
});
