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
  url: "https://example.com/",
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

  /** BrowserHive が項目を足す版上げで、台帳が止まらないため。 */
  it("契約に無い項目は通す", () => {
    expect(readManifest({ ...v12Manifest, addedInV13: 1 }).taskId).toBe("01J8Z0");
  });
});
