import { describe, expect, it } from "vitest";
import { readManifest } from "../src/archive/manifest.js";

/**
 * BrowserHive v12 が書くとおりの `.result.json`: `POST /captures` の応答の `report` を
 * そのまま JSON にした物で、enum は契約 (OpenAPI) の綴り。手で書いている ——
 * 生成物から作ると、生成物が自分自身と一致することしか証明しないので。
 */
const v12Manifest = {
  taskId: "01J8Z0",
  correlationId: "ab12cd34",
  url: "https://site.test/",
  labels: ["news"],
  status: "success",
  timestamp: "2026-08-19T00:00:00.000Z",
  captureProcessingTimeMs: 4210,
  artifacts: { wacz: "s3://archives/01J8Z0.wacz" },
  completeness: { complete: true, bodylessUrls: [], truncatedUrls: [] },
};

describe("readManifest", () => {
  it("v12 の manifest (HTTP の応答の report と同じ JSON) を読む", () => {
    const report = readManifest(v12Manifest);

    expect(report.status).toBe("success");
    expect(report.taskId).toBe("01J8Z0");
    expect(report.artifacts?.wacz).toBe("s3://archives/01J8Z0.wacz");
    expect(report.completeness?.complete).toBe(true);
    expect(report.labels).toEqual(["news"]);
  });

  /**
   * v3〜v11 の manifest は protobuf JSON で、status を `"CAPTURE_STATUS_SUCCESS"` と綴っていた。
   * 契約に無い綴りなので断る —— reconcile は理解できていない値の上にアーカイブを登録するの
   * ではなく、飛ばしてそう言う。v11 までの server が bucket に残した物は登録されないままになる。
   * それは転送方式を変えたことの意図した代償であって、見落としではない。
   */
  it("v11 までの protobuf JSON (CAPTURE_STATUS_SUCCESS) は、status の綴りを挙げて断る", () => {
    expect(() => readManifest({ ...v12Manifest, status: "CAPTURE_STATUS_SUCCESS" })).toThrow(
      /CaptureResultReport: data\/status must be equal to one of the allowed values/,
    );
  });

  /**
   * 契約の既定値は、欠けていれば既定値として読む。BrowserHive v12.2.0 で
   * `waczStats.totalSkippedUrlPolicy` が required（既定 0）になり、それより前の server が
   * 書いた manifest はこの欄を持たない（2026-09-26 に共有の保管庫で数えると、1677 本のうち
   * 384 本）。Smithy の `@default(0)` は「無ければ 0」なので、照らす前に既定値を補う。
   */
  it("v12.2.0 より前の manifest（totalSkippedUrlPolicy が無い）も読み、既定の 0 とする", () => {
    const report = readManifest({
      ...v12Manifest,
      waczStats: {
        totalRecorded: 2,
        totalBlocked: 0,
        totalDenied: 0,
        totalSkippedContentType: 0,
        totalTruncatedTooLarge: 0,
        totalTruncatedTaskCap: 0,
        totalFailed: 0,
        totalIncomplete: 0,
        totalBodyBytes: 187,
      },
    });
    expect(report.waczStats?.totalSkippedUrlPolicy).toBe(0);
  });

  /**
   * v20.0.0 で `waczStats.totalNotIntercepted`（本文をバイト列で読めなかった応答の数）が required
   * （既定 0）になった。それより前の server の manifest は持たないので、既定の 0 として読む。
   * `completeness.uninterceptedUrls` は任意の欄なので、無くても通る。
   */
  /** v12.2.0〜v19 の server が書いた `waczStats`。`totalNotIntercepted` を持たない。 */
  const v19Stats = {
    totalRecorded: 2,
    totalBlocked: 0,
    totalDenied: 0,
    totalSkippedContentType: 0,
    totalSkippedUrlPolicy: 0,
    totalTruncatedTooLarge: 0,
    totalTruncatedTaskCap: 0,
    totalFailed: 0,
    totalIncomplete: 0,
    totalBodyBytes: 187,
  };

  it("v20.0.0 より前の manifest（totalNotIntercepted も uninterceptedUrls も無い）を読み、数は既定の 0 とする", () => {
    const report = readManifest({ ...v12Manifest, waczStats: v19Stats });
    expect(report.waczStats?.totalNotIntercepted).toBe(0);
    expect(report.completeness?.uninterceptedUrls).toBeUndefined();
  });

  it("v20.0.0 の manifest（読めなかった本文が在る）を読む", () => {
    const report = readManifest({
      ...v12Manifest,
      waczStats: { ...v19Stats, totalNotIntercepted: 1 },
      completeness: {
        complete: false,
        bodylessUrls: [],
        truncatedUrls: [],
        uninterceptedUrls: ["https://site.test/feed"],
      },
    });
    expect(report.waczStats?.totalNotIntercepted).toBe(1);
    expect(report.completeness?.uninterceptedUrls).toEqual(["https://site.test/feed"]);
  });

  /** v17 はページから作るものを撮った文書を名乗る。形式を伏せた取り込みも success のまま。 */
  it("v17 の manifest（形式を伏せ、document が理由を名乗る）を読む", () => {
    const report = readManifest({
      ...v12Manifest,
      document: { url: "https://site.test/private/", withheld: "no-archive" },
    });
    expect(report.document).toEqual({
      url: "https://site.test/private/",
      withheld: "no-archive",
    });
  });

  /**
   * v18 は、要求した頁を deny が止めた取り込みを success で返す。成果物は 1 つも無く、
   * httpStatusCode も無い。document は止めた URL と withheld: "deny" を名乗る。
   */
  it("v18 の manifest（要求した頁を deny が止め、成果物が無い）を読む", () => {
    const report = readManifest({
      taskId: "01J8Z1",
      url: "https://site.test/private",
      labels: [],
      status: "success",
      timestamp: "2026-09-30T00:00:00.000Z",
      captureProcessingTimeMs: 120,
      artifacts: {},
      document: { url: "https://site.test/private", withheld: "deny" },
    });
    expect(report.status).toBe("success");
    expect(report.httpStatusCode).toBeUndefined();
    expect(report.document).toEqual({ url: "https://site.test/private", withheld: "deny" });
  });

  /** v18 は、方針を守れなかった取り込み（deny に当たる WebSocket を開いた、など）を policy で失敗にする。 */
  it("v18 の manifest（errorDetails.type が policy）を読む", () => {
    const report = readManifest({
      ...v12Manifest,
      status: "failed",
      errorDetails: {
        type: "policy",
        message: "ws://site.test/socket: deny に当たる WebSocket を開いた",
      },
    });
    expect(report.errorDetails?.type).toBe("policy");
  });

  /** v28 は、主の頁の renderer が落ちた取り込みを renderer_crashed で失敗にし、落ち方を rendererStatus で言う。 */
  it("v28 の manifest（errorDetails.type が renderer_crashed）を読む", () => {
    const report = readManifest({
      ...v12Manifest,
      status: "failed",
      artifacts: {},
      completeness: undefined,
      errorDetails: {
        type: "renderer_crashed",
        message: "Renderer crashed (killed) — in load-pages (behaviors, dpr=1) for 12s",
        step: "load-pages",
        rendererStatus: "killed",
      },
    });
    expect(report.errorDetails).toMatchObject({
      type: "renderer_crashed",
      rendererStatus: "killed",
      step: "load-pages",
    });
  });

  /** v28 は、別サイトの iframe の renderer だけが落ちた取り込みを success のまま返し、一覧に載せる。 */
  it("v28 の manifest（completeness.crashedTargets）を読む。方針で伏せた行は url を持たない", () => {
    const report = readManifest({
      ...v12Manifest,
      completeness: {
        complete: false,
        bodylessUrls: [],
        truncatedUrls: [],
        uninterceptedUrls: [],
        crashedTargets: [
          { type: "iframe", status: "killed" },
          { type: "iframe", url: "https://ads.test/frame", status: "crashed" },
        ],
      },
    });
    expect(report.status).toBe("success");
    expect(report.completeness?.complete).toBe(false);
    expect(report.completeness?.crashedTargets).toHaveLength(2);
  });

  it("document の withheld が契約に無い綴りなら断る", () => {
    expect(() =>
      readManifest({
        ...v12Manifest,
        document: { url: "https://site.test/", withheld: "denied" },
      }),
    ).toThrow(/document\/withheld must be equal to one of the allowed values/);
  });

  it("必須の項目が無ければ、その名前を挙げて断る", () => {
    expect(() => readManifest({ ...v12Manifest, taskId: undefined })).toThrow(
      /must have required property 'taskId'/,
    );
  });

  it("入れ子の型違いも、場所を挙げて断る", () => {
    expect(() => readManifest({ ...v12Manifest, completeness: { complete: "yes" } })).toThrow(
      /data\/completeness\/complete must be boolean/,
    );
  });

  /**
   * v24.0.0 から、答えと manifest に取り込みのログ (`log`) が載る。任意の欄で既定値も無いので、照らしても
   * 足されも削られもしない —— 1 ページのログの口は、読んだ物をそのまま返す。時刻は String、数は Integer で、
   * Ajv の知らない format (date-time・double) を持たない (持てば、この file の import の時点で落ちる)。
   */
  const v24Log = {
    lines: [
      {
        at: "2026-11-04T05:12:04.551Z",
        ms: 4522,
        dpr: 1,
        source: "script",
        script: "egov-law-search",
        level: "info",
        msg: "検索語を入れて押した",
        data: { query: "個人情報", nested: { values: [1, "二", null] } },
      },
      {
        at: "2026-11-04T05:12:14.873Z",
        ms: 14873,
        source: "page",
        level: "error",
        msg: "Uncaught",
      },
      {
        at: "2026-11-04T05:12:15.000Z",
        ms: 15000,
        source: "browserhive",
        level: "warn",
        msg: "dropped 3 lines to stay within the capture's log limits",
        data: '{"dropped":3',
        truncated: true,
      },
    ],
    counts: { debug: 0, info: 1, warn: 1, error: 1 },
    dropped: 3,
  };

  it("v24.0.0 の manifest（log が在る）を読み、log は書かれたまま", () => {
    const report = readManifest({ ...v12Manifest, log: structuredClone(v24Log) });
    expect(report.log).toEqual(v24Log);
  });

  it("v24.0.0 より前の manifest（log が無い）も読み、log は無いまま（既定で補わない）", () => {
    const report = readManifest(structuredClone(v12Manifest));
    expect("log" in report).toBe(false);
  });

  it("log の行の level が契約に無い綴りなら、場所を挙げて断る", () => {
    const line = { ...v24Log.lines[1], level: "trace" };
    expect(() => readManifest({ ...v12Manifest, log: { ...v24Log, lines: [line] } })).toThrow(
      /data\/log\/lines\/0\/level must be equal to one of the allowed values/,
    );
  });

  it("log の counts に欠けた level があれば断る（数は 4 つとも必ず在る）", () => {
    const three = { debug: 0, info: 1, warn: 1 };
    expect(() => readManifest({ ...v12Manifest, log: { ...v24Log, counts: three } })).toThrow(
      /data\/log\/counts must have required property 'error'/,
    );
  });

  /** BrowserHive が項目を足す版上げで、台帳が止まらないため。 */
  it("契約に無い項目は通す", () => {
    expect(readManifest({ ...v12Manifest, addedInV13: 1 }).taskId).toBe("01J8Z0");
  });
});
