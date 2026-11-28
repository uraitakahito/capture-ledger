/**
 * `048` が、既に在る行の `error` の字を鍵と値に読み解く関数 (`readStored`)。
 *
 * migration そのもの (列を足す・行を書く) は本物の Postgres で確かめる (PR の本文)。ここは読み解きだけ ——
 * **組み直して 1 字も違わない字だけを読む**ことと、読んだ鍵と値が、辞書で元の字に戻ることを見る。
 */
import { describe, expect, it } from "vitest";
import { readStored } from "../src/db/migrations/048-add-crawls-error-key.js";
import { MESSAGE_KEYS, render } from "../src/i18n/messages.js";

const READ = [
  "1 枚も撮れませんでした（取れず 0・見送り 1）。最初の理由: robots",
  "1 枚も撮れませんでした（取れず 2・見送り 0）。最初の理由: http_error: HTTP 404: Not Found",
  "1 枚も撮れませんでした（取れず 1・見送り 0）。最初の理由: internal: net::ERR_NAME_NOT_RESOLVED at http://nonexistent.invalid/",
  // 理由が改行・雛形の記号・「最初の理由: 」そのものを含む
  "1 枚も撮れませんでした（取れず 1・見送り 0）。最初の理由: a\nb {x} 'q' 最初の理由: c",
  // 理由が空の字
  "1 枚も撮れませんでした（取れず 1・見送り 0）。最初の理由: ",
  "1 枚も撮れませんでした（取れず 1・見送り 0）。",
  "1 枚も撮れませんでした（取れず 0・見送り 0）。",
  "1 枚も撮れませんでした（030 で直した過去の行）",
];

const NOT_READ = [
  // flow が報告した文・人が打った字・英語の文
  "[compile] compile 422 CompileFailed: 型の誤り 1 件。最初の 1 件: a.ts:2:9 TS2322 x",
  "定期実行の画面から締めた",
  "Windmill did not take level 0 within 10 minutes (13 tries): no answer",
  "",
  // 形が近いが、capture-ledger の書いた字ではない
  "1 枚も撮れませんでした",
  "1 枚も撮れませんでした（取れず 1・見送り 0）。 最初の理由: x",
  "1 枚も撮れませんでした（取れず 1・見送り 0）。その他",
  "1 枚も撮れませんでした（取れず x・見送り 0）。",
  "前置き 1 枚も撮れませんでした（取れず 1・見送り 0）。",
  // 組み直すと字が変わる数 (頭の 0・持てない大きさ)
  "1 枚も撮れませんでした（取れず 01・見送り 0）。",
  "1 枚も撮れませんでした（取れず 99999999999999999999・見送り 0）。",
];

describe("readStored", () => {
  it.each(READ)("読み解いた鍵と値は、日本語の辞書で元の字に戻る: %j", (error) => {
    const stored = readStored(error);
    expect(stored).toBeDefined();
    expect(Object.keys(MESSAGE_KEYS)).toContain(stored?.key);
    expect(render(stored?.key ?? "", stored?.params, "ja")).toBe(error);
  });

  it.each(NOT_READ)("capture-ledger の書いた形でない字は読まない: %j", (error) => {
    expect(readStored(error)).toBeUndefined();
  });

  it("数は数として、理由は字のまま値に入る", () => {
    expect(readStored("1 枚も撮れませんでした（取れず 2・見送り 3）。最初の理由: robots")).toEqual({
      key: "crawl.nothingCapturedBecause",
      params: { failed: 2, skipped: 3, reason: "robots" },
    });
    expect(readStored("1 枚も撮れませんでした（取れず 2・見送り 3）。")).toEqual({
      key: "crawl.nothingCaptured",
      params: { failed: 2, skipped: 3 },
    });
    expect(readStored("1 枚も撮れませんでした（030 で直した過去の行）")).toEqual({
      key: "crawl.nothingCapturedBackfilled",
      params: {},
    });
  });
});
