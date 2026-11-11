import { describe, expect, it } from "vitest";
import { catalogIdRefusal, isInlineId } from "../src/scripts/store.js";

/**
 * 登録済みのスクリプトの id と、その場の TS の id の境目。`inline-` はその場の TS（`POST /api/crawls` の
 * `scripts[].inline`）に取ってあり、登録しない —— アーカイブの id だけで、登録済みのスクリプトか
 * その場の物かを分けるため。DB の CHECK (`019`) が最後の守りで、ここは CLI が先に言う文。
 */
describe("登録済みのスクリプトの id から inline- を空ける", () => {
  it("inline- で始まる id は、その場の TS の id と読む", () => {
    expect(isInlineId("inline-close-banner")).toBe(true);
    expect(isInlineId("autoscroll")).toBe(false);
    // 頭だけを見る。途中に在るのは登録済みのスクリプトの id として構わない
    expect(isInlineId("not-inline-x")).toBe(false);
  });

  it("登録済みのスクリプトの id として、inline- で始まる物だけを断り、文で id を名指す", () => {
    expect(catalogIdRefusal("autoscroll")).toBeUndefined();
    expect(catalogIdRefusal("inline-x")).toBe(
      "inline-x: inline- で始まる id は、その場の TS に取ってある",
    );
  });
});
