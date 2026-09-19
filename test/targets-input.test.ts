import { describe, it, expect } from "vitest";
import { collectUrls, parseUrlLines } from "../src/targets/input.js";

/** 撮る対象として足す URL を、引数と標準入力から集めるところ (`src/targets/input.ts`)。 */
describe("足す URL の読み取り", () => {
  const noStdin = (): Promise<string> => Promise.reject(new Error("標準入力は読まないはず"));

  it("1 行 1 URL として読み、空行と # の行を読み飛ばし、前後の空白を落とす", () => {
    const text =
      "# 自分の一覧\r\nhttps://example.com/\r\n\r\n   https://example.org/docs  \n  # 途中の注記\n";

    expect(parseUrlLines(text)).toEqual(["https://example.com/", "https://example.org/docs"]);
  });

  it("引数の URL は、同じものを 1 つに畳み、最初に出た順を保つ", async () => {
    const result = await collectUrls(
      ["https://b.example/", "https://a.example/", "https://b.example/"],
      noStdin,
    );

    expect(result).toEqual({ kind: "ok", urls: ["https://b.example/", "https://a.example/"] });
  });

  it("- なら標準入力から読む", async () => {
    const result = await collectUrls(["-"], () =>
      Promise.resolve("https://example.com/\nhttps://example.org/\n"),
    );

    expect(result).toEqual({ kind: "ok", urls: ["https://example.com/", "https://example.org/"] });
  });

  it("- と URL を混ぜたら、標準入力を読まずに誤りにする", async () => {
    const result = await collectUrls(["-", "https://example.com/"], noStdin);

    expect(result.kind).toBe("error");
  });

  it("URL が 1 本も無ければ誤りにする", async () => {
    const fromStdin = await collectUrls(["-"], () => Promise.resolve("# 注記だけ\n\n"));
    const fromArgs = await collectUrls(["  "], noStdin);

    expect(fromStdin).toEqual({ kind: "error", message: "標準入力に URL が 1 本も無い" });
    expect(fromArgs).toEqual({ kind: "error", message: "URL が 1 本も無い" });
  });
});
