/**
 * 前のクロールのリンクの埋め直し (`crawl/links-backfill.ts`・`039`)。
 *
 * 見るのは、飛ばす条件と、**段の報告と同じ行を書くこと**。本物の Postgres と保管庫での確かめは、dev で
 * 埋め直して数える (段の報告が書いた行を消して埋め直し、同じになるかを見る)。
 */
import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";

import { backfillCrawl, type BackfillCrawl } from "../src/crawl/links-backfill.js";
import { cutOf, cutOfRecorded } from "../src/crawl/link-outcomes.js";
import { recordingDb } from "./recording-db.js";

const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const SITE = "https://site.test";
const crawl = (over: Partial<BackfillCrawl> = {}): BackfillCrawl => ({
  id: CRAWL,
  seeds: [`${SITE}/hub`],
  rules: [{ follow: "same-origin" }],
  maxDepth: 1,
  stopReason: "max_pages",
  ...over,
});

/** 保管庫の代役。鍵 → 中身。無い鍵は NoSuchKey。 */
const store = (objects: Record<string, unknown>): S3Client =>
  ({
    send: (command: { input: { Key: string } }) => {
      const body = objects[command.input.Key];
      if (body === undefined) {
        return Promise.reject(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));
      }
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(JSON.stringify(body)) },
      });
    },
  }) as unknown as S3Client;

const HUB = {
  "hub.result.json": { artifacts: { links: "s3://b/hub.links.json" } },
  "hub.links.json": {
    finalUrl: `${SITE}/hub`,
    links: [
      { href: `${SITE}/leaf/1`, text: "leaf 1", rel: null },
      { href: `${SITE}/leaf/2`, text: "", rel: null },
      { href: "https://other.test/x", text: "", rel: null },
    ],
  },
};
// 撮ったページ (取り込みの答えの在り処つき) と、クロールのページの URL → 見つけたページ
const pages = [{ id: "10", url: `${SITE}/hub`, depth: 0, manifestKey: "hub.result.json" }];
const parents = [
  { url: `${SITE}/hub`, discoveredFrom: null },
  { url: `${SITE}/leaf/1`, discoveredFrom: "10" },
];

describe("入らなかった理由（埋め直し）", () => {
  it("深さの内で、止まった理由が枚数なら、段の報告と同じ「枚数で切った」", () => {
    const at = { nextDepth: 1, maxDepth: 1 };
    expect(cutOfRecorded({ ...at, stopReason: "max_pages" })).toBe("max_pages");
    expect(cutOfRecorded({ ...at, stopReason: "max_pages" })).toBe(cutOf({ ...at, closed: false }));
  });

  it("深さを超えていれば、止まった理由が枚数でも「深さで切った」（段の報告と同じ）", () => {
    const at = { nextDepth: 2, maxDepth: 1 };
    expect(cutOfRecorded({ ...at, stopReason: "max_pages" })).toBe("max_depth");
    expect(cutOfRecorded({ ...at, stopReason: "max_pages" })).toBe(cutOf({ ...at, closed: false }));
  });

  it("深さの内で、止まった理由が枚数でなければ「締まっていた」", () => {
    expect(cutOfRecorded({ nextDepth: 1, maxDepth: 1, stopReason: "failed" })).toBe("closed");
    expect(cutOfRecorded({ nextDepth: 1, maxDepth: 1, stopReason: null })).toBe("closed");
  });
});

describe("クロール 1 本を埋める", () => {
  it("数えるだけなら、行の数を返して何も書かない", async () => {
    const { db, queries } = recordingDb([pages, parents]);
    const result = await backfillCrawl({ db, s3: store(HUB), bucket: "b" }, crawl(), false);
    expect(result).toEqual({ kind: "filled", rows: 3, pages: 1, dropped: 0 });
    expect(queries.some((query) => /^(insert|update|delete)/.test(query.sql))).toBe(false);
  });

  it("書くときは、段の報告と同じ行を、置き換えで書き、一覧の数を別々の URL の数にする", async () => {
    const { db, queries } = recordingDb([pages, parents, [], [], [], [{ n: 2 }]]);
    const result = await backfillCrawl({ db, s3: store(HUB), bucket: "b" }, crawl(), true);
    expect(result.kind).toBe("filled");
    const written = queries.find((query) => query.sql.startsWith('insert into "crawl_links"'));
    // 行: クロール・リンクのあったページ・順・URL・ホスト名・文字・規則・どうなったか (段の報告の試験と同じ並び)
    expect(written?.parameters).toEqual([
      ...[CRAWL, "10", 0, `${SITE}/leaf/1`, "site.test", "leaf 1", 1, "followed"],
      ...[CRAWL, "10", 1, `${SITE}/leaf/2`, "site.test", "", 1, "max_pages"],
      ...[CRAWL, "10", 2, "https://other.test/x", "other.test", "", 0, "skip"],
    ]);
    const sqls = queries.map((query) => query.sql);
    const removed = sqls.findIndex((sql) => sql.startsWith('delete from "crawl_links"'));
    expect(removed).toBeGreaterThan(sqls.indexOf("begin"));
    expect(sqls.indexOf(written!.sql)).toBeGreaterThan(removed);
    const counted = queries.find((query) =>
      query.sql.startsWith('update "crawls" set "pages_discovered"'),
    );
    expect(counted?.parameters).toEqual([2, CRAWL]);
    expect(sqls.indexOf(counted!.sql)).toBeLessThan(sqls.indexOf("commit"));
  });

  it(".links.json が保管庫に無ければ、書かずに飛ばす", async () => {
    const { db, queries } = recordingDb([pages, parents]);
    const result = await backfillCrawl(
      { db, s3: store({ "hub.result.json": HUB["hub.result.json"] }), bucket: "b" },
      crawl(),
      true,
    );
    expect(result).toEqual({ kind: "skipped", why: "保管庫に s3://b/hub.links.json が無い" });
    expect(queries.some((query) => /^(insert|update|delete)/.test(query.sql))).toBe(false);
  });

  it("取り込みの答え (.result.json) が保管庫に無ければ、飛ばす", async () => {
    const { db } = recordingDb([pages, parents]);
    const result = await backfillCrawl({ db, s3: store({}), bucket: "b" }, crawl(), true);
    expect(result).toEqual({ kind: "skipped", why: "保管庫に hub.result.json が無い" });
  });

  it("links を頼んでいない取り込みは、読んだページに数えず、行も作らない（リンクなしと書かない）", async () => {
    const { db } = recordingDb([pages, parents]);
    const result = await backfillCrawl(
      { db, s3: store({ "hub.result.json": { artifacts: {} } }), bucket: "b" },
      crawl(),
      false,
    );
    expect(result).toEqual({ kind: "filled", rows: 0, pages: 0, dropped: 0 });
  });

  it("深さを超える段のリンクは、止まった理由が枚数でも「深さで切った」", async () => {
    const { db, queries } = recordingDb([pages, parents, [], [], [], [{ n: 1 }]]);
    await backfillCrawl({ db, s3: store(HUB), bucket: "b" }, crawl({ maxDepth: 0 }), true);
    const written = queries.find((query) => query.sql.startsWith('insert into "crawl_links"'));
    expect(written?.parameters[15]).toBe("max_depth");
  });

  it("規則が読めないクロールは飛ばす", async () => {
    const { db } = recordingDb([]);
    const result = await backfillCrawl(
      { db, s3: store(HUB), bucket: "b" },
      crawl({ rules: [{ follow: "ftp://x" }] }),
      true,
    );
    expect(result).toEqual({ kind: "skipped", why: "規則が読めない" });
  });
});
