import type { CrawlScript } from "../db/database.js";

/**
 * 段の報告が運ぶ「何が走ったか」の後半 —— 変換サービスが返した JS の sha256 と、
 * 何で (typescript の版)・何に向けて (受け皿の型の tag) 変換したか。
 *
 * 台帳の `crawls.scripts` が持つ `sha256` は TS のバイト列に打った物で、archive に残るのは JS。
 * その間を継ぐ JS の sha256 は、これが来るまで Windmill の job の結果にしか無かった。
 */
export interface CompiledReport {
  typescript: string;
  hostTypes: string;
  scripts: { id: string; version: number; sha256: string }[];
}

export type MergeResult =
  | { scripts: CrawlScript[]; changed: boolean }
  | { status: 400 | 409; error: string; scriptId: string };

const keyOf = (s: { id: string; version: number }): string => `${s.id}@${String(s.version)}`;

/**
 * 報告の JS の hash を、クロールが固定した目録の各要素に写す。
 *
 * **入出力を持たない。** この repo に DB の試験は無いので、判断はここに置いて単体で見る
 * (`test/crawl-compiled.test.ts`)。route はこの答えをそのまま status にする。
 *
 * - 目録の 1 本ごとに、同じ id と版の報告が要る。無ければ 400 —— 載せ忘れた flow を黙って通さない
 * - 報告にだけ在る id も 400。目録に無い物が走ったという主張は、台帳では確かめようが無い
 * - 前の段で写した値と違えば 409。同じクロールの中で JS が変わるのは、変換サービスが途中で
 *   替わったということ。黙って上書きすると「どの JS が走ったか」を台帳が言えなくなる
 * - 全部が前の段と同じなら `changed: false` (書き直す物が無い)
 */
export const mergeCompiled = (
  scripts: readonly CrawlScript[],
  compiled: CompiledReport,
): MergeResult => {
  const reported = new Map(compiled.scripts.map((s) => [keyOf(s), s.sha256]));
  const known = new Set(scripts.map(keyOf));
  for (const key of reported.keys()) {
    if (!known.has(key)) {
      return { status: 400, error: `${key} は、このクロールが固定した目録に無い`, scriptId: key };
    }
  }

  const compiledWith = { typescript: compiled.typescript, hostTypes: compiled.hostTypes };
  const merged: CrawlScript[] = [];
  let changed = false;
  for (const s of scripts) {
    const key = keyOf(s);
    const js = reported.get(key);
    if (js === undefined) {
      return { status: 400, error: `${key} の JS の sha256 が報告に無い`, scriptId: key };
    }
    if (s.jsSha256 !== undefined && s.jsSha256 !== js) {
      return {
        status: 409,
        error: `${key} の JS が段の途中で変わった (${s.jsSha256.slice(0, 12)}… → ${js.slice(0, 12)}…)`,
        scriptId: key,
      };
    }
    if (
      s.jsSha256 === undefined ||
      s.compiledWith?.typescript !== compiledWith.typescript ||
      s.compiledWith.hostTypes !== compiledWith.hostTypes
    ) {
      changed = true;
    }
    merged.push({ ...s, jsSha256: js, compiledWith });
  }
  return { scripts: merged, changed };
};
