import { describe, it, expect } from "vitest";
import { crawlKeyPrefix } from "../src/api/sink.js";

/**
 * 受け口が成果物を置く接頭辞。クロールを作るときに 1 度だけ計算し、
 * `crawls.artifact_key_prefix` に書く。
 *
 * 台帳はこの接頭辞から鍵を組まない —— 置いた場所は受け口の応答 (`location`) で
 * BrowserHive に返り、段の報告で台帳に戻ってくる。ここで見るのは綴りそのもの。
 */

describe("crawlKeyPrefix", () => {
  it("組織と月で分け、末尾に / を付ける", () => {
    expect(crawlKeyPrefix("acme", new Date("2026-09-10T12:00:00Z"))).toBe("org/acme/2026-09/");
  });

  // 月は 0 埋め。しないと `2026-9` と `2026-09` が混ざり、prefix で絞ったときに
  // 片方だけが返る。
  it("1 桁の月を 0 埋めする", () => {
    expect(crawlKeyPrefix("acme", new Date("2026-01-31T00:00:00Z"))).toBe("org/acme/2026-01/");
  });

  /**
   * **UTC で切る。** ここが実行環境のローカル時刻に依存すると、置いた側と探す側が
   * 別の TZ で動いた瞬間に 1 か月ずれる —— この設計がまさに塞ごうとしているずれを、
   * 別の形で作り直すことになる。
   *
   * 下の 2 つは JST (UTC+9) では 2027 年 1 月に入る時刻。ローカル時刻で切る実装だと
   * `org/acme/2027-01/` になるので、**区別できる入力**になっている。
   */
  it("ローカル時刻ではなく UTC で月を決める", () => {
    expect(crawlKeyPrefix("acme", new Date("2026-12-31T23:00:00Z"))).toBe("org/acme/2026-12/");
    expect(crawlKeyPrefix("acme", new Date("2026-12-31T15:00:00Z"))).toBe("org/acme/2026-12/");
  });
});
