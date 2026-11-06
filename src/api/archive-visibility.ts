/**
 * 「この呼び出し元は、このアーカイブを見てよいか」を訊く 1 か所。
 *
 * 名前で主題を言っている —— 「認可の道具箱」ではない。道具箱にすると、
 * 中身が別の検査に流用される。ここに在るのは **`can_view` を archive について
 * 訊く**ことだけ。
 *
 * ## `membershipTuples` を export しない
 *
 * 所属の申告を contextual tuple として渡してよいのは、**object が組織を固定する**
 * とき —— つまり `can_view` を特定の archive について訊くときだけ。`can_submit` は
 * object を呼び出し元が名乗るので、同じものを渡すと「member だと言った者に member か
 * 訊く」形になり、検査が常に通る (`api/authorization.ts` に経緯がある)。
 *
 * 以前は `routes.ts` の中に private で置き、docstring で「ここ以外で使うな」と
 * 書いていた。使う場所が 2 つになった時点で export され、**「危ないと書いてあるが
 * 誰でも取れる」**状態になった。この module に閉じれば、誤用は書けなくなる ——
 * コメントではなく型が止める。
 *
 * ## `correlationId` を渡さない
 *
 * OpenFGA の `batchCheck` には要求と応答を対応付ける `correlationId` があり、
 * SDK の型では **任意**。以前はここで archive の id から作って渡していたが、
 * **応答側でそれを一度も読んでいない** —— 対応付けには `entry.request.object` を
 * 使っている。渡さなければ SDK が自前で用意する。
 *
 * 消した理由は行数ではなく名前。BrowserHive の取り込みにも `correlationId` が
 * あって、あちらは「呼び出し元が付けた相関キー」という**全く別の概念**。同じ名前が
 * 2 つの意味で並ぶと、読むたびに打ち消しのコメントが要る —— そして実際、
 * 2 か所目にそのコメントは伝播しなかった。**書かなければ打ち消さなくてよい。**
 */
import type { OpenFgaClient } from "@openfga/sdk";
import { ConsistencyPreference } from "@openfga/sdk";
import type { Identity } from "./identity.js";

/**
 * 所属を contextual tuple として、リクエストのたびに呼び出し元の identity から
 * 組み直す。誰がどの組織に属するかは OpenFGA に一切保存しないので、同期を保つべき
 * 所属が存在しない —— 認可ストアと identity provider が食い違う窓も無い。
 *
 * **この module の外へ出さない。** 上の docstring を見ること。
 */
const membershipTuples = (identity: Identity) =>
  identity.organizations.map((org) => ({
    user: `user:${identity.subject}`,
    relation: "member",
    object: `organization:${org}`,
  }));

/**
 * アーカイブ 1 本を見てよいか。
 *
 * **古い答えが許されない唯一の場所。** ここでキャッシュされた許可は、寿命の間ずっと
 * 有効な URL を配ってしまうので、1 秒前に入った取り消しが既に見えていなければ
 * ならない。だから `HigherConsistency`。
 *
 * 拒否をどう返すかは呼ぶ側が決める (ledger は 403 ではなく 404 を返す ——
 * `routes.ts` にその理由がある)。
 */
export const mayViewArchive = async (
  fga: OpenFgaClient,
  identity: Identity,
  archiveId: string,
): Promise<boolean> => {
  const { allowed } = await fga.check(
    {
      user: `user:${identity.subject}`,
      relation: "can_view",
      object: `archive:${archiveId}`,
      contextualTuples: membershipTuples(identity),
      context: { current_time: new Date().toISOString() },
    },
    { consistency: ConsistencyPreference.HigherConsistency },
  );
  return allowed === true;
};

/**
 * 渡した id のうち、見てよいものの集合。**接頭辞の無い素の id** を返す。
 *
 * 一貫性は既定のまま —— ここではキャッシュで構わない。一覧や検索の結果に出ること
 * は何も与えない: どれかを取りに行くには `mayViewArchive` を通る必要がある。
 *
 * 空の配列では **fga に触れない**。OpenFGA は checks が空の batchCheck を拒む。
 */
export const viewableArchiveIds = async (
  fga: OpenFgaClient,
  identity: Identity,
  archiveIds: readonly string[],
): Promise<Set<string>> => {
  if (archiveIds.length === 0) return new Set();

  const now = new Date().toISOString();
  // batchCheck は contextual tuple を `tuple_keys` で包む。単発の `check` は素の
  // 配列を取る。概念は同じで、形が違う。
  const tuple_keys = membershipTuples(identity);
  const result = await fga.batchCheck({
    checks: archiveIds.map((id) => ({
      user: `user:${identity.subject}`,
      relation: "can_view",
      object: `archive:${id}`,
      contextualTuples: { tuple_keys },
      context: { current_time: now },
    })),
  });

  // 対応付けは `request.object` で行う。応答の順序は保証されないので、添字では
  // 引けない。`archive:` を剥がして返すのは、接頭辞の組み立てを呼ぶ側に
  // 持たせないため。
  return new Set(
    result.result
      .filter((entry) => entry.allowed === true)
      .map((entry) => entry.request.object.replace(/^archive:/, "")),
  );
};
