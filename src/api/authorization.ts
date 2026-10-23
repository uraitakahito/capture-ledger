/**
 * route が共有する認可の道具。
 *
 * ## なぜ 1 か所に集めるのか
 *
 * `maySubmit` は **一度直した検査**。所属を contextual tuple として渡すと
 * 「member だと言った者に member か訊く」形になり、検査が常に true を返していた
 * (`fga/model.fga` の `submitter` の注記)。写しが 2 つあると、次に直す人が片方だけ
 * 直しても**両方とも動いているように見える** —— 認可が素通りするのは静かな失敗で、
 * 赤くならないため。だから写しを持たない。
 *
 * ## ここに `membershipTuples` は無い
 *
 * 意図的。所属の申告を渡してよいのは `can_view` を **特定の archive** について訊く
 * ときだけで、そこでは object が組織を固定する。`can_submit` は object を呼び出し元が
 * 名乗るので、同じものを渡すと検査が無意味になる。
 *
 * 共有の場所に置くと「認可に使う道具」に見えてしまい、誤用への距離が縮む。
 * いまは `api/archive-visibility.ts` の中に閉じていて、**export されていない** ——
 * 誤用はコメントではなく型が止める。以前は `routes.ts` に private で置いていたが、
 * 使う場所が 2 つになった時点で export され、「危ないと書いてあるが誰でも取れる」
 * 状態になっていた。
 */
import type { FastifyReply } from "fastify";
import type { OpenFgaClient } from "@openfga/sdk";
import { ConsistencyPreference } from "@openfga/sdk";
import type { Identity } from "./identity.js";

/** 身元が解けなかったとき。理由は返さない —— 何が足りないかは漏らさない。 */
export const unauthorized = (reply: FastifyReply): FastifyReply =>
  reply.code(401).send({ error: "unauthenticated" });

/**
 * この呼び出し元が、**どれか 1 つでも**自分の組織で取り込みを始めてよいか。
 *
 * 取り込みは組織ごとではなく全体に効く(`capture_targets` の enabled な行をすべて投げ、
 * クロールは起点から辿れる範囲を辿る)ので、「どの組織について訊くか」を選べない。
 * 許されている組織がどこかに 1 つあれば始められる、とする —— **その 1 つの許可で、
 * 他の組織の対象も投げられる**。組織を跨いで信頼できる相手にだけ `submitter` を
 * 与えること。
 *
 * **contextual tuple を送らない。** `routes.ts` の `can_view` はそれを送るが、あちらは
 * 特定の archive について訊くので object が組織を固定する。こちらの object は呼び出し元が
 * 名乗った組織なので、所属の申告を一緒に渡すと「member だと言った者に member か訊く」
 * 形になり、検査が常に通る。実際そう書いて往復で見つけた。判断材料は**保存された
 * tuple だけ**にする。
 */
export const maySubmit = async (fga: OpenFgaClient, identity: Identity): Promise<boolean> => {
  // 組織を持たない呼び出し元は誰でもない —— 訊く相手が無いので拒む。
  //
  // **この行は挙動を変えない。** 空配列を `Promise.all` に渡せば `[]` が返り、
  // `includes(true)` は false になるので、消しても同じ答えになる (反証で確認)。
  // 残してあるのは意図を書き残すためで、`Promise.all([])` の性質に意味を預けたく
  // ないから。**どんな試験もこの行の有無を区別できない**ことは承知のうえ。
  if (identity.organizations.length === 0) return false;
  const results = await Promise.all(
    identity.organizations.map(async (org) => {
      const { allowed } = await fga.check(
        {
          user: `user:${identity.subject}`,
          relation: "can_submit",
          object: `organization:${org}`,
        },
        {
          // 取り消しが即座に効くべき側。古い許可で取り込みを始めさせない。
          consistency: ConsistencyPreference.HigherConsistency,
        },
      );
      return allowed === true;
    }),
  );
  return results.includes(true);
};

/**
 * 部分 unique index の違反か。走行中の 2 本目だけがこれになる。
 *
 * 制約名を受け取るのは、`runs` と `crawls` が**別々の index を持つ**から。
 * 名前を渡す形にしておくと、片方の名前で他方の違反を拾うことがない ——
 * 両方を 1 つの述語で見ると、無関係な 23505 まで 409 に化ける。
 */
export const isUniqueViolation = (err: unknown, constraint: string): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: string }).code === "23505" &&
  String((err as { constraint?: string }).constraint ?? "").includes(constraint);
