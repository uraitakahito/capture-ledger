import { describe, expect, it } from "vitest";
import { mergeCompiled } from "../src/crawl/compiled.js";
import type { CrawlScript } from "../src/db/database.js";

/**
 * 段の報告が運んだ JS の hash を、クロールが固定した目録に写す判断。
 *
 * route (`POST /api/crawls/:id/pages`) はこの答えをそのまま status にするだけ。DB を使う試験は
 * この repo に無いので、断る条件は全部ここで見る。
 */

const TS = "a".repeat(64);
const JS = "b".repeat(64);
const WITH = { typescript: "6.0.3", hostTypes: "v0.2.0" };

const ts = (id: string, version = 1): CrawlScript => ({
  id,
  version,
  phase: "behavior",
  source: `// ${id}`,
  sha256: TS,
  options: {},
});

const report = (scripts: { id: string; version?: number; sha256?: string }[]) => ({
  ...WITH,
  scripts: scripts.map((s) => ({ id: s.id, version: s.version ?? 1, sha256: s.sha256 ?? JS })),
});

describe("報告の JS の hash を目録に写す", () => {
  it("全部揃っていれば、1 本ずつに jsSha256 と compiledWith を写す", () => {
    const merged = mergeCompiled(
      [ts("autoscroll"), ts("autofetch")],
      report([{ id: "autoscroll" }, { id: "autofetch" }]),
    );
    expect(merged).toEqual({
      changed: true,
      scripts: [
        { ...ts("autoscroll"), jsSha256: JS, compiledWith: WITH },
        { ...ts("autofetch"), jsSha256: JS, compiledWith: WITH },
      ],
    });
  });

  it("目録の 1 本の hash が報告に無ければ 400 —— 載せ忘れた flow を黙って通さない", () => {
    const merged = mergeCompiled(
      [ts("autoscroll"), ts("autofetch")],
      report([{ id: "autoscroll" }]),
    );
    expect(merged).toMatchObject({ status: 400, scriptId: "autofetch@1" });
  });

  it("目録に無い id が報告に在れば 400 —— 台帳では確かめようが無い主張", () => {
    const merged = mergeCompiled([ts("autoscroll")], report([{ id: "autoscroll" }, { id: "x" }]));
    expect(merged).toMatchObject({ status: 400, scriptId: "x@1" });
  });

  it("id は同じでも版が違えば、別の物として無いと言う", () => {
    const merged = mergeCompiled([ts("autoscroll", 3)], report([{ id: "autoscroll", version: 2 }]));
    expect(merged).toMatchObject({ status: 400, scriptId: "autoscroll@2" });
  });

  it("前の段と違う hash が来れば 409 —— 変換サービスが途中で替わった", () => {
    const merged = mergeCompiled(
      [{ ...ts("autoscroll"), jsSha256: JS, compiledWith: WITH }],
      report([{ id: "autoscroll", sha256: "c".repeat(64) }]),
    );
    expect(merged).toMatchObject({ status: 409, scriptId: "autoscroll@1" });
    expect((merged as { error: string }).error).toContain("bbbbbbbbbbbb… → cccccccccccc…");
  });

  it("前の段と同じなら、書き直す物が無い (changed: false)", () => {
    const fixed = { ...ts("autoscroll"), jsSha256: JS, compiledWith: WITH };
    expect(mergeCompiled([fixed], report([{ id: "autoscroll" }]))).toEqual({
      changed: false,
      scripts: [fixed],
    });
  });

  it("目録が空で報告も空なら、写す物が無い", () => {
    expect(mergeCompiled([], report([]))).toEqual({ changed: false, scripts: [] });
  });
});
