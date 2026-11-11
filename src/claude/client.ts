/**
 * capture-ledger の Claude のクライアント (`Claude`)。直す係 (CAPTURE-49) と前回からの変化の係 (CAPTURE-167) が同じ物を使う。
 * **env を読まない** —— client は呼ぶ側が作って渡す (API は `src/config/claude.ts` が env から、評価の道具は read-env から)。
 *
 * - model は `claude-opus-5-5`。thinking は常に有効 (Opus 5.5 は止められない) で、深さは頼みごとの effort で決める
 * - 答えの形は structured outputs (`jsonSchemaOutputFormat`。JSON Schema のまま書けるので zod は要らない)
 * - 安全の判定で断られたら、別の model で続ける `fallbacks: "default"` (beta
 *   `server-side-fallback-2026-07-01`)。費用は試みごとに、その試みの model の値で数える (`attemptsOf`)
 * - 決まりの文 (system) は cache に載せる。2 往復目は会話を継ぎ足すだけなので、前の turn も cache に当たる
 */
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

import type { Usage } from "./prices.js";
import { ClaudeUnavailable, type Claude, type ClaudeAttempt } from "./types.js";

export const CLAUDE_MODEL = "claude-opus-5-5";

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
export const attemptsOf = (res: { model: string; usage: AnsweredUsage }): ClaudeAttempt[] => {
  const iterations = res.usage.iterations ?? [];
  if (iterations.length === 0) return [{ model: res.model, usage: res.usage }];
  return iterations.map((usage) => ({ model: usage.model ?? CLAUDE_MODEL, usage }));
};

export const claudeOf = (client: Anthropic): Claude => ({
  async ask<T>({ system, messages, schema, effort, maxTokens }: Parameters<Claude["ask"]>[0]) {
    let res;
    try {
      res = await client.beta.messages.parse({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // schema は JSON Schema のまま受ける。SDK の型は JSON Schema の全部を書いた形なので、そこへ寄せる
        output_config: {
          effort,
          format: jsonSchemaOutputFormat(schema as Parameters<typeof jsonSchemaOutputFormat>[0]),
        },
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
      output: (res.parsed_output ?? null) as T | null,
      content: res.content,
      model: res.model,
      attempts: attemptsOf(res),
      stopReason: res.stop_reason,
    };
  },
});
