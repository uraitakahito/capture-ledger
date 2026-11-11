/**
 * ページの文字の差分 (CAPTURE-167)。**純粋な関数** —— Claude も保管庫も DB も知らない。2 本の WACZ の
 * `pages/pages.jsonl` の文字を渡せば、誰がいつ流しても同じ hunks になる (差分は作り直せる物として `page_changes` に残す)。
 *
 * 行に割り、両端の空白を除き、空行を落としてから比べる (`linesOf`)。空行と字下げは撮るたびに揺れる (2026-11-12 に
 * 毎朝の 5 サイトの 10 組で、外すと 3 組の数が変わった)。比べ方は最長共通部分列 (LCS) で、行の並びが変わった所は
 * 消して足した行として出る。
 */

/** 比べ方の版。`page_changes.diff_version` に残し、変えたら上げる。 */
export const DIFF_VERSION = 1;

/** 差分の行。`-` は前の回だけ、`+` は今回だけ、` ` は前後の文脈 (変わっていない)。 */
export type DiffLine = `${"-" | "+" | " "}${string}`;

export interface PageChange {
  changed: boolean;
  added: number;
  removed: number;
  /** 変わった所ごとの行の塊。各塊は前後 `context` 行の文脈を含む。 */
  hunks: DiffLine[][];
}

export const linesOf = (text: string): string[] =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

interface Op {
  kind: "-" | "+" | " ";
  line: string;
}

/** 行の並び 2 つの LCS に沿った操作の列。ページは数百行なので O(n·m) の表で足りる。 */
const opsOf = (before: readonly string[], after: readonly string[]): Op[] => {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = before[i..] と after[j..] の LCS の長さ
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      ops.push({ kind: " ", line: before[i]! });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // 同じ長さで済むなら、消す行を先に出す (差分の慣習: 前の行 → 今の行)
      ops.push({ kind: "-", line: before[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: after[j]! });
      j++;
    }
  }
  return ops;
};

/** 2 つの文字の差分。`context` は塊の前後に添える変わっていない行の数 (Claude に渡すのは前後 2 行)。 */
export const changeOf = (before: string, after: string, context = 2): PageChange => {
  const ops = opsOf(linesOf(before), linesOf(after));
  const changedAt = ops.flatMap((op, k) => (op.kind === " " ? [] : [k]));
  const hunks: DiffLine[][] = [];
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start < 0) return;
    hunks.push(ops.slice(start, end + 1).map((op): DiffLine => `${op.kind}${op.line}`));
  };
  for (const k of changedAt) {
    const from = Math.max(0, k - context);
    const to = Math.min(ops.length - 1, k + context);
    if (start >= 0 && from <= end + 1) {
      end = Math.max(end, to);
    } else {
      flush();
      start = from;
      end = to;
    }
  }
  flush();
  const added = ops.filter((op) => op.kind === "+").length;
  const removed = ops.filter((op) => op.kind === "-").length;
  return { changed: added + removed > 0, added, removed, hunks };
};
