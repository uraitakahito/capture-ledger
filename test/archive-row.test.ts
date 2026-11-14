import { describe, it, expect } from "vitest";
import { admitArchive, archiveRow } from "../src/archive/admit.js";
import type { CaptureResultReport } from "../src/archive/manifest.js";
import { composeReplayBundle } from "../src/replay-bundle/format.js";
import { recordingDb } from "./recording-db.js";

/**
 * 取り込みの報告から capture-ledger の 1 行を組む写像。
 *
 * ここが答えるのは 1 つ —— **署名の有無が capture-ledger から読めるか**。読めないと、
 * 10,000 件の中から「証拠として使える形のもの」を探すのに 10,000 回 zip を
 * 開くことになる。
 *
 * `signed` は 3 状態で、`false` と `null` を潰してはならない:
 *
 *   true   —— 署名を求め、付いた
 *   false  —— 署名の報告が届き、付いていなかった (配備の異常)
 *   null   —— そもそも求めていない (正常)
 */
const LOCATION = { bucket: "browserhive", key: "task_.wacz" };
const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";

const report = (over: Partial<CaptureResultReport> = {}): CaptureResultReport => ({
  taskId: "550e8400-e29b-41d4-a716-446655440000",
  url: "https://site.test/",
  labels: [],
  status: "success",
  timestamp: "2026-09-08T00:00:00.000Z",
  captureProcessingTimeMs: 0,
  ...over,
});

describe("archiveRow", () => {
  it("署名された取り込みは signed: true で capture-ledger に載る", () => {
    expect(archiveRow(report({ signature: { signed: true } }), LOCATION, CRAWL).signed).toBe(true);
  });

  /**
   * 求めていない取り込みでは報告ごと来ない。`?? null` を落として `?.` だけにすると
   * `undefined` が入り、Kysely は列を省いて既定値に落とす —— 「報告が届かなかった」が
   * 「NULL」ではなく「既定」に化ける。
   */
  it("署名を求めていない取り込みは null になる（undefined ではない）", () => {
    const row = archiveRow(report(), LOCATION, CRAWL);
    expect(row.signed).toBeNull();
    expect(Object.hasOwn(row, "signed")).toBe(true);
  });

  /** `false` と `null` は別の主張。潰すと配備の異常が正常と同じ見た目になる。 */
  it("署名の報告が届いて付いていなければ false で、null と区別される", () => {
    expect(archiveRow(report({ signature: { signed: false } }), LOCATION, CRAWL).signed).toBe(
      false,
    );
  });

  it("completeness も同じ 3 状態を保つ", () => {
    expect(archiveRow(report(), LOCATION, CRAWL).waczComplete).toBeNull();
    const complete = { complete: true, bodylessUrls: [], truncatedUrls: [] };
    expect(archiveRow(report({ completeness: complete }), LOCATION, CRAWL).waczComplete).toBe(true);
  });

  /**
   * クロールの id (`027`) は呼ぶ側が記録から渡す。報告の `correlationId` はクロールが crawl id を渡す申し合わせで、
   * 投げ方が変わると黙って別の値になる —— 見本はわざと別の値にしてある。
   */
  it("クロールの id は渡された物を書き、報告の correlationId からは読まない", () => {
    const row = archiveRow(report({ correlationId: "something-else" }), LOCATION, CRAWL);
    expect(row.crawlId).toBe(CRAWL);
    expect(row.correlationId).toBe("something-else");
  });

  it("クロールの外の取り込みは crawlId が null（undefined ではない）", () => {
    const row = archiveRow(report(), LOCATION, null);
    expect(row.crawlId).toBeNull();
    expect(Object.hasOwn(row, "crawlId")).toBe(true);
  });
});

/**
 * 鍵は BrowserHive の報告のまま (CAPTURE-341)。BrowserHive v31.0.0 から WACZ の名前は `….browserhive.wacz` になり、
 * 保管庫には印の無い古い名前と混ざる。capture-ledger は鍵を組まず切らないので、どちらの名前も変えずに運ぶ ——
 * 拡張子を `.wacz` と決め打ちして削る・付け直す書き方が入ると、ここが赤になる。
 */
describe("鍵を組まず切らない（CAPTURE-341）", () => {
  it("….browserhive.wacz の報告を受け入れると、archives.object_key と合本の name が鍵の最後の段をそのまま持つ", async () => {
    const taskId = "550e8400-e29b-41d4-a716-446655440000";
    const file = `${taskId}_${CRAWL}.browserhive.wacz`;
    const key = `org/acme/2026-11/${file}`;
    const { db, queries } = recordingDb([[{ id: "a1" }]]);

    await admitArchive(
      db,
      report({ taskId, artifacts: { wacz: `s3://browserhive/${key}` } }),
      "acme",
      null,
      CRAWL,
    );

    const insert = queries.find((q) => q.sql.startsWith('insert into "archives"'));
    const columns = /\(([^)]*)\) values/u
      .exec(insert?.sql ?? "")?.[1]
      ?.split(", ")
      .map((column) => column.replaceAll('"', ""));
    const objectKey = insert?.parameters[columns?.indexOf("object_key") ?? -1];
    expect(objectKey).toBe(key);

    const bundle = composeReplayBundle({
      crawlId: CRAWL,
      orgId: "acme",
      rev: 1,
      depth: 0,
      builtAt: new Date("2026-11-14T00:00:00.000Z"),
      crawlState: "succeeded",
      stopReason: "completed",
      finishedAt: new Date("2026-11-14T00:00:00.000Z"),
      archives: [
        {
          id: "a1",
          objectKey: String(objectKey),
          waczSha256: "0".repeat(64),
          indexEmpty: false,
          capturedAt: new Date("2026-11-14T00:00:00.000Z"),
          depth: 0,
        },
      ],
      pages: [
        {
          archiveId: "a1",
          ordinal: 0,
          pageId: null,
          url: "http://site.test/",
          ts: "2026-11-14T00:00:00.000Z",
          title: null,
          stage: null,
          keys: ["http://site.test/"],
        },
      ],
    });
    expect(bundle.replayJson.resources.map((resource) => resource.name)).toEqual([file]);
    expect(bundle.pagesJson.pages.map((page) => [page.filename, page.id])).toEqual([
      [file, `${file}#0`],
    ]);
  });
});
