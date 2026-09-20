/**
 * クロールを Windmill へ渡す。
 *
 * ledger は上流に居て、実行そのものは持たない。ここは「頼んだ」を伝えるだけの薄い層。
 *
 * ## なぜ webhook なのか
 *
 * Windmill の flow は path で webhook を持っていて、token 付きの POST 1 回で起動できる。
 * ledger 側に Windmill の client を抱えずに済むので、依存はこの URL と token だけになる。
 *
 * ## 設定していない配備では口ごと出さない
 *
 * クロールは後から足した能力なので、URL と token を **必須にはしない** ——
 * 必須にすると、クロールを使わない配備まで起動しなくなる。設定が無ければ
 * `undefined` を返し、呼ぶ側は route を登録しない。
 *
 * ただし **片方だけ設定されているのは拒む**。半端な設定は「動くはずなのに 401 が返る」
 * という形で、頼んだ後にしか気づけない失敗になる。両方か、どちらも無いか。
 *
 * ## 失敗したら
 *
 * 投げられなければクロールは始まらないので、`crawls` の行は `failed` で締める
 * (呼ぶ側でそうしている)。**黙って `running` のまま置かない** —— 部分 unique index が
 * 効いているので、締め忘れた行は次のクロールを永久に塞ぐ。
 */
import { optional } from "../config/env.js";
import type { CrawlDispatcher, DispatchedCrawl } from "../api/crawls.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Windmill が起こした job の id の形。本文がこれでなければ残さない —— 誤った値で run への
 * リンクを作るより、無いほうがよい。
 */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 応答の本文から job の id を取り出す。Windmill は起こした job の id をそのまま本文で返す
 * (windmill-client の `runFlowByPath` の答えは `string`)。JSON の文字列で来ても読む。
 */
export const jobIdFrom = (body: string): string | undefined => {
  const candidate = body.trim().replace(/^"(.*)"$/, "$1");
  return JOB_ID.test(candidate) ? candidate : undefined;
};

/**
 * `DispatchedCrawl` の欄と flow の引数名の対応。**型で網羅させる** —— `-?` で省略可能な欄も
 * 必須にしてあるので、`DispatchedCrawl` に欄を足してここに書き忘れると typecheck が落ちる。
 *
 * 以前は webhook の本文をその場で書き並べていて、受け口を足したとき `artifactSink` を型に
 * 足したまま本文へ載せ忘れた。flow の schema で `artifact_sink` は省略可能なので、BrowserHive は
 * 口を受け取らないまま黙って自前の保管庫へ書き続け、クロールは受け口を一度も使わなかった
 * (2026-09-14 に見つけた)。本文を書き並べる形に戻さないこと。
 *
 * **snake_case で送る。** Windmill の script は引数名がそのまま入力の契約で、
 * この repo の script は snake_case で書かれている。camelCase で送ると、
 * 引数は既定値のまま静かに走り、`host_parallelism` が null になって
 * 「u16 として読めない」で落ちる (実測)。
 */
const FLOW_ARGS: { readonly [K in keyof DispatchedCrawl]-?: string } = {
  crawlId: "crawl_id",
  depth: "depth",
  frontier: "frontier",
  perHostDelayMs: "per_host_delay_ms",
  hostParallelism: "host_parallelism",
  // **形式と署名は必ず送る。** flow の schema の既定値は webhook 起動では
  // 埋まらないので、送らなければ `undefined` が届く。決めるのは ledger 側。
  captureFormats: "capture_formats",
  signing: "signing",
  // **走らせるものも必ず送る。** BrowserHive は顔ぶれを持たないので、これを
  // 落とすとページの中で何も走らない —— それでも取り込みは成功し、archive も出る。
  // 送り忘れが静かな劣化になる欄は、他にこれだけ。
  scripts: "scripts",
  // 受け口を使わない配備では値が無く、鍵ごと送らない (`flowArgs`)。
  artifactSink: "artifact_sink",
};

/**
 * webhook の本文。**値の無い欄は鍵ごと送らない** —— `artifact_sink` を省けば、BrowserHive は
 * 従来どおり自前の保管庫へ書く。
 *
 * export は試験のため。
 */
export const flowArgs = (crawl: DispatchedCrawl): Record<string, unknown> =>
  Object.fromEntries(
    (Object.keys(FLOW_ARGS) as (keyof DispatchedCrawl)[])
      .filter((field) => crawl[field] !== undefined)
      .map((field) => [FLOW_ARGS[field], crawl[field]]),
  );

/**
 * 設定を読んで dispatcher を作る。設定が無ければ `undefined`。
 *
 * **起動時に読む。** クロールを頼まれた瞬間に「設定がありません」と言うのでは遅い ——
 * そのときには行が既に立っていて、締める処理が要る。
 */
export const createWindmillDispatcher = (): CrawlDispatcher | undefined => {
  const url = optional("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL", "");
  const token = optional("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN", "");

  if (url === "" && token === "") return undefined;
  if (url === "" || token === "") {
    throw new Error(
      "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL and CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN must be set together " +
        "(one without the other cannot dispatch a crawl)",
    );
  }
  const timeoutMs = Number(
    optional("CAPTURE_LEDGER_CRAWL_WEBHOOK_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)),
  );

  return async (crawl: DispatchedCrawl): Promise<string | undefined> => {
    // `waggle_url` / `token` / `browserhive_target` は送らない —— flow の schema の
    // 既定値 (`$var:` 参照) が埋める。ledger は自分がコンテナからどう見えるかを
    // 知らないし、issuer の鍵も持っていないので、どちらもここでは決められない。
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(flowArgs(crawl)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // 本文まで読むのは、Windmill が理由を本文で返すから。status だけだと
      // 「404 でした」しか残らず、path の綴りなのか token なのかが分からない。
      const body = await res.text();
      throw new Error(`crawl webhook → ${String(res.status)} ${body.slice(0, 200)}`);
    }
    // 起こした job の id を返す。呼ぶ側は `crawls.last_job_id` に残し、失敗したクロールから
    // その run へ 1 回で辿れるようにする (`016`)。
    return jobIdFrom(await res.text());
  };
};
