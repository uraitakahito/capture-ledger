/**
 * `fga:grant` / `fga:revoke` が最後に出す 1 文。
 *
 * **主文は「いま、クロールを起こせるか」。** 書いた・消した後に、API と同じ `maySubmit` で
 * 訊き直した答えを言う。読む人が知りたいのはそれで、何を書いたかは括弧の中の裏付けにする。
 * 以前は pino の JSON 1 行 (`"msg":"Granted"`) で、何が許されたのかは relation の名前から
 * 読み取るしかなかった。
 *
 * 書いた内容から答えを推さないのは、`submitter` を消しても `admin` が残っていれば、まだ
 * 起こせるから —— 推すと、その場合に嘘をつく。
 */
export interface GrantReport {
  user: string;
  relation: string;
  org: string;
  /** `fga:revoke` なら true。 */
  remove: boolean;
  /** 書いた (消した) なら true。既にその状態だったなら false。 */
  changed: boolean;
  /** 書いた・消した後に、`maySubmit` で訊き直した答え。 */
  canSubmit: boolean;
}

export const describeGrant = (report: GrantReport): string => {
  const { user, relation, org, remove, changed, canSubmit } = report;
  const tuple = `user:${user} ${relation} organization:${org}`;
  const done = remove ? (changed ? "消した" : "もう無かった") : changed ? "書いた" : "もう在った";
  const state = canSubmit
    ? `${user} は ${org} のクロールを起こせます`
    : `${user} は ${org} のクロールを起こせません`;
  // 消したのにまだ起こせる: 別の関係が残っている。黙ると「消えた」と読まれる。
  // 書いたのに起こせない: 指している model の `can_submit` が、この版の `fga/model.fga` と違う。
  const note =
    remove && canSubmit
      ? "。ほかの関係で許されています"
      : !remove && !canSubmit
        ? "。書いたのに Check が通りません —— CAPTURE_LEDGER_FGA_MODEL_ID が古い model を指していないか"
        : "";
  return `${state} (${done}: ${tuple}${note})`;
};
