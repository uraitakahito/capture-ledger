/**
 * 次の段に何を入れるかを決める。
 *
 * 純粋な関数にしてあるのは、**上限の判定が一番静かに壊れるところ**だから。深さを 1 つ
 * 数え間違えても、上限を 1 件超えても、クロールは普通に終わって成果物も残る。DB を
 * 立てないと確かめられない形にすると、その静かな誤りが試験の外に出てしまう。
 *
 * 重複排除はここでは扱わない —— `crawl_pages` の unique index の仕事で、2 か所で
 * 判断すると食い違ったときにどちらが正しいのか言えなくなる。ここが答えるのは
 * 「深さと件数の上限に照らして、何件まで入れてよいか」だけ。
 */
import type { CrawlStopReason } from "../db/database.js";

export interface Budget {
  /** 次の段の深さ。起点が 0。 */
  nextDepth: number;
  maxDepth: number;
  maxPages: number;
  /** いま `crawl_pages` に在る行数。 */
  known: number;
}

export interface Plan<T> {
  /** 実際に入れてよいもの。上限で切られていることがある。 */
  toInsert: T[];
  /**
   * 打ち切りの理由。切っていなければ `null`。
   *
   * `max_pages` は **枠を使い切った時点で**立つ。1 件も入らなかったときだけでなく、
   * 一部だけ入ったときも立てる —— 「全部辿った」と読めてしまうのを避けるため。
   */
  stopReason: CrawlStopReason | null;
}

/**
 * 上限を当てる。
 *
 * 深さが先。`maxDepth` を超えていれば件数を見るまでもなく 0 件で、理由は `max_depth`。
 * 両方に当たっている場合に深さを優先するのは、そちらが**先に効いた**制約だから ——
 * 深さで止まったクロールに「件数で止まった」と書くと、上限を上げれば続きが取れると
 * 読み手に思わせる。
 */
export const planNextLevel = <T>(candidates: readonly T[], budget: Budget): Plan<T> => {
  if (budget.nextDepth > budget.maxDepth) {
    return { toInsert: [], stopReason: "max_depth" };
  }

  const room = budget.maxPages - budget.known;
  if (room <= 0) {
    return { toInsert: [], stopReason: "max_pages" };
  }
  if (candidates.length > room) {
    // **枠のぶんだけ入れて、切ったことを記録する。** 全部落とすと「上限に当たった」ことは
    // 分かるが、当たるまでに取れたはずのページを捨てることになる。
    return { toInsert: candidates.slice(0, room), stopReason: "max_pages" };
  }

  return { toInsert: [...candidates], stopReason: null };
};
