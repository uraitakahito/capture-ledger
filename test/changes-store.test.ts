import { describe, expect, it } from "vitest";

import { changeStoreOf, comparedLineOf } from "../src/changes/store.js";
import { recordingDb } from "./recording-db.js";

/**
 * 前回からの変化の store の SQL の形。**Postgres で本当に通るか (skip locked・部分の一意・jsonb) は、CI の
 * `changes-smoke` が本物の DB に当てる** (この repo に DB の試験は無い)。
 */
const NOW = new Date("2026-11-12T04:05:00.000Z");
const CRAWL = "11111111-1111-4111-8111-111111111111";

describe("前回からの変化の store", () => {
  it("比べる行は after-behaviors の写し、無ければ文書の行 (after-load だけなら文書の行)", () => {
    expect(
      comparedLineOf([{ stage: null }, { stage: "after-load" }, { stage: "after-behaviors" }]),
    ).toEqual({
      stage: "after-behaviors",
    });
    expect(comparedLineOf([{ stage: "after-load" }, { stage: null }])).toEqual({ stage: null });
    expect(comparedLineOf([{ stage: "after-load" }])).toBeUndefined();
  });

  it("拾うのは、期限の切れた比べ中か、締まって 48 時間以内・digest の在る・全部検めた予定の回", async () => {
    const { db, queries } = recordingDb([
      [],
      [{ crawlId: CRAWL }],
      [{ id: CRAWL, scheduleId: "s", orgId: "acme", startedAt: NOW, recipeSha256: "r" }],
    ]);
    const run = await changeStoreOf(db).claimRunToCompare(NOW, 300_000);
    expect(run).toMatchObject({ crawlId: CRAWL, scheduleId: "s", recipeSha256: "r" });
    const [stale, fresh] = queries;
    expect(stale?.sql).toContain("state = 'comparing' and lease_until <");
    expect(stale?.sql).toContain("for update skip locked");
    expect(fresh?.sql).toContain("insert into crawl_changes");
    expect(fresh?.sql).toContain("c.schedule_id is not null");
    expect(fresh?.sql).toContain("c.state <> 'running'");
    expect(fresh?.sql).toContain("c.recipe_sha256 is not null");
    expect(fresh?.sql).toContain("make_interval(hours =>");
    expect(fresh?.sql).toContain("a.inspected_at is null");
    expect(fresh?.sql).toContain("on conflict (crawl_id) do nothing");
    expect(fresh?.parameters).toContain(new Date(NOW.getTime() + 300_000).toISOString());
  });

  it("前の回は、同じ予定・同じ撮り方・締まった・前に始まった回の一番新しい物", async () => {
    const { db, queries } = recordingDb([[{ id: "prev" }]]);
    const prev = await changeStoreOf(db).previousRun({
      crawlId: CRAWL,
      scheduleId: "s",
      orgId: "acme",
      startedAt: NOW,
      recipeSha256: "r",
    });
    expect(prev).toBe("prev");
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('"schedule_id" = $1');
    expect(sql).toContain('"recipe_sha256" = $2');
    expect(sql).toContain('"state" <> $3');
    expect(sql).toContain('order by "started_at" desc');
    expect(parameters.slice(0, 3)).toEqual(["s", "r", "running"]);
  });

  it("回のページは URL ごとに 1 つ、比べる行を選ぶ", async () => {
    const row = {
      archiveId: "a1",
      bucket: "b",
      objectKey: "k1",
      url: "https://site.test/",
      textSha256: "x",
      textWithheld: null,
    };
    const { db } = recordingDb([
      [
        { ...row, stage: null },
        { ...row, stage: "after-behaviors", textSha256: "y" },
        { ...row, archiveId: "a2", objectKey: "k2", stage: null, textSha256: "z" },
      ],
    ]);
    const pages = await changeStoreOf(db).comparedPages(CRAWL);
    expect(pages).toEqual([{ ...row, stage: "after-behaviors", textSha256: "y" }]);
  });

  it("比べ終えたら差分の行を入れ (重なれば何もしない)、比べ中の回だけを進める", async () => {
    const { db, queries } = recordingDb([[], []]);
    await changeStoreOf(db).finishCompare(
      CRAWL,
      {
        state: "diffed",
        prevCrawlId: "prev",
        pagesCompared: 1,
        pagesChanged: 1,
        pages: [
          {
            url: "u",
            archiveId: "a",
            prevArchiveId: "b",
            stage: null,
            state: "diffed",
            added: 1,
            removed: 1,
            hunks: [["-a", "+b"]],
          },
        ],
      },
      NOW,
    );
    const sqls = queries.map((q) => q.sql);
    expect(sqls[0]).toBe("begin");
    expect(sqls[1]).toContain('insert into "page_changes"');
    expect(sqls[1]).toContain('on conflict ("crawl_id", "url") do nothing');
    expect(sqls[2]).toContain('update "crawl_changes"');
    expect(sqls[2]).toContain('"state" = $');
    expect(queries[1]?.parameters).toContain('[["-a","+b"]]');
    expect(sqls[3]).toBe("commit");
  });

  it("要約を残すときは、変化の要約の一意 (034) にぶつかれば前の行を指す", async () => {
    const { db, queries } = recordingDb([[], [{ id: "d-old" }], []]);
    await changeStoreOf(db).finishSummary(
      CRAWL,
      {
        derivation: {
          orgId: "acme",
          crawlId: CRAWL,
          target: {},
          inputSha256: "i",
          model: "claude-opus-5-5",
          promptVersion: "change-v1",
          effort: "low",
          output: { headline: "h" },
          usage: {},
          usd: 0.01,
        },
        headline: "h",
        significance: "minor",
      },
      NOW,
    );
    const sqls = queries.map((q) => q.sql);
    expect(sqls[1]).toContain('on conflict ("input_sha256", "prompt_version") where "kind" = $');
    expect(sqls[2]).toContain('select "id" from "derivations"');
    expect(sqls[3]).toContain('update "crawl_changes"');
    expect(queries[3]?.parameters).toContain("d-old");
  });

  it("要約を待つ回は、差分あり・上限で待つ・期限の切れた要約中を、見直しの時刻が来た物から拾う", async () => {
    const { db, queries } = recordingDb([
      [{ crawlId: CRAWL, orgId: "acme", prevCrawlId: null, attempts: 0 }],
    ]);
    expect(await changeStoreOf(db).claimRunToSummarize(NOW, 300_000)).toMatchObject({
      crawlId: CRAWL,
    });
    expect(queries[0]?.sql).toContain("state in ('diffed', 'budget_wait')");
    expect(queries[0]?.sql).toContain("state = 'summarizing' and lease_until <");
    expect(queries[0]?.sql).toContain("next_attempt_at <=");
    expect(queries[0]?.sql).toContain("for update skip locked");
  });
});
