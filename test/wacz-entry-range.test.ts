import { describe, expect, it } from "vitest";
import { storedEntryRange } from "../src/archive/wacz.js";
import { storedZip } from "./zip.js";

/**
 * zip の entry の中身の在り処 (`archive/wacz.ts` の `storedEntryRange`)。local header を直に読む —— 中身は
 * local header の 30 バイトと、名前と、extra の後ろから始まる。
 */
describe("zip の entry の中身の在り処", () => {
  it("stored の entry の中身は、local header の 30 バイトと名前と extra の後ろから始まる", async () => {
    const zip = storedZip({ "a.txt": "first", "archive/data-000.warc.gz": "second-entry" });
    const range = await storedEntryRange(zip, "archive/data-000.warc.gz");
    expect(range).toEqual({
      start: 30 + "a.txt".length + 5 + 30 + "archive/data-000.warc.gz".length,
      size: 12,
      method: 0,
    });
    expect(zip.subarray(range!.start, range!.start + range!.size).toString()).toBe("second-entry");
  });

  it("local の extra が中央ディレクトリと違う長さでも、local の長さで数える", async () => {
    const zip = storedZip(
      { "archive/data-000.warc.gz": "payload" },
      { localExtra: { "archive/data-000.warc.gz": Buffer.alloc(8, 0x55) } },
    );
    const range = await storedEntryRange(zip, "archive/data-000.warc.gz");
    expect(zip.subarray(range!.start, range!.start + range!.size).toString()).toBe("payload");
  });

  it("deflate の entry は方式を 8 と言う（位置を Range で読めない）", async () => {
    const zip = storedZip(
      { "archive/data-000.warc.gz": "x".repeat(200) },
      { deflate: ["archive/data-000.warc.gz"] },
    );
    expect((await storedEntryRange(zip, "archive/data-000.warc.gz"))?.method).toBe(8);
  });

  it("無い entry は undefined", async () => {
    expect(
      await storedEntryRange(storedZip({ "a.txt": "a" }), "archive/data-000.warc.gz"),
    ).toBeUndefined();
  });
});
