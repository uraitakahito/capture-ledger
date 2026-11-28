/**
 * クロールに、robots.txt の例外 (`046`) のどの行を当ててよいか (`crawls.exemption_eligibility`・`047`)。
 * **クロールを始める時に 1 度だけ決め、行に残す。** 段ごとに引く側 (`exemptions/dispatch.ts`) は、残した字を読む。
 *
 * ## クロールの組織で訊く
 *
 * 例外の行は組織の物で、当たるのはクロールの組織 (`crawls.org_id`) の行。その組織は**名乗りの 1 つ目**で決まり
 * (`requesterOf`)、始めてよいと許した組織とは限らない —— `maySubmit` は、名乗りの組織のどれか 1 つで許されて
 * いれば通す。だから、名乗りが [A, B] で許しは B だけの主体のクロールは A の物になり、何も見ずに A の行を引くと、
 * A で何の許しも持たない主体が A の例外で robots.txt を外せる。
 *
 * ここは、主体が**クロールの組織 1 つ**で `can_submit` を持つかを訊く。`maySubmit` の中の 1 回と同じ形で、
 * **contextual tuple を送らない** (判断材料は保存された tuple だけ。`api/authorization.ts` の注)。持たなければ
 * `none` —— クロールは今までどおり始まり、robots.txt に従う。
 *
 * ## 人か機械か
 *
 * `human` (`applies_to = 'human'` の行も当たる) は、人が `POST /api/crawls` で始めたクロールだけ。
 *
 *   - 機械の主体 (client credentials のトークン) は `machine`
 *   - 定期の回は、画面の「いま撮る」の回も含めて `machine` —— 回の主体は予定を作った主体で、押した人ではない
 *     (`schedules/tick.ts`)。予定は、作った人が見ていない時刻に走る
 *   - ヘッダで名乗る経路 (`CAPTURE_LEDGER_DEV_IDENTITY=1`) は `none` —— 主体そのものが呼び手の申告で、
 *     許しを持つ主体を名乗れる。訊いても検査にならないので、訊かない (`api/robots-exemptions.ts` が登録を断るのと同じ訳)
 *
 * 呼び手は `POST /api/crawls` と定期の周回の 2 つだけ。
 */
import type { OpenFgaClient } from "@openfga/sdk";
import { ConsistencyPreference } from "@openfga/sdk";

import type { ExemptionEligibility } from "../db/database.js";

/** クロールがどこから始まったか。 */
export type CrawlStart =
  /** `POST /api/crawls`。`machine` は名乗りの印 (`Identity.machine`)、`identityMode` は名乗りの経路。 */
  | { kind: "request"; machine: boolean; identityMode: "jwt" | "header" | "deny" }
  /** 定期の回 (期限の回と「いま撮る」の回)。 */
  | { kind: "schedule" };

export const exemptionEligibility = async (
  fga: OpenFgaClient,
  who: { subject: string; orgId: string },
  start: CrawlStart,
): Promise<ExemptionEligibility> => {
  if (start.kind === "request" && start.identityMode !== "jwt") return "none";
  // 組織を持たない主体のクロール (`org_id` が空) に、当たる行は無い。訊く相手も無い
  if (who.orgId === "") return "none";

  const { allowed } = await fga.check(
    { user: `user:${who.subject}`, relation: "can_submit", object: `organization:${who.orgId}` },
    // 取り消しが即座に効くべき側 (`maySubmit` と同じ)。外した許しで、例外を当てさせない
    { consistency: ConsistencyPreference.HigherConsistency },
  );
  if (allowed !== true) return "none";
  return start.kind === "request" && !start.machine ? "human" : "machine";
};
