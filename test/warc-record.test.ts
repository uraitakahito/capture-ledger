import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gunzipMember, parseWarcRecord } from "../src/archive/warc-record.js";
import { warcRecord } from "./stage-screenshot-wacz.js";

/** WARC のレコード 1 つ (`archive/warc-record.ts`)。BrowserHive と同じ直列化の物 (`stage-screenshot-wacz.ts`) を読む。 */
describe("WARC のレコード 1 つを読む", () => {
  const block = Buffer.from("RIFF....WEBPbody");
  const raw = warcRecord({ "WARC-Type": "resource", "WARC-Target-URI": "urn:x" }, block);

  it("gzip の 1 member を解き、見出しと本文に分ける（見出しの名前は小文字）", () => {
    const record = parseWarcRecord(gunzipMember(gzipSync(raw), 1024));
    expect(record.headers.get("warc-type")).toBe("resource");
    expect(record.headers.get("warc-target-uri")).toBe("urn:x");
    expect(record.body.equals(block)).toBe(true);
  });

  it("本文は Content-Length の長さだけで、終わりの CRLF CRLF を含めない", () => {
    expect(parseWarcRecord(raw).body.length).toBe(block.length);
  });

  it("1 バイト足りない member は断る", () => {
    const member = gzipSync(raw);
    expect(() => gunzipMember(member.subarray(0, member.length - 1), 1024)).toThrow();
  });

  it("後ろにもう 1 レコード続けば断る（範囲が長すぎる）", () => {
    const two = Buffer.concat([gzipSync(raw), gzipSync(raw)]);
    expect(() => parseWarcRecord(gunzipMember(two, 4096))).toThrow(/not \d+/);
  });

  it("解いた大きさが上限を超えれば断る", () => {
    expect(() => gunzipMember(gzipSync(raw), 16)).toThrow();
  });

  it("WARC の頭が無ければ断る", () => {
    expect(() => parseWarcRecord(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"))).toThrow(
      /not a WARC record/,
    );
  });
});
