import { describe, expect, it } from "vitest";

import { changeReadsOf } from "../src/changes/reads.js";
import { recordingDb } from "./recording-db.js";

/**
 * 詳細の答えの読み出し (CAPTURE-236)。同じだったページは、周回と同じ組から `page_changes` に在る URL を除いた物。
 * Postgres で本当に通るかは CI の `changes-smoke`。
 */
const CRAWL = "11111111-1111-4111-8111-111111111111";
const PREV = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2026-11-12T04:00:00.000Z");

const runRow = (prevCrawlId: string | null) => ({
  crawlId: CRAWL,
  scheduleId: "s",
  scheduleName: "毎朝",
  startedAt: AT,
  scheduledFor: AT,
  prevCrawlId,
  prevStartedAt: prevCrawlId === null ? null : new Date("2026-11-11T04:00:00.000Z"),
  prevScheduledFor: null,
  state: prevCrawlId === null ? "no_previous" : "diffed",
  pagesCompared: 3,
  pagesChanged: 1,
  significance: null,
  headline: null,
  error: null,
  archiveIds: [],
});
const pageRow = (run: string, url: string, sha: string) => ({
  archiveId: `${run}-${url}`,
  bucket: "b",
  objectKey: `${run}-${url}.wacz`,
  url,
  capturedAt: AT,
  browserhiveVersion: "29.0.2",
  stage: "after-behaviors",
  textSha256: sha,
  textWithheld: null,
});

describe("変化の詳細の読み出し", () => {
  it("同じだったページは、比べた組のうち page_changes に無い物 (空行だけ違う組も入る)。URL の順", async () => {
    const { db, queries } = recordingDb([
      [runRow(PREV)],
      [],
      [{ url: "https://site.test/b", stage: "after-behaviors", state: "diffed", hunks: [] }],
      [
        pageRow("now", "https://site.test/c", "blank-new"),
        pageRow("now", "https://site.test/b", "new"),
        pageRow("now", "https://site.test/a", "same"),
        pageRow("now", "https://site.test/only-now", "x"),
      ],
      [
        pageRow("prev", "https://site.test/a", "same"),
        pageRow("prev", "https://site.test/b", "old"),
        pageRow("prev", "https://site.test/c", "blank-old"),
      ],
    ]);
    const detail = await changeReadsOf(db).runDetail(CRAWL);
    expect(detail?.unchanged).toEqual([
      {
        url: "https://site.test/a",
        stage: "after-behaviors",
        after: {
          archiveId: "now-https://site.test/a",
          objectKey: "now-https://site.test/a.wacz",
          sourceUrl: "https://site.test/a",
          capturedAt: AT,
          browserhiveVersion: "29.0.2",
        },
        before: expect.objectContaining({ archiveId: "prev-https://site.test/a" }) as unknown,
      },
      expect.objectContaining({
        url: "https://site.test/c",
        after: expect.objectContaining({ archiveId: "now-https://site.test/c" }) as unknown,
      }) as unknown,
    ]);
    // 問い合わせの順: 回 (前の回の時刻を left join) → 要約 → page_changes → 今回と前の回のページ
    expect(queries[0]?.sql).toContain(
      'left join "crawls" as "p" on "p"."id" = "cc"."prev_crawl_id"',
    );
    expect(queries[2]?.sql).toContain('from "page_changes"');
    expect(queries.slice(3).map((q) => q.parameters[0])).toEqual([CRAWL, PREV]);
  });

  it("前の回が無ければ、ページを読まず、同じだったページは空", async () => {
    const { db, queries } = recordingDb([[runRow(null)], [], []]);
    const detail = await changeReadsOf(db).runDetail(CRAWL);
    expect(detail?.unchanged).toEqual([]);
    expect(detail?.run.prevStartedAt).toBeNull();
    expect(queries).toHaveLength(3);
  });

  it("無い回は undefined", async () => {
    const { db } = recordingDb([[]]);
    expect(await changeReadsOf(db).runDetail(CRAWL)).toBeUndefined();
  });
});
