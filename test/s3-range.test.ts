import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { getObjectRange } from "../src/archive/s3.js";

/** 保管庫を Range で 1 本読む (`archive/s3.ts` の `getObjectRange`)。偽の保管庫は、頼まれた Range を記録して切って返す。 */
const fakeS3 = (object: Buffer | undefined, opts: { ignoreRange?: boolean } = {}) => {
  const ranges: (string | undefined)[] = [];
  const s3 = {
    send: (command: { input: { Range?: string } }) => {
      ranges.push(command.input.Range);
      if (object === undefined) {
        return Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? "");
      const bytes =
        opts.ignoreRange === true || m === null
          ? object
          : object.subarray(Number(m[1]), Number(m[2]) + 1);
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)) },
      });
    },
  };
  return { s3: s3 as unknown as S3Client, ranges };
};

describe("保管庫を Range で 1 本読む", () => {
  const object = Buffer.from("0123456789".repeat(20));

  it("Range は bytes=始め-(始め+長さ-1) で頼む", async () => {
    const { s3, ranges } = fakeS3(object);
    const got = await getObjectRange(s3, "b", "k", 100, 50);
    expect(ranges).toEqual(["bytes=100-149"]);
    expect(got?.equals(object.subarray(100, 150))).toBe(true);
  });

  it("返った長さが頼んだ長さと違えば投げる（Range を聞かない保管庫）", async () => {
    const { s3 } = fakeS3(object, { ignoreRange: true });
    await expect(getObjectRange(s3, "b", "k", 100, 50)).rejects.toThrow(/not the 50 asked/);
  });

  it("無いオブジェクトは undefined", async () => {
    const { s3 } = fakeS3(undefined);
    expect(await getObjectRange(s3, "b", "k", 0, 10)).toBeUndefined();
  });

  it("長さ 0 や負の始めは、保管庫に訊く前に断る", async () => {
    const { s3, ranges } = fakeS3(object);
    await expect(getObjectRange(s3, "b", "k", 0, 0)).rejects.toThrow();
    await expect(getObjectRange(s3, "b", "k", -1, 10)).rejects.toThrow();
    expect(ranges).toEqual([]);
  });
});
