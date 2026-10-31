import { describe, it, expect } from "vitest";
import { parseS3Uri } from "../src/archive/s3-uri.js";

describe("parseS3Uri", () => {
  it("splits a plain bucket/key URI", () => {
    expect(parseS3Uri("s3://browserhive/550e8400_abc123de_smoke.wacz")).toEqual({
      bucket: "browserhive",
      key: "550e8400_abc123de_smoke.wacz",
    });
  });

  // BrowserHive の `--s3-key-prefix` は鍵の中に `/` を入れるので、bucket を
  // 区切るのは最初の 1 つだけ。
  it("keeps slashes that belong to the key", () => {
    expect(parseS3Uri("s3://browserhive/2026/07/29/task.wacz")).toEqual({
      bucket: "browserhive",
      key: "2026/07/29/task.wacz",
    });
  });

  it("rejects a URI with another scheme", () => {
    expect(() => parseS3Uri("https://site.test/a.wacz")).toThrow(/not an s3:\/\/ URI/);
  });

  // ローカルの成果物ストアは URI ではなく絶対パスを返す。そこから "" という名前の
  // bucket を導くより、大きな音を立てて失敗するほうがよい。
  it("rejects an absolute filesystem path", () => {
    expect(() => parseS3Uri("/var/artifacts/a.wacz")).toThrow(/not an s3:\/\/ URI/);
  });

  it("rejects a bucket with no key", () => {
    expect(() => parseS3Uri("s3://browserhive")).toThrow(/no bucket or no key/);
    expect(() => parseS3Uri("s3://browserhive/")).toThrow(/no bucket or no key/);
  });

  it("rejects a key with no bucket", () => {
    expect(() => parseS3Uri("s3:///key-only.wacz")).toThrow(/no bucket or no key/);
  });
});
