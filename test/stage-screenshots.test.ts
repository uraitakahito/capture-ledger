import { describe, expect, it } from "vitest";
import {
  locateStageScreenshots,
  pictureOf,
  ScreenshotRecordError,
} from "../src/archive/stage-screenshots.js";
import { screenshotWacz, shotUrl, webpBytes, type Shot } from "./stage-screenshot-wacz.js";

/**
 * 節目のスクリーンショットの在り処を求める (`archive/stage-screenshots.ts`)。WACZ は BrowserHive と同じ形に組む
 * (`stage-screenshot-wacz.ts`)。求めた位置の member を自分で解いて、名指しの絵かを照らす。
 */
const DOC = "http://site.test/a";
const load: Shot = {
  stage: "after-load",
  documentUrl: DOC,
  date: "2026-11-15T01:00:00.100Z",
  record: "urn:uuid:11111111-1111-4111-8111-111111111111",
  picture: webpBytes("L"),
};
const behaviors: Shot = {
  stage: "after-capture-scripts",
  documentUrl: DOC,
  date: "2026-11-15T01:00:05.300Z",
  record: "urn:uuid:22222222-2222-4222-8222-222222222222",
  picture: webpBytes("B", 80),
};

/** 求めた位置から、その場で絵を取り出す (読み出しのエンドポイントと同じ道)。 */
const pictureAt = (
  zip: Buffer,
  row: { waczOffset: number; waczLength: number; stage: string; recordId: string },
) => pictureOf(zip.subarray(row.waczOffset, row.waczOffset + row.waczLength), row);

describe("節目のスクリーンショットの在り処", () => {
  it("絵の在る時点は、WACZ の中の絶対の位置と長さと bytes を言い、その位置は名指しの絵を指す", async () => {
    const zip = screenshotWacz([load, behaviors]);
    const rows = await locateStageScreenshots(zip);
    expect(rows?.map((row) => [row.stage, row.kind])).toEqual([
      ["after-load", "located"],
      ["after-capture-scripts", "located"],
    ]);
    for (const [row, shot] of [
      [rows?.[0], load],
      [rows?.[1], behaviors],
    ] as const) {
      if (row?.kind !== "located") throw new Error("not located");
      expect(row.bytes).toBe(shot.picture.length);
      expect(row.recordId).toBe(shot.record);
      expect(pictureAt(zip, row).equals(shot.picture)).toBe(true);
    }
  });

  it("skipped の時点は理由だけを言い、索引を見ない", async () => {
    const rows = await locateStageScreenshots(
      screenshotWacz([
        { stage: "after-load", skipped: "secret" },
        { stage: "after-capture-scripts", skipped: "withheld" },
      ]),
    );
    expect(rows).toEqual([
      { stage: "after-load", kind: "skipped", skipped: "secret" },
      { stage: "after-capture-scripts", kind: "skipped", skipped: "withheld" },
    ]);
  });

  // CAPTURE-506: 古い取り込みは、時点を after-behaviors と書いた (URI の頭も)
  it("古い時点の名 after-behaviors は after-capture-scripts の行にし、絵は古い名の URI のまま照らして取れる", async () => {
    const old: Shot = { ...behaviors, stage: "after-behaviors" };
    const zip = screenshotWacz([load, old]);
    const rows = await locateStageScreenshots(zip);
    expect(rows?.map((row) => [row.stage, row.kind])).toEqual([
      ["after-load", "located"],
      ["after-capture-scripts", "located"],
    ]);
    const row = rows?.[1];
    if (row?.kind !== "located") throw new Error("not located");
    expect(pictureAt(zip, row).equals(old.picture)).toBe(true);
  });

  it("古い時点の名の skipped も、新しい名の行にする", async () => {
    expect(
      await locateStageScreenshots(
        screenshotWacz([{ stage: "after-behaviors", skipped: "withheld" }]),
      ),
    ).toEqual([{ stage: "after-capture-scripts", kind: "skipped", skipped: "withheld" }]);
  });

  it("新しい時点の名で照らしても、after-load の絵の URI は通さない", async () => {
    const zip = screenshotWacz([load]);
    const rows = await locateStageScreenshots(zip);
    const row = rows?.[0];
    if (row?.kind !== "located") throw new Error("not located");
    expect(() => pictureAt(zip, { ...row, stage: "after-capture-scripts" })).toThrow(
      ScreenshotRecordError,
    );
  });

  it("欄の無い datapackage は undefined（行を書かない）", async () => {
    expect(await locateStageScreenshots(screenshotWacz(null))).toBeUndefined();
  });

  it("同じ秒に撮った 2 つの時点を、url で取り違えない", async () => {
    // 2 つの時点が同じ秒で、索引では capture scripts の後の行が先。秒だけで選ぶと、読み込みの後の時点が別の絵を指す
    const same = { ...behaviors, date: "2026-11-15T01:00:00.900Z" };
    const zip = screenshotWacz([load, same], { indexOrder: [1, 0] });
    const rows = await locateStageScreenshots(zip);
    const first = rows?.[0];
    if (first?.kind !== "located") throw new Error(`not located: ${JSON.stringify(first)}`);
    expect(pictureAt(zip, first).equals(load.picture)).toBe(true);
  });

  it("索引に行が無ければ no-index-line", async () => {
    const rows = await locateStageScreenshots(
      screenshotWacz([load], { dropIndexFor: ["after-load"] }),
    );
    expect(rows).toEqual([{ stage: "after-load", kind: "problem", problem: "no-index-line" }]);
  });

  it("WARC が deflate なら warc-not-stored", async () => {
    const rows = await locateStageScreenshots(
      screenshotWacz([load], { zip: { deflate: ["archive/data-000.browserhive.warc.gz"] } }),
    );
    expect(rows).toEqual([{ stage: "after-load", kind: "problem", problem: "warc-not-stored" }]);
  });

  it("位置のレコードが別の record なら record-mismatch", async () => {
    const other = {
      ...load,
      headers: {
        "WARC-Type": "resource",
        "WARC-Record-ID": "<urn:uuid:99999999-9999-4999-8999-999999999999>",
        "WARC-Target-URI": shotUrl("after-load", DOC),
        "Content-Type": "image/webp",
      },
    };
    expect(await locateStageScreenshots(screenshotWacz([other]))).toEqual([
      { stage: "after-load", kind: "problem", problem: "record-mismatch" },
    ]);
  });

  it("2 本目の WARC の絵は、その本の位置から数える", async () => {
    const zip = screenshotWacz([load, { ...behaviors, warc: "data-001.browserhive.warc.gz" }]);
    const rows = await locateStageScreenshots(zip);
    const second = rows?.[1];
    if (second?.kind !== "located") throw new Error("not located");
    expect(pictureAt(zip, second).equals(behaviors.picture)).toBe(true);
  });

  it("local header の extra の長さを位置に数える", async () => {
    const zip = screenshotWacz([load], {
      zip: { localExtra: { "archive/data-000.browserhive.warc.gz": Buffer.alloc(8, 0x55) } },
    });
    const row = (await locateStageScreenshots(zip))?.[0];
    if (row?.kind !== "located") throw new Error(`not located: ${JSON.stringify(row)}`);
    expect(pictureAt(zip, row).equals(load.picture)).toBe(true);
  });

  it("知らない skipped の理由も、そのまま通す", async () => {
    expect(
      await locateStageScreenshots(
        screenshotWacz([{ stage: "after-load", skipped: "new-reason" }]),
      ),
    ).toEqual([{ stage: "after-load", kind: "skipped", skipped: "new-reason" }]);
  });

  it("項目の形が半端なら entry-invalid、同じ時点の 2 つ目は捨てる", async () => {
    // bytes の無い項目と、同じ時点の 2 つ目
    const rows = await locateStageScreenshots(
      screenshotWacz([load], {
        datapackage: {
          "browserhive:capture": {
            screenshots: [
              {
                stage: "after-load",
                url: shotUrl("after-load", DOC),
                date: load.date,
                record: load.record,
              },
              { stage: "after-load", skipped: "secret" },
            ],
          },
        },
      }),
    );
    expect(rows).toEqual([{ stage: "after-load", kind: "problem", problem: "entry-invalid" }]);
  });
});

describe("位置の member から絵を取り出す", () => {
  it("位置が別の時点のレコードを指していたら断る", async () => {
    const zip = screenshotWacz([load, behaviors]);
    const rows = await locateStageScreenshots(zip);
    const first = rows?.[0];
    if (first?.kind !== "located") throw new Error("not located");
    // 読み込みの後の位置を、capture scripts の後として読む
    expect(() =>
      pictureOf(zip.subarray(first.waczOffset, first.waczOffset + first.waczLength), {
        stage: "after-capture-scripts",
        recordId: first.recordId,
      }),
    ).toThrow(ScreenshotRecordError);
  });

  it("本文が WebP でなければ断る", async () => {
    const zip = screenshotWacz([{ ...load, picture: Buffer.from("not a picture at all") }]);
    expect(await locateStageScreenshots(zip)).toEqual([
      { stage: "after-load", kind: "problem", problem: "record-mismatch" },
    ]);
  });
});
