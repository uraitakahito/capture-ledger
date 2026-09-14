import { describe, expect, it } from "vitest";
import { manifestOutcome } from "../src/archive/manifest.js";

/**
 * 段の報告が運んだ manifest の結末を、台帳に書く形にする。
 *
 * **鍵を組まない**ことを見る。見本の鍵は BrowserHive の命名規則では作れない綴り
 * (知らない接頭辞、空白、`+`、日本語) にしてある —— 規則どおりの名前だと、taskId から
 * 組み直す実装でも同じ綴りになって緑で通る。
 */
describe("manifestOutcome", () => {
  it("設定の bucket なら、bucket を外した残りをそのまま鍵にする", () => {
    expect(
      manifestOutcome(
        { manifestLocation: "s3://archives/elsewhere/x y+z 日本.result.json" },
        "archives",
      ),
    ).toEqual({ key: "elsewhere/x y+z 日本.result.json", error: null });
  });

  it("書けなかった理由はそのまま残す", () => {
    const reason = "s3://archives/t_.result.json: not written within 10000ms";
    expect(manifestOutcome({ manifestError: reason }, "archives")).toEqual({
      key: null,
      error: reason,
    });
  });

  /**
   * 報告の bucket を信じると、報告する側が読み先を選べる。**読まずに理由を残す** ——
   * 段の報告は落とさない (台帳が遅れるより、クロールが止まるほうが重い)。
   */
  it("別の bucket は読まない", () => {
    const got = manifestOutcome(
      { manifestLocation: "s3://someone-else/t_.result.json" },
      "archives",
    );
    expect(got.key).toBeNull();
    expect(got.error).toContain("someone-else");
  });

  it("s3:// でない場所は読めない理由にする", () => {
    const got = manifestOutcome({ manifestLocation: "file:///tmp/t_.result.json" }, "archives");
    expect(got.key).toBeNull();
    expect(got.error).toContain("file:///tmp/t_.result.json");
  });
});
