/**
 * 機械のトークンの scope で、届いてよい route を絞る (CAPTURE-450)。
 *
 * IdP (本番は Cognito・手元は Floci) の resource server `capture-ledger` の scope は 2 つ。
 *
 *   - `capture-ledger/crawl`: 今までの scope。Windmill の flow が段の報告に使う。**どの route も通る**
 *     (意味を変えると、flow・smoke・doctor が叩く読む route まで落ちる)
 *   - `capture-ledger/crawl.start`: AI の担当の app client に許す、狭い scope。クロールを**始める・読む**
 *     ところだけ通る。予定の書き込み・flow の報告と行を締める route・Claude に訊く route は断る
 *
 * scope は IdP が署名したトークンの中身なので、呼び手は偽れない。**検査は機械のトークンだけに掛ける** ——
 * 人のトークンの scope は画面のサインインの物で、組織の許可 (OpenFGA) がこれまでどおり人を絞る。
 * 開発用ヘッダの経路には scope が無いので掛けない。
 *
 * ## 一覧に無い書き込みは断る
 *
 * 狭い scope で通る書き込みは下の一覧だけ。新しい書き込みの route は、一覧に足すまで AI の担当には届かない ——
 * 開く向きを、足す人が選ぶ (`test/scope.test.ts` が、src の書き込みの route を全部この一覧で分ける)。
 * **GET はみな通す** (組織の許可が絞る)。GET で書き込みや費用 (重い集計・Claude を呼ぶ物など) を起こす route を
 * 足すなら、この門を見直す。
 */
import type { Identity } from "../config/identity.js";

/** resource server の名前。scope の頭に付く。手元の IdP は `idp:bootstrap` がこの名前で作る。 */
export const RESOURCE_SERVER = "capture-ledger";
export const CRAWL_SCOPE = `${RESOURCE_SERVER}/crawl`;
export const START_SCOPE = `${RESOURCE_SERVER}/crawl.start`;

/**
 * 狭い scope で通す書き込み。`<method> <route の形>` (Fastify の `routeOptions.url`)。
 * 読む route (GET) はみな通す —— 組織の許可が今までどおり絞る。
 */
const START_WRITES: ReadonlySet<string> = new Set([
  // クロールを始める
  "POST /api/crawls",
  // 読むための署名つき URL を取る (アーカイブを開く)
  "POST /api/archives/:id/url",
]);

/** 狭い scope (`crawl.start`) で、この route に届いてよいか。 */
export const startScopeAllows = (method: string, url: string): boolean =>
  method === "GET" || method === "HEAD" || START_WRITES.has(`${method} ${url}`);

/** 断る時の答え。RFC 6750 の `insufficient_scope` と同じ扱いで、足りない scope の名前を返す。 */
export interface ScopeRefusal {
  error: "insufficient_scope";
  scope: string;
}

/**
 * この名乗りが、この route に届いてよいか。届かないなら断りの答え、届くなら undefined。
 *
 * 名乗りが通った後の不足なので、訳を返す (名乗りの失敗の訳は返さない作りとは別)。AI の担当が「なぜ断られたか」を
 * 読めないと、別の道を探し始める。
 */
export const scopeRefusal = (
  identity: Identity,
  method: string,
  url: string,
): ScopeRefusal | undefined => {
  if (identity.machine !== true) return undefined;
  const scopes = identity.scopes ?? [];
  if (scopes.includes(CRAWL_SCOPE)) return undefined;
  if (scopes.includes(START_SCOPE) && startScopeAllows(method, url)) return undefined;
  // 狭い scope を持つ呼び手には広い scope が要ると、何も持たない呼び手には狭い scope が要ると言う
  return {
    error: "insufficient_scope",
    scope: scopes.includes(START_SCOPE) ? CRAWL_SCOPE : START_SCOPE,
  };
};
