/**
 * クロールを Windmill へ渡す webhook の本文。
 *
 * 以前は本文をその場で書き並べていて、受け取り先を足したとき `artifactSink` を型に足したまま
 * 載せ忘れた。flow の schema で `artifact_sink` は省略可能なので、何も落ちず、BrowserHive は
 * 黙って自前の保管庫へ書き続けた。見ているのは次の 2 つ:
 *
 * - 受け取り先が在れば `artifact_sink` が載り、無ければ鍵ごと載らないこと
 * - dispatcher が **実際に送る** 本文に受け取り先が載ること —— 組み立てが正しくても、
 *   dispatcher が使っていなければ意味が無い。だからこの試験のクロールは受け取り先を持たせてある
 *   (受け取り先の無いクロールでは、以前の 7 つを書き並べた本文とも一致してしまい区別できない)
 *
 * 欄の書き忘れそのものは試験ではなく typecheck が見る (`src/crawl/dispatch.ts` の対応表)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DispatchedCrawl } from "../src/api/crawls.js";
import { createWindmillDispatcher, flowArgs, jobIdFrom } from "../src/crawl/dispatch.js";
import { LEVEL_GIVE_UP_MS, levelDispatcher } from "../src/crawl/launch.js";
import { recordingDb } from "./recording-db.js";

const CRAWL: DispatchedCrawl = {
  crawlId: "456a75bf-7082-49a7-86ce-e2fb24e879da",
  depth: 1,
  levelKey: "7a1c0f00-5d2e-4b6a-9c3d-0000000000c1",
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
  variables: { query: "個人情報" },
  secrets: { api_token: "f/waggle_secrets/api_token" },
  secretArchive: { api_token: "keep" },
  userAgent: "{chrome} BrowserHive",
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
  it("受け取り先が在れば artifact_sink を載せる", () => {
    expect(flowArgs({ ...CRAWL, artifactSink: SINK })).toMatchObject({ artifact_sink: SINK });
  });

  it("受け取り先が無ければ artifact_sink の鍵そのものを送らない", () => {
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
      level_key: CRAWL.levelKey,
      frontier: CRAWL.frontier,
      per_host_delay_ms: CRAWL.perHostDelayMs,
      host_parallelism: CRAWL.hostParallelism,
      capture_formats: CRAWL.captureFormats,
      signing: CRAWL.signing,
      scripts: CRAWL.scripts,
      artifact_sink: SINK,
      variables: CRAWL.variables,
      secrets: CRAWL.secrets,
      secret_archive: CRAWL.secretArchive,
      user_agent: CRAWL.userAgent,
    });
  });

  /**
   * 走らせるものは **空でも送る**。受け取り先と違い、鍵ごと落とすと flow は「省かれた」と
   * 読み、BrowserHive へも何も渡らない —— それは「何も走らせない」と同じ結果になるが、
   * capture-ledger が何を頼んだのかを本文から読めなくなる。
   */
  it("走らせるものが空でも、scripts の鍵は送る", () => {
    expect(flowArgs({ ...CRAWL, scripts: [] })).toMatchObject({ scripts: [] });
  });

  /**
   * クロールごとの値も **空でも送る**。flow の省いた入力は null で届くので、鍵ごと落とすと crawl_host が
   * 「無い」を 2 通り（null と {}）読み分けることになる。形を 1 つに保つ。
   */
  it("頼まれた User-Agent が無ければ、空の字を鍵ごと送る（省くと crawl_host が null を受けて投げる）", () => {
    expect(flowArgs({ ...CRAWL, userAgent: "" })).toMatchObject({ user_agent: "" });
  });

  it("変数もシークレットも空なら、空の object を鍵ごと送る", () => {
    expect(flowArgs({ ...CRAWL, variables: {}, secrets: {}, secretArchive: {} })).toMatchObject({
      variables: {},
      secrets: {},
      secret_archive: {},
    });
  });

  it("WARC に残すシークレットが無くても、secret_archive を空の object で鍵ごと送る（省くと flow が null を運ぶ）", () => {
    const args = flowArgs({ ...CRAWL, secretArchive: {} });
    expect(args).toHaveProperty("secret_archive");
    expect(args["secret_archive"]).toEqual({});
  });

  it("dispatcher が送る本文に受け取り先が載る", async () => {
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

/**
 * 段の鍵で送る (CAPTURE-180)。webhook に `?job_id=<段の鍵>` を付け、Windmill の「在る id」の 400 は受け取り扱い。
 * 2026-11-12 に dev の Windmill CE 1.806.0 で確かめた答え: 同じ id の 2 回目は
 * `400 Bad request: Job with id <id> already exists` で、job は増えない。
 */
describe("段の鍵で送る", () => {
  const URL_ = "http://windmill.test/api/w/crawl/jobs/run/f/crawl";
  const answering = (status: number, body: string) => {
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL", URL_);
    vi.stubEnv("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN", "webhook-token");
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: URL) => {
      urls.push(String(url));
      return Promise.resolve(new Response(body, { status }));
    });
    return { dispatch: createWindmillDispatcher()!, urls };
  };

  it("webhook の URL に段の鍵を job_id で付ける —— 送り直しても Windmill は同じ id の job を 2 本作らない", async () => {
    const { dispatch, urls } = answering(201, `"${CRAWL.levelKey}"`);
    await expect(dispatch(CRAWL)).resolves.toBe(CRAWL.levelKey);
    expect(urls).toEqual([`${URL_}?job_id=${CRAWL.levelKey}`]);
  });

  it("同じ job_id の job が在るという 400 は、受け取られていたと読む（時間切れの後の送り直し）", async () => {
    const { dispatch } = answering(
      400,
      `Bad request: Job with id ${CRAWL.levelKey} already exists`,
    );
    await expect(dispatch(CRAWL)).resolves.toBe(CRAWL.levelKey);
  });

  it("ほかの 400 は受け取りではない（理由を本文ごと投げる）", async () => {
    const { dispatch } = answering(400, "Bad request: invalid args");
    await expect(dispatch(CRAWL)).rejects.toThrow("crawl webhook → 400 Bad request: invalid args");
  });
});

/**
 * 投げる係の時計 (`levelDispatcher` の `tick`)。受け取りを確かめられない段を同じ段の鍵で送り直し、
 * 段の行を作ってから 10 分で諦めてクロールを締める。
 */
describe("投げる係の時計", () => {
  const NOW = new Date("2026-11-12T10:00:00.000Z");
  const row = (createdAt: Date, crawlState = "running") => ({
    crawlId: CRAWL.crawlId,
    depth: CRAWL.depth,
    args: CRAWL,
    attempts: 3,
    lastError: "crawl webhook → 502",
    createdAt,
    crawlState,
  });
  const setup = (rows: object[], dispatch: () => Promise<string | undefined>) => {
    const { db, queries } = recordingDb([
      [], // 期限切れの始める要求の鍵を消す
      rows, // 受け取りを確かめられない段
      [], // 段の行を進める (受け取り確認済み・締めた)
      [{ id: CRAWL.crawlId }], // (諦めたとき) 走行中のクロールを締める (returning id)
    ]);
    const sent: DispatchedCrawl[] = [];
    const bundles: string[] = [];
    const levels = levelDispatcher({
      db,
      dispatch: (level) => {
        sent.push(level);
        return dispatch();
      },
      writeReplayBundle: (crawlId) => {
        bundles.push(crawlId);
        return Promise.resolve(undefined);
      },
      retryDelaysMs: [0, 0],
      now: () => NOW,
    });
    return { levels, queries, sent, bundles };
  };

  it("投げる前・投げたの段を、行が持つ段そのもの (args) で、同じ段の鍵のまま送り直す", async () => {
    const { levels, sent, queries } = setup([row(new Date(NOW.getTime() - 60_000))], () =>
      Promise.resolve(CRAWL.levelKey),
    );
    expect(await levels.tick()).toEqual({ sent: 1, abandoned: 0 });
    expect(sent).toEqual([CRAWL]);
    // 受け取られたので受け取り確認済みに。投げる前・投げたの行だけを進める
    const accepted = queries.find((q) =>
      q.sql.startsWith('update "crawl_levels" set "state" = $1'),
    );
    expect(accepted?.parameters[0]).toBe("accepted");
    expect(accepted?.sql).toContain('"state" in ($');
  });

  it("10 分経っても受け取られない段は送らずに諦め、走行中のクロールを failed で締めて合本を書く", async () => {
    const { levels, sent, queries, bundles } = setup(
      [row(new Date(NOW.getTime() - LEVEL_GIVE_UP_MS))],
      () => Promise.resolve(undefined),
    );
    expect(await levels.tick()).toEqual({ sent: 0, abandoned: 1 });
    expect(sent).toEqual([]);
    const abandon = queries.find((q) => q.sql.startsWith('update "crawl_levels" set "state" = $1'));
    expect(abandon?.parameters[0]).toBe("abandoned");
    const close = queries.find((q) => q.sql.startsWith('update "crawls" set "state" = $1'));
    expect(close?.parameters.slice(0, 2)).toEqual(["failed", "failed"]);
    expect(close?.parameters[3]).toContain("within 10 minutes (3 tries): crawl webhook → 502");
    expect(close?.sql).toContain('"state" = $');
    expect(bundles).toEqual([CRAWL.crawlId]);
  });

  it("締めたクロールの段は送らずに「締めた」にする", async () => {
    const { levels, sent, queries } = setup([row(new Date(NOW.getTime() - 60_000), "failed")], () =>
      Promise.resolve(CRAWL.levelKey),
    );
    expect(await levels.tick()).toEqual({ sent: 0, abandoned: 0 });
    expect(sent).toEqual([]);
    expect(
      queries.find((q) => q.sql.startsWith('update "crawl_levels" set "state" = $1'))
        ?.parameters[0],
    ).toBe("abandoned");
  });

  it("その場の送り直しは同じ段の鍵で 3 回まで。受け取られなければ「投げた」にして、クロールは締めない", async () => {
    const { levels, sent, queries } = setup([], () => Promise.reject(new Error("timeout")));
    levels.dispatchLevel(CRAWL);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(3);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(new Set(sent.map((level) => level.levelKey))).toEqual(new Set([CRAWL.levelKey]));
    const tried = queries.filter((q) => q.sql.startsWith('update "crawl_levels" set "state" = $1'));
    expect(tried.map((q) => q.parameters[0])).toEqual(["sent", "sent", "sent"]);
    expect(queries.some((q) => q.sql.startsWith('update "crawls" set "state"'))).toBe(false);
  });
});
