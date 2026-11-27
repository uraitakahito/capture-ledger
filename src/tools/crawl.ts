#!/usr/bin/env node
/**
 * AI の担当がクロールを始める・様子を見る CLI (CAPTURE-450)。AI の担当の app client (`ai`。scope `crawl.start`) で
 * token を取り、capture-ledger を叩く。**止める命令は無い** —— `ai` の scope は始める・読むだけ。
 *
 *   pnpm run crawl start https://site.test/            # 始めて、クロールの id を出す
 *   pnpm run crawl start https://site.test/ --depth 0 --wait
 *   pnpm run crawl show <crawlId>
 *
 * client の ID と secret は `.dev/idp-ai.env` (`idp:bootstrap` が書く) から読む。**secret と token は出さない** ——
 * 打つ人 (AI の担当) は file を開かずに、この命令だけを使う。席の名前は `--actor`・`CAPTURE_LEDGER_ACTOR`・
 * castlist の順に決め、見出し `X-Capture-ledger-Actor` で申告する (`crawl-cli.ts` の `actorFrom`)。
 */
import { randomUUID } from "node:crypto";

import { Command, InvalidArgumentError } from "commander";

import {
  actorFrom,
  actorFromCastlist,
  aiClientOf,
  heldTokenOf,
  refusalText,
  startBody,
  summaryOf,
  tokenRequest,
  tokenStillGood,
  unreachableText,
  type AiClient,
  type HeldToken,
} from "./crawl-cli.js";
import { guardEnv, optional } from "./env.js";
import { IDP_AI_HANDOFF, readEnvFile } from "./idp.js";
import { ROOT } from "./root.js";
import { resolve } from "node:path";

guardEnv();

const API = `http://127.0.0.1:${optional("CAPTURE_LEDGER_API_PORT", "7070")}`;
/** 終わりを待つ間の、引き直しの間 (ms)。 */
const POLL_MS = 5_000;

class Refused extends Error {}

/** fetch して、繋がらなければ、どこに届かないかを言う断りにする (素の `fetch failed` を出さない)。 */
const reach = async (where: "idp" | "api", url: string, init?: RequestInit) => {
  try {
    return await fetch(url, init);
  } catch {
    throw new Refused(unreachableText(where, url));
  }
};

const clientOrFail = (): AiClient => {
  const client = aiClientOf(readEnvFile(resolve(ROOT, IDP_AI_HANDOFF)));
  if ("error" in client) throw new Refused(client.error);
  return client;
};

/** token を 1 本取り、期限まで使い回す。 */
const tokens = (client: AiClient) => {
  let held: HeldToken | undefined;
  return async (): Promise<string> => {
    if (tokenStillGood(held, Date.now())) return held.value;
    const { headers, body } = tokenRequest(client);
    const res = await reach("idp", client.tokenEndpoint, { method: "POST", headers, body });
    const answer = heldTokenOf(res.status, await res.json().catch(() => ({})), Date.now());
    if ("error" in answer) throw new Refused(answer.error);
    held = answer;
    return answer.value;
  };
};

/** castlist に、この session のアクターの名前を訊く。届かなければ undefined (申告なし)。 */
const lookUpActor = async (): Promise<string | undefined> => {
  const castlist = optional("CAPTURE_LEDGER_CASTLIST_URL", "");
  const session = process.env["CLAUDE_CODE_SESSION_ID"];
  if (castlist === "" || session === undefined || session === "") return undefined;
  try {
    const url = new URL("/api/actors", castlist);
    url.searchParams.set("binding", `claude.session:${session}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return res.ok ? actorFromCastlist(await res.json()) : undefined;
  } catch {
    return undefined;
  }
};

const call = async (
  token: () => Promise<string>,
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: unknown } = {},
) => {
  const res = await reach("api", `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(init.body !== undefined && { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Refused(refusalText(res.status, body, method === "GET"));
  return body as Record<string, unknown>;
};

const show = async (token: () => Promise<string>, crawlId: string) =>
  summaryOf(await call(token, "GET", `/api/crawls/${encodeURIComponent(crawlId)}`));

const waitFor = async (token: () => Promise<string>, crawlId: string, timeoutS: number) => {
  const until = Date.now() + timeoutS * 1000;
  for (;;) {
    const one = await show(token, crawlId);
    if (one.state !== "running") return one;
    if (Date.now() > until)
      throw new Refused(`${String(timeoutS)} 秒待っても終わらない (crawl ${crawlId})`);
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
};

const depthOf = (value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("0 以上の整数");
  return n;
};

const program = new Command()
  .name("capture-ledger crawl")
  .description("AI の担当の app client でクロールを始める・様子を見る");

program
  .command("start")
  .description("クロールを始める")
  .argument("<url...>", "起点の URL")
  .option("--depth <n>", "リンクを辿る深さ (0 はそのページだけ)", depthOf)
  .option("--actor <name>", "申告する席の名前 (既定は CAPTURE_LEDGER_ACTOR か castlist)")
  .option("--wait", "終わるまで待って、結果を出す")
  .option("--timeout <s>", "--wait の上限 (秒)", depthOf, 1800)
  .action(
    async (
      urls: string[],
      opts: { depth?: number; actor?: string; wait?: boolean; timeout: number },
    ) => {
      const token = tokens(clientOrFail());
      // castlist は、旗と環境変数で決まらない時だけ訊く (遅い・届かない時に待たない。要らない時に session の ID を送らない)
      const actor =
        actorFrom(opts.actor, optional("CAPTURE_LEDGER_ACTOR", ""), undefined) ??
        actorFrom(undefined, undefined, await lookUpActor());
      const answer = await call(token, "POST", "/api/crawls", {
        headers: {
          "idempotency-key": randomUUID(),
          ...(actor !== undefined && { "x-capture-ledger-actor": actor }),
        },
        body: startBody(urls, opts.depth),
      });
      const crawlId = String(answer["crawlId"]);
      // 知らせの行は stderr に (--wait の JSON を jq に渡せるように)。待たない時は、id だけを stdout に
      process.stderr.write(
        `始めた: ${crawlId}${actor === undefined ? "（申告なし）" : `（席 ${actor}）`}\n`,
      );
      if (!opts.wait) process.stdout.write(`${crawlId}\n`);
      if (opts.wait)
        process.stdout.write(
          `${JSON.stringify(await waitFor(token, crawlId, opts.timeout), null, 2)}\n`,
        );
    },
  );

program
  .command("show")
  .description("クロール 1 本の様子")
  .argument("<crawlId>")
  .action(async (crawlId: string) => {
    process.stdout.write(
      `${JSON.stringify(await show(tokens(clientOrFail()), crawlId), null, 2)}\n`,
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // 断りの文は自前の物だけを出す。予期しない誤りは種類と文だけ (要求の見出しや token は誤りに載らない)
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
