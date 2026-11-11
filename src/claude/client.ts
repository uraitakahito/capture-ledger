/**
 * 直す係の Claude のクライアント (`FixModel`)。**env を読まない** —— client は呼ぶ側が作って渡す
 * (API は `src/config/claude.ts` が env から、評価の道具は `src/tools/fix-eval.ts` が read-env から)。
 *
 * - model は `claude-opus-5-5`、effort は medium。thinking は常に有効 (Opus 5.5 は止められない)
 * - 答えの形は structured outputs (`jsonSchemaOutputFormat`。JSON Schema のまま書けるので zod は要らない)
 * - 安全の判定で断られたら、別の model で続ける `fallbacks: "default"` (beta
 *   `server-side-fallback-2026-07-01`)。費用は試みごとに、その試みの model の値で数える (`attemptsOf`)
 * - 決まりの文 (system) は cache に載せる。2 往復目は会話を継ぎ足すだけなので、前の turn も cache に当たる
 */
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

import type { Usage } from "./prices.js";
import {
  ClaudeUnavailable,
  FIX_OUTPUT_SCHEMA,
  type FixAttempt,
  type FixModel,
} from "../scripts/fix.js";

export const FIX_MODEL = "claude-opus-5-5";
export const FIX_EFFORT = "medium";
/** 1 往復の出力の上限 (thinking を含む)。置き換えと理由だけなので、全文を書き直すより小さい。 */
const MAX_TOKENS = 8000;

/** 答えの usage のうち、費用を数えるのに読む所。SDK の `BetaUsage` はこの形に収まる。 */
interface AnsweredUsage extends Usage {
  iterations?: readonly (Usage & { model?: string | null })[] | null;
}

/**
 * 往復 1 つの試みを並べる。**費用は `usage.iterations` で数える** —— top-level の `usage` は答えた試みの
 * 分だけで、fallbacks の前に断った試みは iterations にだけ載り、それぞれの model の値で課金される。
 * 出力の前に断った試みは分類によっては課金されないが、iterations からは見分けられないので数える
 * (多めに数えて、月の上限を甘くしない)。iterations が無ければ top-level を答えた model で数える。
 * model の無い試みは、頼んだ model の物。export は試験のため。
 */
export const attemptsOf = (res: { model: string; usage: AnsweredUsage }): FixAttempt[] => {
  const iterations = res.usage.iterations ?? [];
  if (iterations.length === 0) return [{ model: res.model, usage: res.usage }];
  return iterations.map((usage) => ({ model: usage.model ?? FIX_MODEL, usage }));
};

export const fixModelOf = (client: Anthropic): FixModel => ({
  effort: FIX_EFFORT,
  async propose({ system, messages }) {
    let res;
    try {
      res = await client.beta.messages.parse({
        model: FIX_MODEL,
        max_tokens: MAX_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: FIX_EFFORT, format: jsonSchemaOutputFormat(FIX_OUTPUT_SCHEMA) },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        // assistant の content は、前の答えをそのまま継ぎ足した物 (thinking の塊を含む)
        messages: messages as Anthropic.Beta.Messages.BetaMessageParam[],
      });
    } catch (err) {
      // API の誤り (4xx・5xx・届かない・時間切れ) だけを包む。それ以外は capture-ledger の誤りなので、そのまま投げる
      if (err instanceof Anthropic.APIError) {
        throw new ClaudeUnavailable(`${String(err.status ?? "-")} ${err.message}`.slice(0, 300));
      }
      throw err;
    }
    return {
      output: res.parsed_output ?? null,
      content: res.content,
      model: res.model,
      attempts: attemptsOf(res),
      stopReason: res.stop_reason,
    };
  },
});
