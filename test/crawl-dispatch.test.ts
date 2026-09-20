/**
 * クロールを Windmill へ渡す webhook の本文。
 *
 * 以前は本文をその場で書き並べていて、受け口を足したとき `artifactSink` を型に足したまま
 * 載せ忘れた。flow の schema で `artifact_sink` は省略可能なので、何も落ちず、BrowserHive は
 * 黙って自前の保管庫へ書き続けた。見ているのは次の 2 つ:
 *
 * - 受け口が在れば `artifact_sink` が載り、無ければ鍵ごと載らないこと
 * - dispatcher が **実際に送る** 本文に受け口が載ること —— 組み立てが正しくても、
 *   dispatcher が使っていなければ意味が無い。だからこの試験のクロールは受け口を持たせてある
 *   (受け口の無いクロールでは、以前の 7 つを書き並べた本文とも一致してしまい区別できない)
 *
 * 欄の書き忘れそのものは試験ではなく typecheck が見る (`src/crawl/dispatch.ts` の対応表)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DispatchedCrawl } from "../src/api/crawls.js";
import { createWindmillDispatcher, flowArgs, jobIdFrom } from "../src/crawl/dispatch.js";

const CRAWL: DispatchedCrawl = {
  crawlId: "456a75bf-7082-49a7-86ce-e2fb24e879da",
  depth: 1,
  frontier: [{ url: "http://fixtures.test/links/a", host: "fixtures.test", lastFinishedAt: null }],
  perHostDelayMs: 3000,
  hostParallelism: 2,
  captureFormats: { png: false, webp: false, html: false, links: true, mhtml: false, wacz: true },
  signing: false,
  scripts: [
    {
      id: "autoscroll",
      version: 2,
      phase: "behavior",
      source: "(async () => {})();",
      sha256: "b".repeat(64),
      options: { maxSteps: 60 },
    },
  ],
};

const SINK = {
  url: "http://ledger.test:7070/api/sink/456a75bf-7082-49a7-86ce-e2fb24e879da",
  token: "1760000000.mac",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("webhook の本文", () => {
  it("受け口が在れば artifact_sink を載せる", () => {
    expect(flowArgs({ ...CRAWL, artifactSink: SINK })).toMatchObject({ artifact_sink: SINK });
  });

  it("受け口が無ければ artifact_sink の鍵そのものを送らない", () => {
    expect(flowArgs(CRAWL)).not.toHaveProperty("artifact_sink");
  });

  /**
   * 引数の数を書き写すのではなく、欄が全部 snake_case の名前で出ることを見る。
   * camelCase で届いた引数は、Windmill では「渡されていない」になる。
   */
  it("全ての欄を snake_case の引数名で、値を変えずに送る", () => {
    expect(flowArgs({ ...CRAWL, artifactSink: SINK })).toEqual({
      crawl_id: CRAWL.crawlId,
      depth: CRAWL.depth,
      frontier: CRAWL.frontier,
      per_host_delay_ms: CRAWL.perHostDelayMs,
      host_parallelism: CRAWL.hostParallelism,
      capture_formats: CRAWL.captureFormats,
      signing: CRAWL.signing,
      scripts: CRAWL.scripts,
      artifact_sink: SINK,
    });
  });

  /**
   * 走らせるものは **空でも送る**。受け口と違い、鍵ごと落とすと flow は「省かれた」と
   * 読み、BrowserHive へも何も渡らない —— それは「何も走らせない」と同じ結果になるが、
   * 台帳が何を頼んだのかを本文から読めなくなる。
   */
  it("走らせるものが空でも、scripts の鍵は送る", () => {
    expect(flowArgs({ ...CRAWL, scripts: [] })).toMatchObject({ scripts: [] });
  });

  it("dispatcher が送る本文に受け口が載る", async () => {
    vi.stubEnv(
      "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL",
      "http://windmill.test/api/w/crawl/jobs/run/f/crawl",
    );
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN", "webhook-token");
    // dispatcher は本文を JSON.stringify した文字列で渡す。
    const bodies: string[] = [];
    vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return Promise.resolve(new Response("job-id", { status: 201 }));
    });

    const dispatch = createWindmillDispatcher();
    expect(dispatch).toBeDefined();
    await dispatch!({ ...CRAWL, artifactSink: SINK });

    expect(bodies).toHaveLength(1);
    const body: unknown = JSON.parse(bodies[0]!);
    expect(body).toEqual(flowArgs({ ...CRAWL, artifactSink: SINK }));
    expect(body).toHaveProperty("artifact_sink", SINK);
  });
});

describe("起こした job の id", () => {
  const JOB = "0193b6a1-3c1d-7a2e-9f00-1234567890ab";

  const dispatchAnswering = async (body: string) => {
    vi.stubEnv(
      "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL",
      "http://windmill.test/api/w/crawl/jobs/run/f/crawl",
    );
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN", "webhook-token");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body, { status: 201 })));
    return createWindmillDispatcher()!(CRAWL);
  };

  it("Windmill が本文で返した id を返す", async () => {
    await expect(dispatchAnswering(JOB)).resolves.toBe(JOB);
  });

  it("JSON の文字列で来ても、前後の空白があっても読む", async () => {
    await expect(dispatchAnswering(`"${JOB}"\n`)).resolves.toBe(JOB);
  });

  it("id の形でなければ残さない（誤ったリンクを作らない）", async () => {
    await expect(dispatchAnswering("job-id")).resolves.toBeUndefined();
    expect(jobIdFrom("")).toBeUndefined();
  });
});
