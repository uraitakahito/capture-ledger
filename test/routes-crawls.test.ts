import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import {
  registerCrawlRoutes,
  type CrawlRouteDeps,
  type DispatchedCrawl,
} from "../src/api/crawls.js";
import { parseCaptureFormats } from "../src/config/capture-formats.js";
import { prepareCrawl, type CrawlBody } from "../src/crawl/prepare.js";
import { WindmillUnreachable, type WindmillVariables } from "../src/crawl/windmill-variables.js";
import type {
  CrawlRule,
  CrawlScript,
  CrawlSecret,
  Database,
  ScriptParam,
} from "../src/db/database.js";
import {
  TsCompileUnreachable,
  type CompileAnswer,
  type TsCompile,
} from "../src/scripts/ts-compile.js";
import type { DerivationStore, NewDerivation } from "../src/derivations/store.js";
import type { FixModel, FixOutput, FixReply } from "../src/scripts/fix.js";

/**
 * クロールを始めるエンドポイントの検査。
 *
 * 2 層で見る。入口の検証は張りぼて deps で、認可と単一実行は
 * 偽の DB で見る。**認可そのものを見ているのではない** —— fga は「false を返せ」と
 * 言われて false を返しているだけで、`can_submit` が誰を拒むかは
 * `fga/model.fga.yaml` の assertion が見ている。
 */
const TOUCHED_DEPS = "deps を使った（検証を通過した証拠）";
const explode = (): never => {
  throw new Error(TOUCHED_DEPS);
};

const unreachableDeps = {
  db: new Proxy({}, { get: explode }),
  fga: new Proxy({}, { get: explode }),
  resolveIdentity: explode,
  dispatch: explode,
} as unknown as CrawlRouteDeps;

const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };
const UUID = "d272d256-e528-4581-bb4e-8d9477d78196";
const SEED = "https://site.test/start";

const buildApp = async (
  deps: CrawlRouteDeps,
  extra: { bodyLimit?: number } = {},
): Promise<FastifyInstance> => {
  // server.ts と同じ ajv 設定 —— 知らない鍵を落とさずに拒む。
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false } },
    ...extra,
  });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
    return reply.code(500).send({ error: "internal error" });
  });
  registerCrawlRoutes(app, deps);
  await app.ready();
  return app;
};

describe("クロール route の入力検証", () => {
  let app: FastifyInstance;
  const original = process.env["CAPTURE_LEDGER_DEV_IDENTITY"];

  beforeEach(async () => {
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
    app = await buildApp(unreachableDeps);
  });

  afterEach(async () => {
    await app.close();
    if (original === undefined) delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
    else process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = original;
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/crawls", headers: SUBJECT, payload });

  it("本文は 1 MiB まで —— エンドポイントが自分で決め、ちょうどは通り、1 バイト超えは 413（capture-workbench の門と同じ数）", async () => {
    // 数は直に書く。CRAWL_BODY_LIMIT を読むと、定数ごと変えた日に試験も一緒に動いてしまう
    const LIMIT = 1024 * 1024;
    // サーバ全体の上限をわざと 1 KiB にした app で見る。エンドポイントが自分の上限を書いていなければ、
    // ちょうど 1 MiB も 413 になる（Fastify の既定も 1 MiB なので、既定の app では区別が付かない）
    const small = await buildApp(unreachableDeps, { bodyLimit: 1024 });
    const shell = (source: string) =>
      JSON.stringify({
        seeds: [SEED],
        scripts: [{ inline: { name: "pad", phase: "behavior", source } }],
      });
    const body = (bytes: number) => shell("x".repeat(bytes - Buffer.byteLength(shell(""))));
    const send = (payload: string) =>
      small.inject({
        method: "POST",
        url: "/api/crawls",
        headers: { ...SUBJECT, "content-type": "application/json" },
        payload,
      });
    expect(Buffer.byteLength(body(LIMIT))).toBe(LIMIT);
    // ちょうどは検証まで通る（500 は deps に触れた＝検証を通過した証拠）
    expect((await send(body(LIMIT))).statusCode).toBe(500);
    expect((await send(body(LIMIT + 1))).statusCode).toBe(413);
    await small.close();
  });

  it("空の seeds を拒む", async () => {
    // 「どちらか一方」の判定は handler に置いてある (ajv の `oneOf` だと
    // 「どちらでもない」と「両方」が同じ 400 になり、言い分を分けられない)。
    // schema の層で落ちるのは、**配列として空**のときだけ。
    expect((await post({ seeds: [] })).statusCode).toBe(400);
  });

  it("rejects a body key that is not on the allowlist", async () => {
    expect((await post({ seeds: [SEED], signing: true })).statusCode).toBe(400);
  });

  it("scope はもう受けない —— 知らない鍵として 400（範囲は rules で書く）", async () => {
    // 黙って既定の規則で走らせると、頼んだ範囲と違うクロールが成功として出ていく
    expect((await post({ seeds: [SEED], scope: "same-host" })).statusCode).toBe(400);
  });

  it("規則の形が違えば schema の 400 —— 鍵が 0 か 2 つ・知らない動き・空・33 本・2049 字", async () => {
    const status = async (rules: unknown) => (await post({ seeds: [SEED], rules })).statusCode;
    expect(await status([{}])).toBe(400);
    expect(await status([{ follow: "same-host", skip: "ads.site.test" }])).toBe(400);
    expect(await status([{ crawl: "same-host" }])).toBe(400);
    expect(await status([{ follow: "" }])).toBe(400);
    expect(await status([])).toBe(400);
    expect(await status(Array.from({ length: 33 }, () => ({ follow: "same-host" })))).toBe(400);
    const pattern = (length: number) =>
      `https://site.test/${"a".repeat(length - "https://site.test/".length)}`;
    expect(await status([{ skip: pattern(2049) }])).toBe(400);
    // ちょうどの数と長さは schema を通る（500 は deps に触れた＝検証を通過した証拠）
    expect(await status(Array.from({ length: 32 }, () => ({ follow: "same-host" })))).toBe(500);
    expect(await status([{ skip: pattern(2048) }])).toBe(500);
  });

  it("rejects limits outside their range", async () => {
    expect((await post({ seeds: [SEED], maxPages: 0 })).statusCode).toBe(400);
    expect((await post({ seeds: [SEED], maxDepth: -1 })).statusCode).toBe(400);
    expect((await post({ seeds: [SEED], hostParallelism: 0 })).statusCode).toBe(400);
  });

  it("allows a zero delay so a test can take it away on purpose", async () => {
    // 0 を弾くと「間隔が効いている」の反証が書けなくなる。schema は通し、
    // 通った先で deps に触れて落ちる。
    expect((await post({ seeds: [SEED], perHostDelayMs: 0 })).statusCode).toBe(500);
  });

  it("rejects a crawl id that is not a uuid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/crawls/not-a-uuid",
      headers: SUBJECT,
    });
    expect(res.statusCode).toBe(400);
  });

  it("scriptIds はもう受けない —— 知らない鍵として 400", async () => {
    // 本文の schema は scripts の 1 列になった。古い呼び手を黙って既定で走らせない
    expect((await post({ seeds: [SEED], scriptIds: ["autoscroll"] })).statusCode).toBe(400);
  });

  it("scripts の要素は、鍵が 1 つの object だけを通す", async () => {
    const said = async (element: unknown) =>
      (await post({ seeds: [SEED], scripts: [element] })).json<{ message: string }>().message;
    const inline = { name: "close-banner", phase: "behavior", source: "x;" };
    expect(await said({ catalog: "autoscroll", inline })).toContain(
      "must NOT have more than 1 properties",
    );
    expect(await said({})).toContain("must NOT have fewer than 1 properties");
    expect(await said({ id: "autoscroll" })).toContain("must NOT have additional properties");
    // 形が合えば schema は通し、通った先で deps に触れて落ちる
    expect((await post({ seeds: [SEED], scripts: [{ catalog: "autoscroll" }] })).statusCode).toBe(
      500,
    );
    expect((await post({ seeds: [SEED], scripts: [{ inline }] })).statusCode).toBe(500);
  });

  it("その場の TS の名前の綴りが合わなければ 400 で、文は綴りの誤りだけを言う", async () => {
    // **oneOf にしない理由。** oneOf だと、この文に「catalog が要る」が混ざる
    const res = await post({
      seeds: [SEED],
      scripts: [{ inline: { name: "Close_Banner", phase: "behavior", source: "x;" } }],
    });
    expect(res.statusCode).toBe(400);
    const message = res.json<{ message: string }>().message;
    expect(message).toContain("/inline/name must match pattern");
    expect(message).not.toContain("catalog");
  });

  it("その場の TS の名前は、inline- と合わせて 64 字まで・phase は 2 つだけ", async () => {
    // ts-compile-service の ScriptId（^[a-z][a-z0-9-]*$・64 字）に収める。変換の段まで行って
    // 400 になると、失敗したクロールが残る
    const inline = (name: string, phase = "behavior") => ({
      seeds: [SEED],
      scripts: [{ inline: { name, phase, source: "x;" } }],
    });
    expect((await post(inline("a".repeat(57)))).statusCode).toBe(500);
    expect((await post(inline("a".repeat(58)))).statusCode).toBe(400);
    expect((await post(inline("close", "after-load"))).statusCode).toBe(400);
  });
});

/** 合本がまだ無い行の欄 (`027`・`028`)。本物の行は null を持つ。 */
const NO_REPLAY_BUNDLE = {
  replayBundleRev: null,
  replayBundleKey: null,
  replayBundlePages: null,
  replayBundleBuiltAt: null,
  replayBundleError: null,
  replayBundleSignedRev: null,
  replayBundleDigestKey: null,
  replayBundleSignError: null,
};

/** 手で始めたクロールの定期の欄 (`032`)。本物の行は null と 0 を持つ。 */
const NO_SCHEDULE = {
  scheduleId: null,
  scheduleName: null,
  scheduledFor: null,
  scheduleMissed: 0,
};

/** 認可と単一実行を見るための、最小の偽物。 */
interface FakeCrawl {
  id: string;
  seeds: string[];
  rules: CrawlRule[];
  state: string;
  maxDepth: number;
  maxPages: number;
  perHostDelayMs: number;
  hostParallelism: number;
  orgId: string;
  requestedBy: string;
  stopReason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  pagesDiscovered: number;
  pagesCaptured: number;
  error: string | null;
  lastJobId?: string | null;
  lastJobDepth?: number | null;
  /**
   * 一覧が返す WACZ の数。**偽 DB では数えていない** —— 本物は `crawl_pages` を
   * 挟んだ相関副問い合わせで、ここに在るのは「返ってきた値を route がそのまま
   * 載せるか」を見るための置き物。数え方そのものは実機に当てて確かめる
   * (`capture-ledger には DB 試験が無い`)。
   */
  waczCount?: number;
  /** 取れなかったページの数。`waczCount` と同じく、相関副問い合わせの答えの置き物。 */
  pagesFailed?: number;
  /**
   * 合本の欄 (`027`)。**本物の行は必ず持つ** (列が nullable なだけで、行から欄が消えることは無い) —— 偽物の
   * 行を作る所 (下の insert と一覧の `row`) は null で埋める。
   */
  replayBundleRev?: number | null;
  replayBundleKey?: string | null;
  replayBundlePages?: number | null;
  replayBundleBuiltAt?: Date | null;
  replayBundleError?: string | null;
  /** 署名の欄 (`028`)。同じく本物の行は必ず持つ。 */
  replayBundleSignedRev?: number | null;
  replayBundleDigestKey?: string | null;
  replayBundleSignError?: string | null;
  /** 解決済みの顔ぶれ。**行に固定されたもの**で、段ごとに引き直さない (`018`)。 */
  scripts: FakeScript[];
  /** クロールごとの値 (`024`)。本物の行は必ず持つ (NOT NULL DEFAULT) */
  variables: Record<string, string>;
  secrets: Record<string, CrawlSecret>;
  /** 頼まれた User-Agent (`031`)。本物の行は必ず持つ (nullable なだけ)。 */
  userAgent: string | null;
  /** 定期の回の欄 (`032`)。本物の行は必ず持つ。手で始めたクロールは null と 0 */
  scheduleId?: string | null;
  scheduleName?: string | null;
  scheduledFor?: Date | null;
  scheduleMissed?: number;
}

/** `scripts` の 1 行。解決の並びと、見つからない id の扱いを見るのに要る欄だけ。 */
interface FakeScript {
  id: string;
  version: number;
  phase: "preload" | "behavior";
  source: string;
  sha256: string;
  options: Record<string, unknown>;
  /** 対象サイト（`021`）。解決は引いた後に JS で絞るので、偽物も持っていればよい */
  sites: string[];
  /** 宣言（`024`）。本物の行は必ず持つ (NOT NULL DEFAULT '[]') */
  params: ScriptParam[];
  enabled: boolean;
}

/** `crawl_pages` の 1 行。`GET /api/crawls/:id` の `failures` を見るのに要る欄だけ。 */
interface FakePage {
  /** bigserial —— node-pg は int8 を文字列で返す */
  id: string;
  crawlId: string;
  url: string;
  depth: number;
  state: string;
  skipReason: string | null;
}

/** capture-ledger の受け皿の型 (`host_types`) の代役。直す係の決まりの文に載る。 */
const FAKE_HOST_TYPES = {
  version: 1,
  sha256: "1".repeat(64),
  createdAt: new Date(0),
  source: "declare var __bh: { report(id: string, data: unknown): void };\n",
  bytes: 64,
};

/**
 * 走行中を 1 本だけ許す偽の DB。本物は部分 unique index が守るので、ここでは同じ形の
 * 失敗（`23505` と制約名）を投げて、409 への翻訳だけを固定する。
 *
 * **index そのものはここでは証明できない** —— 制約を持っているのが偽物のほうだから。
 * 本物の Postgres に対して別途確かめること。
 */
const fakeDb = (
  crawls: FakeCrawl[],
  pages: FakePage[] = [],
  /** `updateTable(...).set(値)` の値を、呼ばれた順に積む。 */
  updates: Record<string, unknown>[] = [],
  scripts: FakeScript[] = [],
) => ({
  insertInto: (table: string) => ({
    values: (row: Record<string, unknown> | Record<string, unknown>[]) => ({
      /**
       * 深さ 0 の行は `onConflict(...).returning(...)` で入れる。
       *
       * **重複排除まで写す。**
       * 本物は `(crawl_id, url_hash)` の unique index が落とすので、
       * ここで素通しにすると「同じ URL を起点に 2 度書いても 2 回取る」という、
       * 本物では起きない振る舞いを試験が肯定してしまう。
       */
      onConflict: () => ({
        returning: () => ({
          execute: async (): Promise<{ url: string; host: string }[]> => {
            const rows = (Array.isArray(row) ? row : [row]) as { url: string; host: string }[];
            const seen = new Set<string>();
            return Promise.resolve(
              rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true))),
            );
          },
        }),
      }),
      execute: async (): Promise<void> => {
        if (table === "crawlPages") return Promise.resolve();
        if (crawls.some((c) => c.state === "running")) {
          const err = new Error("duplicate key") as Error & { code: string; constraint: string };
          err.code = "23505";
          err.constraint = "crawls_single_active_idx";
          throw err;
        }
        const inserting = row as unknown as FakeCrawl & {
          scripts: unknown;
          rules: unknown;
          variables: unknown;
          secrets: unknown;
        };
        crawls.push({
          ...inserting,
          rules:
            typeof inserting.rules === "string" ? (JSON.parse(inserting.rules) as CrawlRule[]) : [],
          // **jsonb は文字列で書いて、配列で読む。** 本物は node-pg が戻すので、
          // ここで写さないと「書いた形のまま読める」という、本物では起きない
          // 振る舞いを試験が肯定する。
          scripts:
            typeof inserting.scripts === "string"
              ? (JSON.parse(inserting.scripts) as FakeScript[])
              : [],
          // 値も jsonb (`024`)。同じく文字列で書いて object で読む
          variables:
            typeof inserting.variables === "string"
              ? (JSON.parse(inserting.variables) as Record<string, string>)
              : {},
          secrets:
            typeof inserting.secrets === "string"
              ? (JSON.parse(inserting.secrets) as Record<string, CrawlSecret>)
              : {},
          stopReason: null,
          startedAt: new Date(),
          finishedAt: null,
          pagesDiscovered: 0,
          pagesCaptured: 0,
          error: null,
          ...NO_REPLAY_BUNDLE,
          ...NO_SCHEDULE,
        });
        await Promise.resolve();
      },
    }),
  }),
  updateTable: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      /**
       * `where` は何度でも続き、`returning(...).execute()` で「実際に当たった行」を返す。
       *
       * **`state = 'running'` の条件まで写す。** 素通しにすると、終わったクロールに
       * 後から `failed` を被せる誤りが試験で見えなくなる。
       */
      const build = (conds: [string, unknown][]) => ({
        // 式で書いた条件 (`where((eb) => …)`) は写さない。見ているのは id と state だけ。
        where: (column: string | ((eb: unknown) => unknown), _op?: unknown, value?: unknown) =>
          typeof column === "function" ? build(conds) : build([...conds, [column, value]]),
        execute: async (): Promise<void> => Promise.resolve(),
        returning: () => ({
          execute: async (): Promise<{ id: string }[]> => {
            const id = conds.find(([c]) => c === "id")?.[1];
            const wantState = conds.find(([c]) => c === "state")?.[1];
            const row = crawls.find((c) => c.id === id);
            if (!row) return Promise.resolve([]);
            if (wantState !== undefined && row.state !== wantState) return Promise.resolve([]);
            row.state = "failed";
            return Promise.resolve([{ id: row.id }]);
          },
        }),
      });
      return build([]);
    },
  }),
  selectFrom: (table: string) => ({
    selectAll: () => ({
      // 予定の名前の相関副問い合わせ (`032`)。偽 DB では `scheduleName` を行に置くだけ
      select: () => ({
        where: (_c: unknown, _o: unknown, id: string) => ({
          executeTakeFirst: async (): Promise<FakeCrawl | undefined> =>
            Promise.resolve(crawls.find((c) => c.id === id)),
        }),
      }),
      where: (_c: unknown, _o: unknown, id: string) => ({
        executeTakeFirst: async (): Promise<FakeCrawl | undefined> =>
          Promise.resolve(crawls.find((c) => c.id === id)),
      }),
    }),
    /**
     * **問い合わせが指定した条件だけを当てる。** 最初は `enabled` を無条件に
     * 絞っていたが、それだと**本物から `enabled` の条件を外しても試験が緑のまま**に
     * なる (反証で素通りした)。偽物が制約を持っていると、消したことに気づけない。
     */
    select: () => {
      if (table === "hostTypes") {
        // `readHostTypes` の読み方 (いちばん新しい版の 1 行) だけを写す
        const query = {
          orderBy: () => query,
          limit: () => query,
          executeTakeFirst: async () => Promise.resolve(FAKE_HOST_TYPES),
        };
        return query;
      }
      if (table === "scripts") {
        /**
         * `resolveScripts` の読み方を写す。**条件は指定されたものだけを当てる**
         * (上の判断) —— 偽物が `enabled` で勝手に絞ると、
         * 本物からその条件が消えても試験は緑のままになる。
         */
        const scriptQuery = (where: [string, unknown, unknown][]) => ({
          distinctOn: () => scriptQuery(where),
          where: (column: string, op: unknown, value: unknown) =>
            scriptQuery([...where, [column, op, value]]),
          orderBy: () => scriptQuery(where),
          execute: async (): Promise<FakeScript[]> => {
            // **本物の Postgres は空の `in ()` を構文エラーで断る** (Kysely は空の配列を
            // そのまま `in ()` に組む。2026-10-14 に開発の DB で確かめた)。偽物も断らないと、
            // 「名指しが無ければ登録済みのスクリプトを引かない」分岐を外しても、試験は緑のままになる。
            if (where.some(([, op, value]) => op === "in" && (value as unknown[]).length === 0)) {
              throw new Error('syntax error at or near ")"');
            }
            const matched = scripts.filter((s) =>
              where.every(([column, op, value]) =>
                op === "in"
                  ? (value as unknown[]).includes((s as unknown as Record<string, unknown>)[column])
                  : (s as unknown as Record<string, unknown>)[column] === value,
              ),
            );
            // `distinctOn("id")` + `ORDER BY id, version DESC` = id ごとに最新版 1 本。
            const byId = new Map<string, FakeScript>();
            for (const row of [...matched].sort((a, b) => b.version - a.version)) {
              if (!byId.has(row.id)) byId.set(row.id, row);
            }
            return Promise.resolve([...byId.values()].sort((a, b) => a.id.localeCompare(b.id)));
          },
        });
        return scriptQuery([]);
      }
      if (table === "crawls") {
        /**
         * 409 の「走っている 1 本」と、一覧の両方が通る。**指定された条件・並び・上限
         * だけを当てる** (上の判断) —— 偽物が勝手に新しい順へ
         * 並べると、本物から `orderBy` が消えても試験は緑のままになる。
         */
        type Cond = [string, unknown, unknown];
        const crawlQuery = (
          where: Cond[],
          order?: { column: string; dir: string },
          limit?: number,
        ) => {
          const matched = (): FakeCrawl[] => {
            const cell = (c: FakeCrawl, column: string): unknown =>
              (c as unknown as Record<string, unknown>)[column];
            let rows = crawls.filter((c) =>
              where.every(([column, op, value]) =>
                op === "<"
                  ? (cell(c, column) as Date) < (value as Date)
                  : cell(c, column) === value,
              ),
            );
            if (order) {
              const { column, dir } = order;
              rows = [...rows].sort((a, b) => {
                const left = Number(cell(a, column));
                const right = Number(cell(b, column));
                return dir === "desc" ? right - left : left - right;
              });
            }
            return limit === undefined ? rows : rows.slice(0, limit);
          };
          return {
            where: (column: string, op: unknown, value: unknown) =>
              crawlQuery([...where, [column, op, value]], order, limit),
            orderBy: (column: string, dir: string) => crawlQuery(where, { column, dir }, limit),
            limit: (n: number) => crawlQuery(where, order, n),
            executeTakeFirst: async () => Promise.resolve(matched()[0]),
            execute: async () => Promise.resolve(matched()),
          };
        };
        return crawlQuery([]);
      }
      if (table === "crawlPages") {
        // `GET /api/crawls/:id` の `failures`。**指定された条件だけを当てる**（下と同じ理由）。
        const pageQuery = (where: [string, unknown][], limit: number | undefined) => ({
          where: (column: string, _op: unknown, value: unknown) =>
            pageQuery([...where, [column, value]], limit),
          orderBy: () => pageQuery(where, limit),
          limit: (n: number) => pageQuery(where, n),
          execute: async () => {
            const matched = pages.filter((p) =>
              where.every(
                ([column, value]) => (p as unknown as Record<string, unknown>)[column] === value,
              ),
            );
            // `count(*) over ()` の答え。窓関数は limit の前に数える
            const rows = matched.map((p) => ({ ...p, total: matched.length }));
            return Promise.resolve(limit === undefined ? rows : rows.slice(0, limit));
          },
        });
        return pageQuery([], undefined);
      }
      throw new Error(`偽の DB に無い表: ${table}`);
    },
  }),
});

/**
 * 既定のスクリプト。**空にしない** —— 登録済みのスクリプトが無い配備は `POST /api/crawls` が 400 で止めるので、
 * 空を既定にすると、この試験の大半が「スクリプトが無いから 400」を見ることになる。
 * 空そのものを見る試験は `scripts: []` と明示する。
 */
const DEFAULT_CATALOG: FakeScript[] = [
  {
    id: "autoscroll",
    version: 1,
    phase: "behavior",
    source: "(async () => {})();",
    sha256: "f".repeat(64),
    options: {},
    enabled: true,
    sites: [],
    params: [],
  },
];

/** 型の検査の偽物。全部通り、宣言は `declares` の物 (スクリプトの id → 変数の宣言)。 */
const compilesWith = (declares: Record<string, ScriptParam[]>): TsCompile => ({
  compile: (scripts) =>
    Promise.resolve({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      declarations: scripts.map((script) => ({
        id: script.id,
        params: declares[script.id] ?? [],
        unreadable: false,
      })),
    }),
});
const compilesAll = compilesWith({});

const depsWith = (opts: {
  crawls: FakeCrawl[];
  allowed: boolean;
  dispatch?: CrawlRouteDeps["dispatch"];
  pages?: FakePage[];
  updates?: Record<string, unknown>[];
  scripts?: FakeScript[];
  /** Windmill の変数のクライアント。省けば無い配備 (シークレットを宣言したクロールは 400) */
  windmill?: WindmillVariables;
  /** 型の検査のクライアント。省けば、宣言の無いスクリプトを全部通す偽物 */
  tsCompile?: TsCompile;
  /** 直す係の Claude・派生の層・月の上限。3 つ揃えば直しのエンドポイントが在る */
  fixModel?: FixModel;
  derivations?: DerivationStore;
  claudeBudgetUsd?: number;
  /** 締めた後に書いた合本 (クロールの id と深さ) を積む。 */
  bundles?: [string, number | null][];
  /** 締めた後の合本を書く係を、この誤りで落とす。 */
  bundleError?: Error;
  /** `CAPTURE_LEDGER_CAPTURE_FORMATS` の字。省けば `wacz` だけ */
  formats?: string;
}): CrawlRouteDeps =>
  ({
    db: fakeDb(opts.crawls, opts.pages, opts.updates, opts.scripts ?? DEFAULT_CATALOG),
    fga: { check: async () => Promise.resolve({ allowed: opts.allowed }) },
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    dispatch: opts.dispatch ?? (() => Promise.resolve()),
    // **本物の設定を使う。** 手書きの literal だと、`capture-formats.ts` が
    // 6 つ全部を返す約束を破っても、この試験は気づかない。
    capture: parseCaptureFormats(opts.formats ?? "wacz", false),
    ...(opts.windmill && { windmill: opts.windmill }),
    tsCompile: opts.tsCompile ?? compilesAll,
    ...(opts.fixModel && { fixModel: opts.fixModel }),
    ...(opts.derivations && { derivations: opts.derivations }),
    ...(opts.claudeBudgetUsd !== undefined && { claudeBudgetUsd: opts.claudeBudgetUsd }),
    writeReplayBundle: (crawlId: string, depth: number | null) => {
      if (opts.bundleError !== undefined) return Promise.reject(opts.bundleError);
      opts.bundles?.push([crawlId, depth]);
      return Promise.resolve(undefined);
    },
  }) as unknown as CrawlRouteDeps;

describe("クロール route の認可と単一実行", () => {
  it("refuses an unauthenticated caller", async () => {
    // 認可は通す側に倒してある。401 が fga より前で返っている証拠。
    const app = await buildApp({
      ...depsWith({ crawls: [], allowed: true }),
      resolveIdentity: () => Promise.resolve(undefined),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("hides the endpoint from a caller without permission", async () => {
    const app = await buildApp(depsWith({ crawls: [], allowed: false }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a seed that is not an http url", async () => {
    // schema は「文字列であること」しか見ない。scheme はここで落とす。
    const app = await buildApp(depsWith({ crawls: [], allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: ["ftp://site.test/x"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("起点を複数受け取り、全部を最初の段に渡す", async () => {
    const sent: { url: string }[][] = [];
    const app = await buildApp(
      depsWith({
        crawls: [],
        allowed: true,
        dispatch: (crawl) => {
          sent.push(crawl.frontier);
          return Promise.resolve(undefined);
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: ["https://a.site.test/1", "https://b.site.test/2"] },
    });
    expect(sent[0]?.map((f) => f.url)).toEqual(["https://a.site.test/1", "https://b.site.test/2"]);
    await app.close();
  });

  it("同じ起点を 2 度渡しても 1 度しか取らない", async () => {
    // 本物では `(crawl_id, url_hash)` の unique index が落とす。
    // **起点の段にも同じ守りが要る** —— 長い一覧に同じ URL が 2 度あることは普通にありうる。
    const sent: { url: string }[][] = [];
    const app = await buildApp(
      depsWith({
        crawls: [],
        allowed: true,
        dispatch: (crawl) => {
          sent.push(crawl.frontier);
          return Promise.resolve(undefined);
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED, SEED] },
    });
    expect(sent[0]).toHaveLength(1);
    await app.close();
  });

  it("読めない起点の URL が 1 本でもあれば拒む", async () => {
    // **黙って落とさない。** 落とすと、投げた側は全部辿ったつもりで結果を読む。
    const app = await buildApp(depsWith({ crawls: [], allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED, "ftp://site.test/x"] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts a crawl and answers 202 without waiting for it", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toHaveProperty("crawlId");
    expect(crawls[0]?.state).toBe("running");
    await app.close();
  });

  it("深さ 0 のクロールにも links を頼む", async () => {
    // **辿らなくても数える。** 頼まないと、そのページのリンクが何本でも画面の数は 0 になる。
    const sent: { links: boolean }[] = [];
    const app = await buildApp(
      depsWith({
        crawls: [],
        allowed: true,
        dispatch: (crawl) => {
          sent.push(crawl.captureFormats);
          return Promise.resolve(undefined);
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED], maxDepth: 0 },
    });
    expect(sent).toEqual([expect.objectContaining({ links: true })]);
    await app.close();
  });

  it("stores the defaults when the caller asks for nothing", async () => {
    // 既定は控えめな側。**30 が効いていること**が、上限で止まる普通の姿を作る。
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    await app.inject({ method: "POST", url: "/api/crawls", payload: { seeds: [SEED] } });
    expect(crawls[0]).toMatchObject({
      rules: [{ follow: "same-origin" }],
      maxDepth: 2,
      maxPages: 30,
      perHostDelayMs: 2000,
      hostParallelism: 4,
    });
    await app.close();
  });

  it("normalizes the seed before storing it", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: ["https://site.test/start#top"] },
    });
    expect(crawls[0]?.seeds?.[0]).toBe("https://site.test/start");
    await app.close();
  });

  it("refuses a second crawl while one is in flight", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const first = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(crawls).toHaveLength(1);
    await app.close();
  });

  it("answers 404 for a crawl that does not exist", async () => {
    const app = await buildApp(depsWith({ crawls: [], allowed: true }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("409 は、塞いでいる 1 本の id と開始時刻を返す", async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const first = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: "a crawl is already in progress",
      crawlId: first.json<{ crawlId: string }>().crawlId,
      startedAt: crawls[0]?.startedAt.toISOString(),
    });
    await app.close();
  });

  it("投げた段の job の id を、その深さと一緒に残す", async () => {
    const updates: Record<string, unknown>[] = [];
    const JOB = "0193b6a1-3c1d-7a2e-9f00-1234567890ab";
    const app = await buildApp(
      depsWith({ crawls: [], allowed: true, updates, dispatch: () => Promise.resolve(JOB) }),
    );
    await app.inject({ method: "POST", url: "/api/crawls", payload: { seeds: [SEED] } });
    // 投げるのは待たない (応答が先に返る) ので、残すのは次の tick。
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates).toContainEqual({ lastJobId: JOB, lastJobDepth: 0 });
    await app.close();
  });

  it("job の id が返らなければ、何も書かない", async () => {
    const updates: Record<string, unknown>[] = [];
    const app = await buildApp(
      depsWith({ crawls: [], allowed: true, updates, dispatch: () => Promise.resolve(undefined) }),
    );
    await app.inject({ method: "POST", url: "/api/crawls", payload: { seeds: [SEED] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates.filter((u) => "lastJobId" in u)).toEqual([]);
    await app.close();
  });

  it("段を投げられなければ走っているクロールを締め、終わった状態の合本を書く", async () => {
    // 次の段が無いので、ここで書かなければ誰も書かない (`/failed` と同じ)
    const crawls: FakeCrawl[] = [];
    const bundles: [string, number | null][] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        bundles,
        dispatch: () => Promise.reject(new Error("crawl webhook → 502")),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      payload: { seeds: [SEED] },
    });
    const { crawlId } = res.json<{ crawlId: string }>();
    await vi.waitFor(() => {
      expect(bundles).toEqual([[crawlId, null]]);
    });
    expect(crawls[0]?.state).toBe("failed");
    await app.close();
  });

  it("段を投げられなくても、先に締められていれば上書きせず、合本も書かない", async () => {
    const crawls: FakeCrawl[] = [];
    const bundles: [string, number | null][] = [];
    let fail: (err: Error) => void = () => undefined;
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        bundles,
        dispatch: () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      }),
    );
    await app.inject({ method: "POST", url: "/api/crawls", payload: { seeds: [SEED] } });
    // webhook の答えを待つ間に、flow が `/failed` で締めた (とする)
    const first = crawls[0];
    if (first !== undefined) first.state = "succeeded";
    fail(new Error("crawl webhook → 502"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(crawls[0]?.state).toBe("succeeded");
    expect(bundles).toEqual([]);
    await app.close();
  });

  const finishedCrawl: FakeCrawl = {
    id: UUID,
    seeds: [SEED],
    rules: [{ follow: "same-origin" }],
    state: "succeeded",
    maxDepth: 0,
    maxPages: 30,
    perHostDelayMs: 2000,
    hostParallelism: 4,
    orgId: "acme",
    requestedBy: "alice",
    stopReason: "completed",
    startedAt: new Date("2026-09-19T00:00:00Z"),
    finishedAt: new Date("2026-09-19T00:00:10Z"),
    pagesDiscovered: 2,
    pagesCaptured: 1,
    error: null,
    lastJobId: "0193b6a1-3c1d-7a2e-9f00-1234567890ab",
    lastJobDepth: 0,
    ...NO_REPLAY_BUNDLE,
    ...NO_SCHEDULE,
    scripts: [
      {
        id: "autoscroll",
        version: 2,
        phase: "behavior",
        source: "(async () => {})();",
        sha256: "c".repeat(64),
        options: {},
        enabled: true,
        sites: [],
        params: [],
      },
    ],
    variables: {},
    userAgent: null,
    secrets: {},
  };

  it("GET は定期の回の予定の名前と本来の時刻と欠けを返す", async () => {
    const app = await buildApp(
      depsWith({
        crawls: [
          {
            ...finishedCrawl,
            scheduleId: "44444444-4444-4444-8444-444444444444",
            scheduleName: "毎朝",
            scheduledFor: new Date("2026-09-19T00:00:00Z"),
            scheduleMissed: 2,
          },
        ],
        allowed: true,
      }),
    );
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    await app.close();
    expect(res.json()).toMatchObject({
      schedule: { id: "44444444-4444-4444-8444-444444444444", name: "毎朝" },
      scheduledFor: "2026-09-19T00:00:00.000Z",
      scheduleMissed: 2,
    });
  });

  it("GET は手で始めた行の schedule を null で返す", async () => {
    const app = await buildApp(depsWith({ crawls: [finishedCrawl], allowed: true }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    await app.close();
    expect(res.json()).toMatchObject({ schedule: null, scheduledFor: null, scheduleMissed: 0 });
  });

  it("GET は最後の段の job と、取れなかったページとその理由とページの id を返す", async () => {
    const pages: FakePage[] = [
      {
        id: "1",
        crawlId: UUID,
        url: "https://site.test/ok",
        depth: 0,
        state: "captured",
        skipReason: null,
      },
      {
        id: "2",
        crawlId: UUID,
        url: "https://nonexistent.invalid/",
        depth: 0,
        state: "failed",
        skipReason: "net::ERR_NAME_NOT_RESOLVED",
      },
    ];
    const app = await buildApp(depsWith({ crawls: [finishedCrawl], allowed: true, pages }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rules: [{ follow: "same-origin" }],
      lastJob: { id: "0193b6a1-3c1d-7a2e-9f00-1234567890ab", depth: 0 },
    });
    // 欄は 4 つちょうど。ページの id から `/pages/:page/log` へ辿れる
    expect(res.json<{ failures: unknown[] }>().failures).toEqual([
      {
        page: "2",
        url: "https://nonexistent.invalid/",
        depth: 0,
        reason: "net::ERR_NAME_NOT_RESOLVED",
      },
    ]);
    expect(res.json<{ pagesFailed: number }>().pagesFailed).toBe(1);
    await app.close();
  });

  it("取れなかった数は、5 件に切る前の全体を言う", async () => {
    const pages = Array.from({ length: 7 }, (_, index) => ({
      id: String(index + 1),
      crawlId: UUID,
      url: `https://site.test/${String(index)}`,
      depth: 1,
      state: "failed",
      skipReason: "http_error: HTTP 404: Not Found",
    }));
    const app = await buildApp(depsWith({ crawls: [finishedCrawl], allowed: true, pages }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    const body = res.json<{ pagesFailed: number; failures: unknown[] }>();
    expect(body.failures).toHaveLength(5);
    expect(body.pagesFailed).toBe(7);
    await app.close();
  });

  it("取れなかったページが無ければ、取れなかった数は 0", async () => {
    const app = await buildApp(depsWith({ crawls: [finishedCrawl], allowed: true, pages: [] }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.json<{ pagesFailed: number }>().pagesFailed).toBe(0);
    await app.close();
  });

  it("GET は、job の記録が無ければ lastJob を null にする", async () => {
    const crawl = {
      id: UUID,
      seeds: [SEED],
      rules: [{ follow: "same-origin" }],
      state: "running",
      maxDepth: 0,
      maxPages: 30,
      perHostDelayMs: 2000,
      hostParallelism: 4,
      orgId: "acme",
      requestedBy: "alice",
      stopReason: null,
      startedAt: new Date(),
      finishedAt: null,
      pagesDiscovered: 1,
      pagesCaptured: 0,
      error: null,
      lastJobId: null,
      lastJobDepth: null,
      ...NO_REPLAY_BUNDLE,
      ...NO_SCHEDULE,
      scripts: [],
      variables: {},
      userAgent: null,
      secrets: {},
    } satisfies FakeCrawl;
    const app = await buildApp(depsWith({ crawls: [crawl], allowed: true }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.json()).toMatchObject({ lastJob: null, failures: [], replayBundle: null });
    await app.close();
  });

  it("GET は capture-ledger が指す合本の鍵・版・頁の数・時刻と、その後に書けなかった理由を返す", async () => {
    const crawl = {
      id: UUID,
      seeds: [SEED],
      rules: [{ follow: "same-origin" }],
      state: "succeeded",
      maxDepth: 1,
      maxPages: 30,
      perHostDelayMs: 2000,
      hostParallelism: 4,
      orgId: "acme",
      requestedBy: "alice",
      stopReason: "completed",
      startedAt: new Date(),
      finishedAt: new Date(),
      pagesDiscovered: 3,
      pagesCaptured: 3,
      error: null,
      lastJobId: null,
      lastJobDepth: null,
      // r2 を書けた (署名した) 後、r3 が書けなかった
      replayBundleRev: 2,
      replayBundleKey: `org/acme/crawls/${UUID}/r2/replay.json`,
      replayBundlePages: 6,
      replayBundleBuiltAt: new Date("2026-11-05T03:30:00.000Z"),
      replayBundleError: "could not write r3 to the store: Access Denied",
      replayBundleSignedRev: 2,
      replayBundleDigestKey: `org/acme/crawls/${UUID}/r2/replay-digest.json`,
      replayBundleSignError: null,
      scripts: [],
      variables: {},
      userAgent: null,
      secrets: {},
    } satisfies FakeCrawl;
    const app = await buildApp(depsWith({ crawls: [crawl], allowed: true }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}` });
    expect(res.json<{ replayBundle: unknown }>().replayBundle).toEqual({
      key: `org/acme/crawls/${UUID}/r2/replay.json`,
      rev: 2,
      pages: 6,
      builtAt: "2026-11-05T03:30:00.000Z",
      error: "could not write r3 to the store: Access Denied",
      signedRev: 2,
      digestKey: `org/acme/crawls/${UUID}/r2/replay-digest.json`,
      signError: null,
    });
    await app.close();
  });
});

describe("起点の一覧", () => {
  const post = async (payload: Record<string, unknown>) => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const res = await app.inject({ method: "POST", url: "/api/crawls", payload });
    await app.close();
    return { res, crawls };
  };

  it("起点が無ければ、必須だと言う 400", async () => {
    const { res, crawls } = await post({});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "seeds is required" });
    expect(crawls).toEqual([]);
  });

  it("名乗らない {} は 401（本文の検査で 400 にしない）", async () => {
    // capture-scheduler の doctor は、名乗らずに `{}` を投げて 401 が返ることで、このエンドポイントが在ることを
    // 確かめている。`seeds` を schema の `required` に書くと、ここが 400 になる。
    const app = await buildApp({
      ...depsWith({ crawls: [], allowed: true }),
      resolveIdentity: () => Promise.resolve(undefined),
    });
    const res = await app.inject({ method: "POST", url: "/api/crawls", payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("保存された頼みに起点が無くても、500 にせず 400 で断る", async () => {
    // 「固定し直す」は保存された予定の頼みを読み直すので、schema を通らない。ここに来るまでに
    // fromTargets で作られた予定が、この形になる。
    const answer = await prepareCrawl(
      {
        db: fakeDb([]) as unknown as Kysely<Database>,
        tsCompile: compilesAll,
        formats: parseCaptureFormats("wacz", false).formats,
      },
      { fromTargets: {} } as unknown as CrawlBody,
      { orgId: "acme", subject: "alice" },
    );
    expect(answer).toEqual({
      kind: "refused",
      status: 400,
      body: { error: "seeds is required" },
    });
  });

  it("fromTargets は知らない鍵として 400", async () => {
    const { res, crawls } = await post({ fromTargets: true });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toBe(
      "body must NOT have additional properties",
    );
    expect(crawls).toEqual([]);
  });

  it("明示された深さは勝つ", async () => {
    const { crawls } = await post({ seeds: [SEED], maxDepth: 0 });
    expect(crawls[0]?.maxDepth).toBe(0);
  });

  it("max_pages が起点の数を下回らない", async () => {
    // 既定の 30 のままだと、起点が 30 本を超えた瞬間に黙って切り落とされる。
    const seeds = Array.from({ length: 31 }, (_, i) => `https://site.test/${String(i)}`);
    const { crawls } = await post({ seeds });
    expect(crawls[0]?.maxPages).toBe(31);
  });

  it("明示された max_pages は起点の数を下回っても勝つ", async () => {
    const { crawls } = await post({ seeds: [`${SEED}a`, `${SEED}b`], maxPages: 1 });
    expect(crawls[0]?.maxPages).toBe(1);
  });
});

describe("落ちた段を受けて締める", () => {
  const running = (): FakeCrawl[] => [{ id: UUID, state: "running" }] as unknown as FakeCrawl[];

  const post = async (
    crawls: FakeCrawl[],
    body: Record<string, unknown> = {},
    bundles: [string, number | null][] = [],
    bundleError?: Error,
  ) => {
    const app = await buildApp(
      depsWith({ crawls, allowed: true, bundles, ...(bundleError && { bundleError }) }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${UUID}/failed`,
      payload: body,
    });
    await app.close();
    return res;
  };

  it("締めたら、終わった状態の合本を 1 本書いてから答える（深さは記録しない）", async () => {
    // flow は落ちた段の後に合本のエンドポイントを叩かない。ここで書かないと、最後の合本は走っている時の物のまま残る
    const bundles: [string, number | null][] = [];
    const crawls = running();
    const res = await post(crawls, { reason: "BrowserHive に届きません" }, bundles);
    expect(res.json()).toEqual({ closed: true });
    expect(bundles).toEqual([[UUID, null]]);
    expect(crawls[0]?.state).toBe("failed");
  });

  it("締めるものが無ければ、合本を書かない", async () => {
    const bundles: [string, number | null][] = [];
    const res = await post(
      [{ id: UUID, state: "succeeded" }] as unknown as FakeCrawl[],
      {},
      bundles,
    );
    expect(res.json()).toEqual({ closed: false });
    expect(bundles).toEqual([]);
  });

  it("合本が書けなくても（書く係が投げても）、締めたことを答える", async () => {
    const crawls = running();
    const res = await post(crawls, {}, [], new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ closed: true });
    expect(crawls[0]?.state).toBe("failed");
  });

  it("走行中のものを締める", async () => {
    // **これが無いと、flow が段の途中で落ちたクロールが永久に走行中になる。**
    // 部分 unique index が以後のクロールを全部塞ぐ (実測で踏んだ)。
    const crawls = running();
    const res = await post(crawls, { reason: "BrowserHive に届きません" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"closed":true');
    expect(crawls[0]?.state).toBe("failed");
  });

  it("終わったものには被せない", async () => {
    // 段の失敗が遅れて届くことはある。そのとき既に別の段が締めていれば、
    // **そちらの理由のほうが正しい。**
    const crawls = [{ id: UUID, state: "succeeded" }] as unknown as FakeCrawl[];
    const res = await post(crawls);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"closed":false');
    expect(crawls[0]?.state).toBe("succeeded");
  });

  it("知らない id でも 200 で「締めるものが無い」と答える", async () => {
    // 締める相手が無いのは異常ではない。呼ぶ側 (failure_module) は
    // どのみち投げない立場なので、ここで 404 にしても誰も読まない。
    const res = await post([]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"closed":false');
  });

  it("権限が無ければ 404", async () => {
    const app = await buildApp(depsWith({ crawls: running(), allowed: false }));
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${UUID}/failed`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("知らない鍵は拒む", async () => {
    const res = await post(running(), { reason: "x", extra: 1 });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * **何を走らせるかは、クロールを始めた時点で決まる。**
 *
 * BrowserHive v11.0.0 から、サーバは走らせるものの顔ぶれを持たない。送らなければ
 * ページでは何も走らず、それでも取り込みは成功して archive も出る —— 送り忘れが
 * 見えない劣化になる唯一の欄なので、決め方と運び方をここで固定する。
 */
describe("走らせるものの解決", () => {
  const CATALOG: FakeScript[] = [
    {
      id: "autofetch",
      version: 1,
      phase: "behavior",
      source: "(async () => { /* fetch */ })();",
      sha256: "a".repeat(64),
      options: {},
      enabled: true,
      sites: [],
      params: [],
    },
    {
      id: "autoscroll",
      version: 1,
      phase: "behavior",
      source: "(async () => { /* v1 */ })();",
      sha256: "b".repeat(64),
      options: {},
      enabled: true,
      sites: [],
      params: [],
    },
    {
      id: "autoscroll",
      version: 2,
      phase: "behavior",
      source: "(async () => { /* v2 */ })();",
      sha256: "c".repeat(64),
      options: { maxSteps: 60 },
      enabled: true,
      sites: [],
      params: [],
    },
    {
      id: "hide-webdriver",
      version: 1,
      phase: "preload",
      source: "delete navigator.webdriver;",
      sha256: "d".repeat(64),
      options: {},
      enabled: false,
      sites: [],
      params: [],
    },
  ];

  const start = async (payload: Record<string, unknown>) => {
    const crawls: FakeCrawl[] = [];
    const sent: { id: string; version: number }[][] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        scripts: CATALOG,
        dispatch: (crawl) => {
          sent.push(crawl.scripts.map((s) => ({ id: s.id, version: s.version })));
          return Promise.resolve(undefined);
        },
      }),
    );
    const res = await app.inject({ method: "POST", url: "/api/crawls", headers: SUBJECT, payload });
    await app.close();
    return { res, sent, crawls };
  };

  it("何も指定しなければ、有効な各 id の最新版が走る", async () => {
    // 無効な `hide-webdriver` は入らず、`autoscroll` は v1 ではなく v2。
    const { res, sent } = await start({ seeds: [SEED] });
    expect(res.statusCode).toBe(202);
    expect(sent[0]).toEqual([
      { id: "autofetch", version: 1 },
      { id: "autoscroll", version: 2 },
    ]);
  });

  it("名指しした並びが、そのまま実行順になる", async () => {
    // **id 順に並べ替えない。** behavior は書かれた順に走るので、並びは指示の一部。
    const { sent } = await start({
      seeds: [SEED],
      scripts: [{ catalog: "autoscroll" }, { catalog: "autofetch" }],
    });
    expect(sent[0]).toEqual([
      { id: "autoscroll", version: 2 },
      { id: "autofetch", version: 1 },
    ]);
  });

  it("無効にした版でも、名指しすれば走る", async () => {
    // `enabled` が決めるのは「既定に入るか」だけ。名指しは明示なので通す。
    const { sent } = await start({ seeds: [SEED], scripts: [{ catalog: "hide-webdriver" }] });
    expect(sent[0]).toEqual([{ id: "hide-webdriver", version: 1 }]);
  });

  it("空配列を渡せば、何も走らない", async () => {
    // 「既定でよい」(省く) と「何も走らせない」([]) は別の意思。
    const { res, sent } = await start({ seeds: [SEED], scripts: [] });
    expect(res.statusCode).toBe(202);
    expect(sent[0]).toEqual([]);
  });

  it("登録されていない id は 400 で名指しし、クロールを立てない", async () => {
    // **黙って落とさない。** 落とすと、頼んだ側は全部走ったつもりで結果を読む。
    const { res, sent, crawls } = await start({
      seeds: [SEED],
      scripts: [{ catalog: "autoscroll" }, { catalog: "typo-scroll" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown script ids", ids: ["typo-scroll"] });
    expect(sent).toEqual([]);
    expect(crawls).toEqual([]);
  });

  it("行に固定するのは解決済みの source で、id ではない", async () => {
    // 登録済みのスクリプトは後から変わりうる。段をまたいで同じコードが走ることの根拠がこれ。
    const { crawls } = await start({ seeds: [SEED], scripts: [{ catalog: "autoscroll" }] });
    expect(crawls[0]?.scripts).toEqual([
      {
        id: "autoscroll",
        version: 2,
        phase: "behavior",
        source: "(async () => { /* v2 */ })();",
        sha256: "c".repeat(64),
        options: { maxSteps: 60 },
        sites: [],
        params: [],
      },
    ]);
  });

  /**
   * **登録済みのスクリプトが無い配備は、ここで止まる。** 通すと、スクロールも遅延読み込みもしない
   * クロールが「成功」として出ていく —— アーカイブは出るので、後から見分ける手が無い。
   */
  it("既定を頼まれたのに登録済みのスクリプトが無いなら、400 で止めてクロールを立てない", async () => {
    const crawls: FakeCrawl[] = [];
    const sent: unknown[] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        scripts: [],
        dispatch: (crawl) => {
          sent.push(crawl);
          return Promise.resolve(undefined);
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      headers: SUBJECT,
      payload: { seeds: [SEED] },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "no scripts are registered",
      hint: "pnpm run scripts import .upstream/capture-scripts (run nothing on purpose: send scripts: [])",
    });
    // **行を立てない。** 立てると部分 unique index が以後のクロールを全部塞ぐ。
    expect(crawls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("登録済みのスクリプトが無くても、[] と明示すれば通る", async () => {
    // 設定漏れと「何も走らせない」という意思は別物。後者を表せなくしない。
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true, scripts: [] }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      headers: SUBJECT,
      payload: { seeds: [SEED], scripts: [] },
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.scripts).toEqual([]);
  });

  it("GET は登録済みのスクリプトに身元だけを返す —— source は返さない", async () => {
    // 何が走っているかを知るのに要るのは「どれの何版か」。中身は capture-ledger と archive に在る。
    const { crawls } = await start({ seeds: [SEED], scripts: [{ catalog: "autoscroll" }] });
    const app = await buildApp(depsWith({ crawls, allowed: true, scripts: CATALOG }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${crawls[0]!.id}` });
    await app.close();

    const body = res.json<{ scripts: Record<string, unknown>[] }>();
    // 走った JS の hash と変換の記録は、最初の段の報告で埋まる。始めた直後はまだ無い (null)。
    expect(body.scripts).toEqual([
      {
        id: "autoscroll",
        version: 2,
        phase: "behavior",
        sha256: "c".repeat(64),
        sites: [],
        jsSha256: null,
        compiledWith: null,
      },
    ]);
    expect(res.body).not.toContain("/* v2 */");
  });

  const INLINE = {
    name: "close-banner",
    phase: "preload",
    source: "(() => {\n  void 0;\n})();\n",
  } as const;
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("その場の TS は inline- の id・版 1・options 空で写り、sha256 は capture-ledger が source から打つ", async () => {
    const { res, crawls } = await start({ seeds: [SEED], scripts: [{ inline: INLINE }] });
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.scripts).toEqual([
      {
        id: "inline-close-banner",
        version: 1,
        phase: "preload",
        source: INLINE.source,
        sha256: sha256(INLINE.source),
        options: {},
      },
    ]);
  });

  it("その場の TS と登録済みのスクリプトの名指しを、頼んだ並びのまま 1 列に写す", async () => {
    const { sent } = await start({
      seeds: [SEED],
      scripts: [{ catalog: "autoscroll" }, { inline: INLINE }, { catalog: "autofetch" }],
    });
    expect(sent[0]).toEqual([
      { id: "autoscroll", version: 2 },
      { id: "inline-close-banner", version: 1 },
      { id: "autofetch", version: 1 },
    ]);
  });

  it("その場の TS だけなら、登録済みのスクリプトを引かない", async () => {
    // 偽の DB は、本物の Postgres と同じく空の in () を断る。引けば 500 になる
    const { res, sent } = await start({ seeds: [SEED], scripts: [{ inline: INLINE }] });
    expect(res.statusCode).toBe(202);
    expect(sent[0]).toEqual([{ id: "inline-close-banner", version: 1 }]);
  });

  it("同じ id を 2 度頼むと 400 で名指しし、クロールを立てない", async () => {
    // 報告 (id@版) でも変換 (/src/<id>.ts) でも、2 本目が 1 本目に黙って畳まれる
    const cases: [unknown[], string[]][] = [
      [
        [{ catalog: "autoscroll" }, { catalog: "autofetch" }, { catalog: "autoscroll" }],
        ["autoscroll"],
      ],
      [[{ inline: INLINE }, { inline: { ...INLINE, phase: "behavior" } }], ["inline-close-banner"]],
    ];
    for (const [scripts, ids] of cases) {
      const { res, sent, crawls } = await start({ seeds: [SEED], scripts });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "duplicate script ids", ids });
      expect(sent).toEqual([]);
      expect(crawls).toEqual([]);
    }
  });

  it("GET の inline は名前・phase・バイト数だけ —— source は運ばない", async () => {
    // 走行中の行は workbench が 2 秒ごとに引き直す。source を載せると、1 MiB の TS なら 2 秒に 1 MiB
    const { crawls } = await start({
      seeds: [SEED],
      scripts: [{ inline: INLINE }, { catalog: "autoscroll" }],
    });
    const app = await buildApp(depsWith({ crawls, allowed: true, scripts: CATALOG }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${crawls[0]!.id}` });
    await app.close();

    const body = res.json<{ scripts: Record<string, unknown>[] }>();
    expect(body.scripts[0]).toEqual({
      id: "inline-close-banner",
      version: 1,
      phase: "preload",
      sha256: sha256(INLINE.source),
      sites: [],
      jsSha256: null,
      compiledWith: null,
      inline: { name: INLINE.name, phase: INLINE.phase, bytes: Buffer.byteLength(INLINE.source) },
    });
    expect(body.scripts[1]).not.toHaveProperty("inline");
    expect(body.scripts[1]).not.toHaveProperty("source");
    expect(res.body, "その場の TS の source が詳しい所に在る").not.toContain("void 0");
    expect(res.body).not.toContain("/* v2 */");
  });

  /** 始めた行を 1 本持つ偽の DB に、名前で引くエンドポイントを 1 回打つ。 */
  const askInline = async (name: string, opts: { allowed?: boolean; id?: string } = {}) => {
    const { crawls } = await start({
      seeds: [SEED],
      scripts: [{ inline: INLINE }, { catalog: "autoscroll" }],
    });
    const app = await buildApp(
      depsWith({ crawls, allowed: opts.allowed ?? true, scripts: CATALOG }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/crawls/${opts.id ?? crawls[0]!.id}/inline/${name}`,
    });
    await app.close();
    return res;
  };

  it("その場の TS は、名前で引くエンドポイントから source ごと返る（欄に戻すため）", async () => {
    const res = await askInline("close-banner");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "close-banner",
      phase: "preload",
      source: INLINE.source,
      sha256: sha256(INLINE.source),
    });
  });

  it("登録済みのスクリプト・知らない名前・無いクロールは 404", async () => {
    // 登録済みのスクリプトは capture-ledger と archive に在る。名前で引くエンドポイントは、その場の TS だけを返す
    expect((await askInline("autoscroll")).statusCode).toBe(404);
    expect((await askInline("nope")).statusCode).toBe(404);
    expect((await askInline("close-banner", { id: UUID })).statusCode).toBe(404);
  });

  it("許可の無い名乗りには 404 —— 在るかどうかを言わない", async () => {
    const res = await askInline("close-banner", { allowed: false });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("void 0");
  });

  it("名前の綴りが違えば、許可を見る前に 400", async () => {
    // `POST /api/crawls` の本文と同じ schema。unreachableDeps は触れれば投げるので、400 は deps の手前で断った証拠
    const app = await buildApp(unreachableDeps);
    const res = await app.inject({ method: "GET", url: `/api/crawls/${UUID}/inline/Close_Banner` });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

/**
 * クロールの一覧。
 *
 * **数え方そのものはここでは見えない。** `waczCount` は `crawl_pages` を挟んだ相関
 * 副問い合わせで、偽 DB はそれを実行しない —— ここで見るのは「返ってきた値を route が
 * そのまま載せるか」まで。数えられているかは実機に当てて確かめた（PR に出力を貼る）。
 *
 * 並びは**偽物に並べさせて**いる。入力をわざと古い順で渡すので、本物から
 * `orderBy` が消えれば、この試験は赤くなる。
 */
describe("型の誤りを取り直すエンドポイント", () => {
  const INLINE = {
    name: "close-banner",
    phase: "behavior",
    source: "const close = (el) => el.click();\n",
  } as const;
  const DIAGNOSTIC = {
    file: "inline-close-banner.ts",
    line: 1,
    col: 16,
    code: "TS7006",
    message: "Parameter 'el' implicitly has an 'any' type.",
  };

  /** その場の TS と登録済みのスクリプトで 1 本始め、webhook に渡った列をそのまま控える。 */
  const startCapturing = async () => {
    const crawls: FakeCrawl[] = [];
    const sent: CrawlScript[][] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        dispatch: (crawl) => {
          sent.push(crawl.scripts);
          return Promise.resolve(undefined);
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      headers: SUBJECT,
      payload: { seeds: [SEED], scripts: [{ inline: INLINE }, { catalog: "autoscroll" }] },
    });
    await app.close();
    expect(res.statusCode).toBe(202);
    return { crawls, sent };
  };

  /** 頼まれた列を控えて、決めた答えを返す偽のクライアント。 */
  const fakeCompile = (answer: CompileAnswer | Error) => {
    const asked: (readonly CrawlScript[])[] = [];
    const tsCompile: TsCompile = {
      compile(scripts) {
        asked.push(scripts);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    };
    return { asked, tsCompile };
  };

  const ask = async (
    crawls: FakeCrawl[],
    tsCompile: TsCompile | undefined,
    opts: { allowed?: boolean; id?: string } = {},
  ) => {
    const app = await buildApp(
      depsWith({ crawls, allowed: opts.allowed ?? true, ...(tsCompile && { tsCompile }) }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/crawls/${opts.id ?? crawls[0]!.id}/diagnostics`,
    });
    await app.close();
    return res;
  };

  it("落ちたクロールの組み合わせを、webhook と同じ形で ts-compile に送り直す", async () => {
    const { crawls, sent } = await startCapturing();
    const { asked, tsCompile } = fakeCompile({
      ok: false,
      typescript: "6.0.3",
      declarations: [],
      missingVariables: [],
      diagnostics: [DIAGNOSTIC],
    });
    await ask(crawls, tsCompile);
    expect(asked).toHaveLength(1);
    // 登録済みのスクリプトも入っている —— 一緒に走る物の重なり (TS2451) は、組み合わせでしか起きない
    expect(asked[0]!.map((s) => s.id)).toEqual(["inline-close-banner", "autoscroll"]);
    expect(asked[0]).toEqual(sent[0]);
  });

  it("誤りを、スクリプトの id・行・列・code・文で返す", async () => {
    const { crawls } = await startCapturing();
    const { tsCompile } = fakeCompile({
      ok: false,
      typescript: "6.0.3",
      declarations: [],
      missingVariables: [],
      diagnostics: [DIAGNOSTIC, { file: "lib.dom.d.ts", code: "TS2300", message: "dup" }],
    });
    const res = await ask(crawls, tsCompile);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      typescript: "6.0.3",
      diagnostics: [
        {
          script: "inline-close-banner",
          line: 1,
          col: 16,
          code: "TS7006",
          message: DIAGNOSTIC.message,
        },
        { file: "lib.dom.d.ts", code: "TS2300", message: "dup" },
      ],
    });
  });

  it("通る組み合わせなら、誤りは空で、受け皿の型の版も返す", async () => {
    const { crawls } = await startCapturing();
    const { tsCompile } = fakeCompile({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      declarations: [],
    });
    const res = await ask(crawls, tsCompile);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ typescript: "6.0.3", hostTypes: "v0.6.0", diagnostics: [] });
  });

  it("ts-compile に届かなければ 503", async () => {
    const { crawls } = await startCapturing();
    const { tsCompile } = fakeCompile(new TsCompileUnreachable("POST …/compile: ECONNREFUSED"));
    const res = await ask(crawls, tsCompile);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "ts-compile unreachable" });
  });

  it("行の変数の名前を渡して検査する", async () => {
    const { crawls } = await startCapturing();
    crawls[0]!.variables = { query: "個人情報" };
    const names: (readonly string[])[] = [];
    const tsCompile: TsCompile = {
      compile: (_scripts, variableNames) => {
        names.push(variableNames);
        return Promise.resolve({
          ok: true,
          typescript: "6.0.3",
          hostTypes: "v0.6.0",
          declarations: [],
        });
      },
    };
    await ask(crawls, tsCompile);
    expect(names).toEqual([["query"]]);
  });

  it("許可の無い名乗りにも、無いクロールにも 404（ts-compile は呼ばない）", async () => {
    const { crawls } = await startCapturing();
    const { asked, tsCompile } = fakeCompile({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      declarations: [],
    });
    expect((await ask(crawls, tsCompile, { allowed: false })).statusCode).toBe(404);
    expect((await ask(crawls, tsCompile, { id: UUID })).statusCode).toBe(404);
    expect(asked).toHaveLength(0);
  });

  it("id の綴りが違えば、許可を見る前に 400", async () => {
    const { tsCompile } = fakeCompile({
      ok: true,
      typescript: "6.0.3",
      hostTypes: "v0.6.0",
      declarations: [],
    });
    const app = await buildApp({ ...unreachableDeps, tsCompile });
    const res = await app.inject({ method: "GET", url: "/api/crawls/not-a-uuid/diagnostics" });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

describe("直しのエンドポイント", () => {
  const INLINE = {
    name: "press",
    phase: "behavior",
    source: "(() => {\n  const press = (el) => el.click();\n  void press;\n})();\n",
  } as const;
  const FIXED_LINE = "  const press = (el: HTMLElement) => el.click();";
  const GOOD: FixOutput = {
    edits: [{ from: 2, to: 2, text: FIXED_LINE }],
    notes: [{ code: "TS7006", line: 2, why: "引数 el に型を書いた" }],
  };
  const BROKEN: CompileAnswer = {
    ok: false,
    typescript: "6.0.3",
    declarations: [],
    missingVariables: [],
    diagnostics: [
      {
        file: "inline-press.ts",
        line: 2,
        col: 18,
        code: "TS7006",
        message: "Parameter 'el' implicitly has an 'any' type.",
      },
    ],
  };
  const PASSES: CompileAnswer = {
    ok: true,
    typescript: "6.0.3",
    hostTypes: "v0.6.0",
    declarations: [],
  };

  const reply = (output: FixOutput | null): FixReply => ({
    output,
    content: [{ type: "text", text: JSON.stringify(output) }],
    model: "claude-opus-5-5",
    attempts: [
      {
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 3100,
          output_tokens: 900,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ],
    stopReason: "end_turn",
  });

  const fakes = (opts: { compile: CompileAnswer[]; replies?: FixReply[]; spent?: number }) => {
    const compiled: (readonly CrawlScript[])[] = [];
    const tsCompile: TsCompile = {
      compile(scripts) {
        compiled.push(scripts);
        const next = opts.compile.shift();
        return next === undefined
          ? Promise.reject(new Error("検査が多すぎる"))
          : Promise.resolve(next);
      },
    };
    const proposed: unknown[] = [];
    const fixModel: FixModel = {
      effort: "medium",
      propose(request) {
        proposed.push(request);
        const next = opts.replies?.shift();
        return next === undefined
          ? Promise.reject(new Error("頼みが多すぎる"))
          : Promise.resolve(next);
      },
    };
    const rows: NewDerivation[] = [];
    const derivations: DerivationStore = {
      spentThisMonth: () => Promise.resolve(opts.spent ?? 0),
      record: (row) => {
        rows.push(row);
        return Promise.resolve();
      },
    };
    return { compiled, proposed, rows, tsCompile, fixModel, derivations };
  };

  const startWithInline = async () => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const res = await app.inject({
      method: "POST",
      url: "/api/crawls",
      headers: SUBJECT,
      payload: { seeds: [SEED], scripts: [{ inline: INLINE }, { catalog: "autoscroll" }] },
    });
    await app.close();
    expect(res.statusCode).toBe(202);
    return crawls;
  };

  const askFix = async (
    crawls: FakeCrawl[],
    f: ReturnType<typeof fakes> | undefined,
    opts: { allowed?: boolean; id?: string; name?: string; budget?: number } = {},
  ) => {
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: opts.allowed ?? true,
        ...(f && {
          tsCompile: f.tsCompile,
          fixModel: f.fixModel,
          derivations: f.derivations,
          claudeBudgetUsd: opts.budget ?? 5,
        }),
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${opts.id ?? crawls[0]!.id}/inline/${opts.name ?? INLINE.name}/fix`,
      headers: { ...SUBJECT, "content-type": "application/json" },
      payload: {},
    });
    await app.close();
    return res;
  };

  it("型の通る案なら 200 で、差分・理由・回数・費用を返し、派生の層に残す", async () => {
    const crawls = await startWithInline();
    const f = fakes({ compile: [BROKEN, PASSES], replies: [reply(GOOD)] });
    const res = await askFix(crawls, f);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      rounds: number;
      edits: unknown[];
      notes: unknown[];
      source: string;
      compiled: unknown;
      usage: { usd: number };
    }>();
    expect(body.rounds).toBe(1);
    expect(body.edits).toEqual([
      { from: 2, to: 2, before: ["  const press = (el) => el.click();"], after: [FIXED_LINE] },
    ]);
    expect(body.notes).toEqual(GOOD.notes);
    expect(body.source).toContain(FIXED_LINE);
    expect(body.compiled).toEqual({ typescript: "6.0.3", hostTypes: "v0.6.0" });
    expect(body.usage.usd).toBeCloseTo(0.0304, 4);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({
      kind: "fix",
      orgId: "acme",
      crawlId: crawls[0]!.id,
      target: { crawlId: crawls[0]!.id, inline: "press" },
      model: "claude-opus-5-5",
      promptVersion: "fix/4",
      effort: "medium",
      rounds: 1,
      createdBy: "alice",
      output: { kind: "fixed" },
    });
  });

  it("組み合わせが型を通るなら 409 で、Claude を呼ばない", async () => {
    const crawls = await startWithInline();
    const f = fakes({ compile: [PASSES] });
    const res = await askFix(crawls, f);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "scripts compile" });
    expect(f.proposed).toHaveLength(0);
    expect(f.rows).toHaveLength(0);
  });

  it("必須の変数が足りないだけなら 422 で、Claude を呼ばない", async () => {
    const crawls = await startWithInline();
    const f = fakes({
      compile: [
        {
          ok: false,
          typescript: "6.0.3",
          diagnostics: [
            { file: "inline-press.ts", line: 2, col: 7, code: "BH0001", message: "渡されていない" },
          ],
          declarations: [],
          missingVariables: ["query"],
        },
      ],
    });
    const res = await askFix(crawls, f);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "missing variables", names: ["query"] });
    expect(f.rows).toHaveLength(0);
  });

  it("誤りが登録済みのスクリプトにだけなら 422 で、Claude を呼ばない", async () => {
    const crawls = await startWithInline();
    const f = fakes({
      compile: [
        {
          ok: false,
          typescript: "6.0.3",
          declarations: [],
          missingVariables: [],
          diagnostics: [{ file: "autoscroll.ts", line: 1, col: 1, code: "TS2304", message: "x" }],
        },
      ],
    });
    const res = await askFix(crawls, f);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: "no errors in this inline script",
      diagnostics: [{ script: "autoscroll", code: "TS2304" }],
    });
    expect(f.proposed).toHaveLength(0);
  });

  it("組織の月の上限に届いていれば 429 で、Claude を呼ばない", async () => {
    const crawls = await startWithInline();
    const f = fakes({ compile: [BROKEN], spent: 5 });
    const res = await askFix(crawls, f, { budget: 5 });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "claude budget exhausted", spentUsd: 5, budgetUsd: 5 });
    expect(f.proposed).toHaveLength(0);
    expect(f.rows).toHaveLength(0);
  });

  it("2 回で通らなければ 422 で、最後の誤りと費用を返し、派生の層にも残す", async () => {
    const crawls = await startWithInline();
    const f = fakes({ compile: [BROKEN, BROKEN, BROKEN], replies: [reply(GOOD), reply(GOOD)] });
    const res = await askFix(crawls, f);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "no fix passed the checks", rounds: 2 });
    expect(res.json<{ usage: { usd: number } }>().usage.usd).toBeGreaterThan(0);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ rounds: 2, output: { kind: "failed" } });
  });

  it("鍵が無い配備ではエンドポイントを作らない", async () => {
    const crawls = await startWithInline();
    const res = await askFix(crawls, undefined);
    expect(res.statusCode).toBe(404);
  });

  it("許可の無い名乗り・登録済みのスクリプト・無いクロールには 404（検査も Claude も呼ばない）", async () => {
    const crawls = await startWithInline();
    const f = fakes({ compile: [] });
    expect((await askFix(crawls, f, { allowed: false })).statusCode).toBe(404);
    expect((await askFix(crawls, f, { name: "autoscroll" })).statusCode).toBe(404);
    expect((await askFix(crawls, f, { id: UUID })).statusCode).toBe(404);
    expect(f.compiled).toHaveLength(0);
    expect(f.proposed).toHaveLength(0);
  });

  it("本文に知らない鍵があれば、許可を見る前に 400", async () => {
    const f = fakes({ compile: [] });
    const app = await buildApp({
      ...unreachableDeps,
      tsCompile: f.tsCompile,
      fixModel: f.fixModel,
      derivations: f.derivations,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${UUID}/inline/press/fix`,
      payload: { model: "claude-haiku-5-5" },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });
});

describe("クロールの一覧", () => {
  const row = (over: Partial<FakeCrawl> & { id: string; startedAt: Date }): FakeCrawl => ({
    seeds: [SEED],
    rules: [{ follow: "same-origin" }],
    state: "succeeded",
    maxDepth: 2,
    maxPages: 30,
    perHostDelayMs: 2000,
    hostParallelism: 4,
    orgId: "acme",
    requestedBy: "alice",
    stopReason: "completed",
    finishedAt: null,
    pagesDiscovered: 1,
    pagesCaptured: 1,
    error: null,
    // **本物は必ず null を返す** (列が nullable なだけで、行から欄が消えることは無い)。
    // 既定を undefined にすると、route の `=== null` を素通りして lastJob が
    // { id: undefined } になる —— 偽物の形が本物と違うと、試験が嘘をつく。
    lastJobId: null,
    lastJobDepth: null,
    ...NO_REPLAY_BUNDLE,
    ...NO_SCHEDULE,
    scripts: [],
    variables: {},
    userAgent: null,
    secrets: {},
    ...over,
  });

  const OLD = row({ id: "11111111-1111-4111-8111-111111111111", startedAt: new Date(1) });
  const NEW = row({ id: "22222222-2222-4222-8222-222222222222", startedAt: new Date(2) });

  /** 一覧が返す行のうち、この試験が読む欄だけ。 */
  interface ListedCrawl {
    crawlId: string;
    state: string;
    stopReason: string | null;
    maxDepth: number;
    orgId: string;
    waczCount: number;
    pagesFailed: number;
    lastJob: { id: string; depth: number } | null;
  }
  const ids = (res: { json: <T>() => T }): string[] =>
    res.json<{ crawls: ListedCrawl[] }>().crawls.map((c) => c.crawlId);

  const list = async (deps: CrawlRouteDeps, url = "/api/crawls") => {
    const app = await buildApp(deps);
    const res = await app.inject({ method: "GET", url });
    await app.close();
    return res;
  };

  it("名乗らない呼び出し元には 401", async () => {
    // 認可は通す側に倒してある。401 が fga より前で返っている証拠。
    const res = await list({
      ...depsWith({ crawls: [NEW], allowed: true }),
      resolveIdentity: () => Promise.resolve(undefined),
    });
    expect(res.statusCode).toBe(401);
  });

  it("権限が無ければ、404 でも 403 でもなく空を返す", async () => {
    // 「在るが見せない」と「無い」を呼び出し元に区別させない (`/api/archives` と同じ作法)。
    const res = await list(depsWith({ crawls: [NEW, OLD], allowed: false }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ crawls: [] });
  });

  it("新しい順に並べる —— 古い順で渡しても、新しいほうが先に出る", async () => {
    const res = await list(depsWith({ crawls: [OLD, NEW], allowed: true }));
    expect(ids(res)).toEqual([NEW.id, OLD.id]);
  });

  it("手で始めた行は schedule が null で、定期の回は予定の名前と本来の時刻と欠けを返す", async () => {
    const scheduled = row({
      id: "33333333-3333-4333-8333-333333333333",
      startedAt: new Date(3),
      scheduleId: "44444444-4444-4444-8444-444444444444",
      scheduleName: "毎朝",
      scheduledFor: new Date(2),
      scheduleMissed: 3,
    });
    const res = await list(depsWith({ crawls: [OLD, scheduled], allowed: true }));
    const { crawls } = res.json<{ crawls: Record<string, unknown>[] }>();
    expect(crawls[0]).toMatchObject({
      crawlId: scheduled.id,
      schedule: { id: "44444444-4444-4444-8444-444444444444", name: "毎朝" },
      scheduledFor: new Date(2).toISOString(),
      scheduleMissed: 3,
    });
    expect(crawls[1]).toMatchObject({
      crawlId: OLD.id,
      schedule: null,
      scheduledFor: null,
      scheduleMissed: 0,
    });
  });

  it("state で絞る", async () => {
    const running = row({
      id: "33333333-3333-4333-8333-333333333333",
      startedAt: new Date(3),
      state: "running",
      stopReason: null,
    });
    const res = await list(
      depsWith({ crawls: [OLD, NEW, running], allowed: true }),
      "/api/crawls?state=running",
    );
    expect(ids(res)).toEqual([running.id]);
  });

  it("before より前だけを返す —— カーソルの綴りは archives と同じ", async () => {
    const res = await list(
      depsWith({ crawls: [OLD, NEW], allowed: true }),
      `/api/crawls?before=${NEW.startedAt.toISOString()}`,
    );
    expect(ids(res)).toEqual([OLD.id]);
  });

  it("日時でない before は 400 —— SQL のパラメータにしない", async () => {
    // `new Date("きのう")` は投げずに Invalid Date を返すので、schema で落とさないと
    // Postgres が拒んで 500 になる。
    const res = await list(depsWith({ crawls: [], allowed: true }), "/api/crawls?before=きのう");
    expect(res.statusCode).toBe(400);
  });

  it("state だけでは足りない欄を、行に載せる", async () => {
    // 打ち切り (`max_depth`) と完走 (`completed`) は state が同じ。org と run の行き先も、
    // workbench が「どこまで見えているか」を言うのに要る。
    const truncated = row({
      id: "44444444-4444-4444-8444-444444444444",
      startedAt: new Date(4),
      stopReason: "max_depth",
      maxDepth: 0,
      orgId: "other",
      lastJobId: "01a0bfad",
      lastJobDepth: 2,
      waczCount: 3,
      pagesFailed: 2,
    });
    const res = await list(depsWith({ crawls: [truncated], allowed: true }));
    expect(res.json<{ crawls: ListedCrawl[] }>().crawls[0]).toMatchObject({
      state: "succeeded",
      stopReason: "max_depth",
      maxDepth: 0,
      orgId: "other",
      waczCount: 3,
      pagesFailed: 2,
      lastJob: { id: "01a0bfad", depth: 2 },
    });
  });

  it("起こしていない段の run は null", async () => {
    const res = await list(depsWith({ crawls: [NEW], allowed: true }));
    expect(res.json<{ crawls: ListedCrawl[] }>().crawls[0]?.lastJob).toBeNull();
  });

  it("合本の欄を行に載せる（書けた合本も、書けなかった記録も無ければ null）", async () => {
    // 行の列から組む —— workbench は走っているクロールを 2 秒ごとに引くので、保管庫は読まない
    const bundled = row({
      id: "55555555-5555-4555-8555-555555555555",
      startedAt: new Date(5),
      replayBundleRev: 3,
      replayBundleKey: "org/acme/crawls/55555555-5555-4555-8555-555555555555/r3/replay.json",
      replayBundlePages: 12,
      replayBundleBuiltAt: new Date("2026-11-05T03:30:00.000Z"),
      replayBundleError: null,
      // r2 は署名した。指す r3 には署名が付かなかった (署名した版は指す版とは別に動く)
      replayBundleSignedRev: 2,
      replayBundleDigestKey:
        "org/acme/crawls/55555555-5555-4555-8555-555555555555/r2/replay-digest.json",
      replayBundleSignError: "http://wacz-signer.test:8080/sign — returned 502",
    });
    const res = await list(depsWith({ crawls: [bundled, NEW], allowed: true }));
    const crawls = res.json<{ crawls: (ListedCrawl & { replayBundle: unknown })[] }>().crawls;
    expect(crawls[0]?.replayBundle).toEqual({
      key: "org/acme/crawls/55555555-5555-4555-8555-555555555555/r3/replay.json",
      rev: 3,
      pages: 12,
      builtAt: "2026-11-05T03:30:00.000Z",
      error: null,
      signedRev: 2,
      digestKey: "org/acme/crawls/55555555-5555-4555-8555-555555555555/r2/replay-digest.json",
      signError: "http://wacz-signer.test:8080/sign — returned 502",
    });
    expect(crawls[1]?.replayBundle).toBeNull();
  });

  it("1 度も書けずに失敗だけなら、合本の欄は error だけが値を持つ", async () => {
    const failed = row({
      id: "66666666-6666-4666-8666-666666666666",
      startedAt: new Date(6),
      replayBundleError: "could not write r1 to the store: Access Denied",
    });
    const res = await list(depsWith({ crawls: [failed], allowed: true }));
    expect(res.json<{ crawls: { replayBundle: unknown }[] }>().crawls[0]?.replayBundle).toEqual({
      key: null,
      rev: null,
      pages: null,
      builtAt: null,
      error: "could not write r1 to the store: Access Denied",
      signedRev: null,
      digestKey: null,
      signError: null,
    });
  });
});

describe("対象サイト（サイト用のスクリプト）と起点", () => {
  const base = {
    phase: "behavior" as const,
    source: "(() => {})();",
    options: {},
    enabled: true,
    params: [],
  };
  const SITED: FakeScript[] = [
    { ...base, id: "autoscroll", version: 1, sha256: "a".repeat(64), sites: [] },
    { ...base, id: "example-title", version: 1, sha256: "b".repeat(64), sites: ["site.test"] },
    {
      ...base,
      id: "google-results",
      version: 1,
      sha256: "c".repeat(64),
      sites: ["www.google.com"],
    },
  ];

  const startWith = async (scripts: FakeScript[], payload: Record<string, unknown>) => {
    const crawls: FakeCrawl[] = [];
    const dispatched: Record<string, unknown>[][] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        scripts,
        dispatch: (crawl) => {
          dispatched.push(crawl.scripts as unknown as Record<string, unknown>[]);
          return Promise.resolve(undefined);
        },
      }),
    );
    const res = await app.inject({ method: "POST", url: "/api/crawls", headers: SUBJECT, payload });
    await app.close();
    return { res, crawls, dispatched, ids: dispatched[0]?.map((script) => script["id"]) };
  };

  it("省いた頼みには、対象サイトの無い物と、起点のホスト名に合う物が走る（id 順）", async () => {
    const { res, ids } = await startWith(SITED, { seeds: [SEED] });
    expect(res.statusCode).toBe(202);
    expect(ids).toEqual(["autoscroll", "example-title"]);
  });

  it("起点のポートは見ない（:8080 の起点も対象サイトのホスト名に合う）", async () => {
    const { ids } = await startWith(SITED, { seeds: ["http://site.test:8080/x"] });
    expect(ids).toEqual(["autoscroll", "example-title"]);
  });

  it("www の有無は別のホスト（起点が www.site.test なら、site.test 用は入らない）", async () => {
    const { ids } = await startWith(SITED, { seeds: ["https://www.site.test/"] });
    expect(ids).toEqual(["autoscroll"]);
  });

  it("起点に合わないサイト用のスクリプトを名指すと 400 で名指し、クロールは立たない", async () => {
    const { res, crawls } = await startWith(SITED, {
      seeds: [SEED],
      scripts: [{ catalog: "autoscroll" }, { catalog: "google-results" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "site scripts need a seed on their site",
      ids: ["google-results"],
      hint: "google-results: www.google.com",
    });
    expect(crawls).toHaveLength(0);
  });

  it("起点に合うサイト用のスクリプトは名指せる。合う物を名指さない（外す）のも自由", async () => {
    const named = await startWith(SITED, {
      seeds: [SEED],
      scripts: [{ catalog: "example-title" }],
    });
    expect(named.res.statusCode).toBe(202);
    const without = await startWith(SITED, { seeds: [SEED], scripts: [{ catalog: "autoscroll" }] });
    expect(without.ids).toEqual(["autoscroll"]);
  });

  it("登録済みのスクリプトが全部別のサイト用なら、省いた頼みは「この起点で走る物が無い」で断る（スクリプトが無いとは言わない）", async () => {
    const { res } = await startWith(
      SITED.filter((script) => script.sites.length > 0),
      { seeds: ["https://other.test/"] },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "no default scripts for these seeds",
      hint: "example-title: site.test / google-results: www.google.com (run nothing on purpose: send scripts: [])",
    });
  });

  it("クロールの行の写しには対象サイトが入り、flow へ送る scripts には入らない（最初の段も）", async () => {
    const { crawls, dispatched } = await startWith(SITED, { seeds: [SEED] });
    expect(crawls[0]?.scripts.map((script) => script.sites)).toEqual([[], ["site.test"]]);
    expect(dispatched[0]?.every((script) => !("sites" in script))).toBe(true);
  });
});

describe("規則の並びで始める", () => {
  const start = async (payload: Record<string, unknown>) => {
    const crawls: FakeCrawl[] = [];
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const res = await app.inject({ method: "POST", url: "/api/crawls", payload });
    await app.close();
    return { status: res.statusCode, body: res.json<Record<string, unknown>>(), crawls };
  };
  const www = "https://www.site.test/";

  it("読んだ形で固定する —— 前方一致は正規化した URL、ドメインと範囲は書いたまま", async () => {
    const { status, crawls } = await start({
      seeds: [www],
      rules: [
        { skip: "HTTPS://WWW.Site.test:443/search" },
        { skip: "ads.site.test" },
        { follow: "same-site" },
        { capture: "any" },
      ],
    });
    expect(status).toBe(202);
    expect(crawls[0]?.rules).toEqual([
      { skip: "https://www.site.test/search" },
      { skip: "ads.site.test" },
      { follow: "same-site" },
      { capture: "any" },
    ]);
  });

  it("読めない当てる物は 400 で、番号と頼まれた当てる物を名指し、クロールを立てない", async () => {
    const { status, body, crawls } = await start({
      seeds: [SEED],
      rules: [{ follow: "same-host" }, { skip: "ADS.site.test" }],
    });
    expect(status).toBe(400);
    expect(body).toEqual({
      error: "invalid rule patterns",
      rules: [{ rule: 2, pattern: "ADS.site.test" }],
    });
    expect(crawls).toEqual([]);
  });

  it("前の規則に覆われた規則は 400 で、覆っている規則の番号と一緒に名指す", async () => {
    const { status, body, crawls } = await start({
      seeds: [www],
      rules: [{ follow: "same-site" }, { skip: "ads.site.test" }],
    });
    expect(status).toBe(400);
    expect(body).toEqual({
      error: "rules that can never match",
      rules: [{ rule: 2, coveredBy: 1 }],
    });
    expect(crawls).toEqual([]);
  });

  it("起点を撮って辿らない並びは 400 で、その起点を名指す", async () => {
    const { status, body, crawls } = await start({
      seeds: [www, "https://ads.site.test/"],
      rules: [{ skip: "ads.site.test" }, { follow: "same-site" }],
    });
    expect(status).toBe(400);
    expect(body).toEqual({
      error: "seeds the rules do not follow",
      seeds: ["https://ads.site.test/"],
    });
    expect(crawls).toEqual([]);
  });
});

/**
 * クロールごとの値 (変数とシークレット。`024`)。宣言に照らす判断は `crawl-values.test.ts` が、Windmill への
 * 訊き方は `windmill-variables.test.ts` が見る。ここで見るのは配線: schema・400 と 503 の形・行に固定する物・
 * webhook に載る物・GET の答え。
 */
describe("クロールごとの値（変数とシークレット）", () => {
  const EGOV: FakeScript = {
    id: "egov-law-search",
    version: 2,
    phase: "behavior",
    source: "(async () => { /* egov */ })();",
    sha256: "e".repeat(64),
    options: {},
    enabled: true,
    sites: ["site.test"],
    params: [{ name: "query", kind: "variable", required: false, summary: "検索語" }],
  };
  const MEMBERS: FakeScript = {
    id: "members-only",
    version: 1,
    phase: "behavior",
    source: "(async () => { /* token */ })();",
    sha256: "9".repeat(64),
    options: {},
    enabled: false,
    sites: [],
    params: [
      { name: "api_token", kind: "secret", required: true, summary: "会員の鍵" },
      { name: "lang", kind: "variable", required: true, summary: "言語" },
    ],
  };
  const PATH = "f/waggle_secrets/api_token";
  const EDITED = "2026-11-01T07:00:00.000000Z";
  /** ts-compile-service が source から読む、変数の宣言の偽物。 */
  const DECLARED = compilesWith({
    "egov-law-search": [
      {
        name: "query",
        kind: "variable",
        required: false,
        summary: "検索語",
        schema: { type: "string", minLength: 1 },
      },
    ],
    "members-only": [
      {
        name: "lang",
        kind: "variable",
        required: true,
        summary: "言語",
        schema: { type: "string", enum: ["ja", "en"] },
      },
    ],
  });

  /** Windmill の偽物。在る path とその答え。訊いた順を記録する */
  const windmillWith = (
    known: Record<string, { isSecret: boolean; editedAt: string | null }>,
    asked: string[] = [],
  ): WindmillVariables => ({
    exists: (path) => {
      asked.push(`exists ${path}`);
      return Promise.resolve(path in known);
    },
    meta: (path) => {
      asked.push(`meta ${path}`);
      return Promise.resolve(known[path]);
    },
  });
  const unreachable: WindmillVariables = {
    exists: () => Promise.reject(new WindmillUnreachable("connect ECONNREFUSED")),
    meta: () => Promise.reject(new WindmillUnreachable("connect ECONNREFUSED")),
  };

  const start = async (
    payload: Record<string, unknown>,
    opts: {
      windmill?: WindmillVariables;
      scripts?: FakeScript[];
      tsCompile?: TsCompile;
      formats?: string;
    } = {},
  ) => {
    const crawls: FakeCrawl[] = [];
    const sent: DispatchedCrawl[] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        scripts: opts.scripts ?? [...DEFAULT_CATALOG, EGOV, MEMBERS],
        tsCompile: opts.tsCompile ?? DECLARED,
        dispatch: (crawl) => {
          sent.push(crawl);
          return Promise.resolve(undefined);
        },
        ...(opts.windmill && { windmill: opts.windmill }),
        ...(opts.formats !== undefined && { formats: opts.formats }),
      }),
    );
    const res = await app.inject({ method: "POST", url: "/api/crawls", headers: SUBJECT, payload });
    await app.close();
    return { res, crawls, sent };
  };
  /** 始めた行を GET で読む。 */
  const read = async (crawls: FakeCrawl[], scripts: FakeScript[] = [EGOV, MEMBERS]) => {
    const app = await buildApp(depsWith({ crawls, allowed: true, scripts }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${crawls[0]!.id}` });
    await app.close();
    return res.json<Record<string, unknown>>();
  };

  it("変数の名前の綴り・64 字・32 個・値の 4,096 字・文字列でない値は schema の 400（値は答えに写らない）", async () => {
    const app = await buildApp(unreachableDeps);
    const post = async (variables: unknown) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/crawls",
        headers: SUBJECT,
        payload: { seeds: [SEED], variables },
      });
      return res;
    };
    const names = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`v${String(i)}`, "x"]));
    expect((await post({ Query: "x" })).statusCode).toBe(400);
    expect((await post({ "a-b": "x" })).statusCode).toBe(400);
    expect((await post({ ["a".repeat(65)]: "x" })).statusCode).toBe(400);
    expect((await post(names(33))).statusCode).toBe(400);
    expect((await post({ q: "x".repeat(4097) })).statusCode).toBe(400);
    // 文字列に直せない値は 400。数と 1 要素の配列は Fastify の ajv (coerceTypes: "array") が文字列に直して通す
    expect((await post({ q: { nested: 1 } })).statusCode).toBe(400);
    expect((await post({ q: ["x", "y"] })).statusCode).toBe(400);
    expect((await post(["q"])).statusCode).toBe(400);
    const secret = "s3cr3t-value-that-must-not-echo";
    const refused = await post({ q: secret, Q: "x" });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).not.toContain(secret);
    // ちょうどは schema を通る（500 は deps に触れた＝検証を通過した証拠）
    expect((await post({ ["a".repeat(64)]: "x".repeat(4096) })).statusCode).toBe(500);
    expect((await post(names(32))).statusCode).toBe(500);
    await app.close();
  });

  it("その場の TS の宣言は schema で形を見る: kind・name の綴り・知らない鍵は 400、形が合えば通る", async () => {
    const app = await buildApp(unreachableDeps);
    const post = async (params: unknown) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/crawls",
        headers: SUBJECT,
        payload: {
          seeds: [SEED],
          scripts: [{ inline: { name: "probe", phase: "behavior", source: "x;", params } }],
        },
      });
      return res.statusCode;
    };
    expect(await post([{ name: "q", kind: "token" }])).toBe(400);
    expect(await post([{ name: "Q", kind: "variable" }])).toBe(400);
    expect(await post([{ name: "q", kind: "variable", default: "x" }])).toBe(400);
    expect(await post([{ kind: "variable" }])).toBe(400);
    expect(await post({ q: "variable" })).toBe(400);
    expect(await post([{ name: "q", kind: "variable", required: true, summary: "s" }])).toBe(500);
    expect(await post([])).toBe(500);
    await app.close();
  });

  it("変数を省けば空を固定し、webhook にも variables と secrets を空の object で載せる", async () => {
    const { res, crawls, sent } = await start({ seeds: [SEED] });
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.variables).toEqual({});
    expect(crawls[0]?.secrets).toEqual({});
    expect(sent[0]).toMatchObject({ variables: {}, secrets: {} });
  });

  it("宣言した変数は行に固定され、段の本文に載り、GET が値ごと返す", async () => {
    const { res, crawls, sent } = await start({
      seeds: [SEED],
      scripts: [{ catalog: "egov-law-search" }],
      variables: { query: "個人情報" },
    });
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.variables).toEqual({ query: "個人情報" });
    expect(sent[0]).toMatchObject({ variables: { query: "個人情報" }, secrets: {} });
    expect(await read(crawls)).toMatchObject({ variables: { query: "個人情報" }, secrets: [] });
  });

  it("頼まれた User-Agent は、解かずに行と段の本文に載り、GET が返す", async () => {
    const { res, crawls, sent } = await start({ seeds: [SEED], userAgent: "{chrome} BrowserHive" });
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.userAgent).toBe("{chrome} BrowserHive");
    expect(sent[0]).toMatchObject({ userAgent: "{chrome} BrowserHive" });
    expect(await read(crawls)).toMatchObject({ userAgent: "{chrome} BrowserHive" });
  });

  it("User-Agent を省けば、行は null で、段の本文には空の字を載せる", async () => {
    const { res, crawls, sent } = await start({ seeds: [SEED] });
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.userAgent).toBeNull();
    expect(sent[0]).toMatchObject({ userAgent: "" });
    expect(await read(crawls)).toMatchObject({ userAgent: null });
  });

  it("空白だけの User-Agent は省くのと同じ。前後の空白は落とす", async () => {
    const blank = await start({ seeds: [SEED], userAgent: "   " });
    expect(blank.res.statusCode).toBe(202);
    expect(blank.crawls[0]?.userAgent).toBeNull();
    const padded = await start({ seeds: [SEED], userAgent: " Probe/1 BrowserHive " });
    expect(padded.crawls[0]?.userAgent).toBe("Probe/1 BrowserHive");
  });

  it.each(["{chrome}", "curl/8.0", "NotBrowserHiveAtAll"])(
    "BrowserHive の語を含まない User-Agent %s も、打ったまま行と段の本文に載り、GET が返す",
    async (userAgent) => {
      const { res, crawls, sent } = await start({ seeds: [SEED], userAgent });
      expect(res.statusCode).toBe(202);
      expect(crawls[0]?.userAgent).toBe(userAgent);
      expect(sent[0]).toMatchObject({ userAgent });
      expect(await read(crawls)).toMatchObject({ userAgent });
    },
  );

  it.each([
    ["日本語", "クローラー"],
    ["改行", "a\r\nX-Injected: 1"],
    ["513 字", "x".repeat(513)],
  ])("User-Agent が%sなら読める文で 400。行を作らず flow を呼ばない", async (_name, userAgent) => {
    const { res, crawls, sent } = await start({ seeds: [SEED], userAgent });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "userAgent must be printable ASCII, at most 512 characters",
    });
    expect(crawls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("User-Agent は 512 字まで受ける", async () => {
    const userAgent = "x".repeat(512);
    const { res, crawls } = await start({ seeds: [SEED], userAgent });
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.userAgent).toBe(userAgent);
  });

  it("宣言の無い名前は 400 unknown variables で名指し、行は立たない", async () => {
    const { res, crawls, sent } = await start({
      seeds: [SEED],
      scripts: [{ catalog: "egov-law-search" }],
      variables: { qeury: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown variables", names: ["qeury"] });
    expect(crawls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("必須の変数が足りなければ compile の答えで 400 missing variables と BH0001 を返し、行は立たず webhook も飛ばない", async () => {
    const names: (readonly string[])[] = [];
    const bh0001 = {
      file: "members-only.ts",
      line: 3,
      col: 7,
      code: "BH0001",
      message: "必須の変数 lang が渡されていない",
    };
    const { res, crawls, sent } = await start(
      { seeds: [SEED], scripts: [{ catalog: "members-only" }] },
      {
        tsCompile: {
          compile: (_scripts, variableNames) => {
            names.push(variableNames);
            return Promise.resolve({
              ok: false,
              typescript: "6.0.3",
              diagnostics: [bh0001, { ...bh0001, code: "TS2322", message: "ほかの型の誤り" }],
              declarations: [],
              missingVariables: ["lang"],
            });
          },
        },
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "missing variables",
      names: ["lang"],
      diagnostics: [bh0001],
    });
    expect(names).toEqual([[]]);
    expect(crawls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("compile に送るのは名前だけで、値は送らない。スクリプトが空なら訊かない", async () => {
    const asked: (readonly string[])[] = [];
    const bodies: string[] = [];
    const tsCompile: TsCompile = {
      compile: (scripts, variableNames) => {
        asked.push(variableNames);
        bodies.push(JSON.stringify(scripts));
        return DECLARED.compile(scripts, variableNames);
      },
    };
    const secret = "the-value-of-query";
    await start(
      {
        seeds: [SEED],
        scripts: [{ catalog: "egov-law-search" }],
        variables: { query: secret },
      },
      { tsCompile },
    );
    expect(asked).toEqual([["query"]]);
    expect(bodies.join("")).not.toContain(secret);

    asked.length = 0;
    const none = await start({ seeds: [SEED], scripts: [] }, { tsCompile });
    expect(none.res.statusCode).toBe(202);
    expect(asked).toEqual([]);
  });

  it("compile に届かなければ 503 ts-compile unreachable で、行は立たない", async () => {
    const { res, crawls, sent } = await start(
      { seeds: [SEED], scripts: [{ catalog: "egov-law-search" }] },
      {
        tsCompile: {
          compile: () => Promise.reject(new TsCompileUnreachable("connect ECONNREFUSED")),
        },
      },
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "ts-compile unreachable" });
    expect(crawls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("ふつうの型の誤りは断らない —— 行を立て、flow の compile の段で落ちた行から直し方を訊く", async () => {
    const { res, crawls, sent } = await start(
      {
        seeds: [SEED],
        scripts: [
          { inline: { name: "broken", phase: "behavior", source: "const n: number = 'x';" } },
        ],
      },
      {
        tsCompile: {
          compile: () =>
            Promise.resolve({
              ok: false,
              typescript: "6.0.3",
              diagnostics: [
                { file: "inline-broken.ts", line: 1, col: 7, code: "TS2322", message: "型が違う" },
              ],
              declarations: [{ id: "inline-broken", params: [], unreadable: false }],
              missingVariables: [],
            }),
        },
      },
    );
    expect(res.statusCode).toBe(202);
    expect(crawls).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("答えの宣言を行に固定し、値を形に照らす", async () => {
    const started = await start({
      seeds: [SEED],
      scripts: [{ catalog: "egov-law-search" }],
      variables: { query: "x" },
    });
    expect(started.res.statusCode).toBe(202);
    // 行に残る宣言は catalog の写しでなく、source から読んだ物 (minLength は DECLARED にだけ在る)
    expect(started.crawls[0]?.scripts[0]?.params).toEqual([
      {
        name: "query",
        kind: "variable",
        required: false,
        summary: "検索語",
        schema: { type: "string", minLength: 1 },
      },
    ]);

    const empty = await start({
      seeds: [SEED],
      scripts: [{ catalog: "egov-law-search" }],
      variables: { query: "" },
    });
    expect(empty.res.statusCode).toBe(400);
    expect(empty.res.json()).toEqual({
      error: "invalid variables",
      names: ["query"],
      hint: "query は 1 字以上",
    });
    expect(empty.crawls).toHaveLength(0);
  });

  it("宣言した secret は exists → get の順に Windmill に訊き、在れば path と更新時刻を行に固定し、段の本文には名前 → path を載せる", async () => {
    const asked: string[] = [];
    const { res, crawls, sent } = await start(
      { seeds: [SEED], scripts: [{ catalog: "members-only" }], variables: { lang: "ja" } },
      { windmill: windmillWith({ [PATH]: { isSecret: true, editedAt: EDITED } }, asked) },
    );
    expect(res.statusCode).toBe(202);
    expect(asked).toEqual([`exists ${PATH}`, `meta ${PATH}`]);
    expect(crawls[0]?.secrets).toEqual({
      api_token: { path: PATH, editedAt: EDITED, rotated: null },
    });
    // 値はどこにも無い。段の本文は名前 → path だけ
    expect(sent[0]).toMatchObject({ variables: { lang: "ja" }, secrets: { api_token: PATH } });
    expect(await read(crawls)).toMatchObject({
      variables: { lang: "ja" },
      secrets: [{ name: "api_token", path: PATH, editedAt: EDITED, rotated: null }],
    });
  });

  it("required の secret が Windmill に無ければ 400 unknown secrets で名前・path・宣言した物と hint を言い、行は立たない", async () => {
    const { res, crawls } = await start(
      { seeds: [SEED], scripts: [{ catalog: "members-only" }], variables: { lang: "ja" } },
      { windmill: windmillWith({}) },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "unknown secrets",
      secrets: [{ name: "api_token", path: PATH, declaredBy: ["members-only"] }],
      hint: `wmill variable add <value> ${PATH} --secret`,
    });
    expect(crawls).toEqual([]);
  });

  it("在っても secret でなければ 400 not a secret variable", async () => {
    const { res, crawls } = await start(
      { seeds: [SEED], scripts: [{ catalog: "members-only" }], variables: { lang: "ja" } },
      { windmill: windmillWith({ [PATH]: { isSecret: false, editedAt: null } }) },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "not a secret variable",
      secrets: [{ name: "api_token", path: PATH, declaredBy: ["members-only"] }],
    });
    expect(crawls).toEqual([]);
  });

  it("required でない secret が無ければ、渡さないだけで始まる（スクリプトは undefined を読む）", async () => {
    const { res, crawls, sent } = await start(
      {
        seeds: [SEED],
        scripts: [
          {
            inline: {
              name: "probe",
              phase: "behavior",
              source: "x;",
              params: [{ name: "opt_token", kind: "secret" }],
            },
          },
        ],
      },
      { windmill: windmillWith({}) },
    );
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.secrets).toEqual({});
    expect(sent[0]?.secrets).toEqual({});
  });

  it("Windmill に訊けなければ 503 で、行は立たない", async () => {
    const { res, crawls } = await start(
      { seeds: [SEED], scripts: [{ catalog: "members-only" }], variables: { lang: "ja" } },
      { windmill: unreachable },
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "windmill unreachable" });
    expect(crawls).toEqual([]);
  });

  it("Windmill の変数のクライアントの無い配備で secret を宣言したスクリプトは 400 secrets need the windmill webhook", async () => {
    const { res, crawls } = await start({
      seeds: [SEED],
      scripts: [{ catalog: "members-only" }],
      variables: { lang: "ja" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "secrets need the windmill webhook",
      names: ["api_token"],
    });
    expect(crawls).toEqual([]);
  });

  it("その場の TS の宣言は catalog と同じ決まりで読む: 重複は 400 invalid params、required の既定は false で写す", async () => {
    const inline = (params: unknown) => ({
      seeds: [SEED],
      scripts: [{ inline: { name: "probe", phase: "behavior", source: "x;", params } }],
    });
    const twice = await start(
      inline([
        { name: "t", kind: "secret" },
        { name: "t", kind: "secret" },
      ]),
      { windmill: windmillWith({}) },
    );
    expect(twice.res.statusCode).toBe(400);
    expect(twice.res.json()).toMatchObject({ error: "invalid params", script: "inline-probe" });

    const { crawls } = await start(inline([{ name: "t", kind: "secret" }]), {
      windmill: windmillWith({}),
    });
    expect(crawls[0]?.scripts[0]?.params).toEqual([{ name: "t", kind: "secret", required: false }]);
  });

  it("その場の TS の params に変数は書けない —— 変数の宣言の正は source の defineParams", async () => {
    const { res, crawls } = await start({
      seeds: [SEED],
      scripts: [
        {
          inline: {
            name: "probe",
            phase: "behavior",
            source: "x;",
            params: [{ name: "q", kind: "variable" }],
          },
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "invalid params",
      script: "inline-probe",
      hint: expect.stringContaining("defineParams") as string,
    });
    expect(crawls).toHaveLength(0);
  });

  it("宣言を読めないスクリプトが在れば、知らない名前も通して行を立てる —— 理由は flow の compile の段が BH0002 で言う", async () => {
    const { res, crawls } = await start(
      {
        seeds: [SEED],
        scripts: [{ inline: { name: "probe", phase: "behavior", source: "x;" } }],
        variables: { anything: "goes" },
      },
      {
        tsCompile: {
          compile: () =>
            Promise.resolve({
              ok: false,
              typescript: "6.0.3",
              diagnostics: [
                { file: "inline-probe.ts", line: 1, col: 1, code: "BH0002", message: "読めない" },
              ],
              declarations: [{ id: "inline-probe", params: [], unreadable: true }],
              missingVariables: [],
            }),
        },
      },
    );
    expect(res.statusCode).toBe(202);
    expect(crawls[0]?.variables).toEqual({ anything: "goes" });
  });
});

/**
 * シークレットの値を WARC に残すか (CAPTURE-166)。宣言の `archive: "keep"` を、行 (`crawls.secrets[名前].archive`)・
 * 段の本文 (`secret_archive`)・GET の答えに運ぶ。束ね方と形式の判断は `crawl-values.test.ts` が見る。
 */
describe("シークレットを WARC に残すか（宣言の archive）", () => {
  const NOTE = "f/waggle_secrets/note";
  const PASSWORD = "f/waggle_secrets/password";
  const EDITED = "2026-11-10T00:00:00.000000Z";
  const windmillWith = (paths: string[]): WindmillVariables => ({
    exists: (path) => Promise.resolve(paths.includes(path)),
    meta: (path) =>
      Promise.resolve(paths.includes(path) ? { isSecret: true, editedAt: EDITED } : undefined),
  });
  /** その場の TS 1 本に、シークレットの宣言を添えた頼み。 */
  const withParams = (...params: Record<string, unknown>[]) => ({
    seeds: [SEED],
    scripts: [{ inline: { name: "login", phase: "behavior", source: "x;", params } }],
  });
  const start = async (
    payload: Record<string, unknown>,
    opts: { windmill?: WindmillVariables; formats?: string } = {},
  ) => {
    const crawls: FakeCrawl[] = [];
    const sent: DispatchedCrawl[] = [];
    const app = await buildApp(
      depsWith({
        crawls,
        allowed: true,
        dispatch: (crawl) => {
          sent.push(crawl);
          return Promise.resolve(undefined);
        },
        windmill: opts.windmill ?? windmillWith([NOTE, PASSWORD]),
        ...(opts.formats !== undefined && { formats: opts.formats }),
      }),
    );
    const res = await app.inject({ method: "POST", url: "/api/crawls", headers: SUBJECT, payload });
    await app.close();
    return { res, crawls, sent };
  };
  const read = async (crawls: FakeCrawl[]) => {
    const app = await buildApp(depsWith({ crawls, allowed: true }));
    const res = await app.inject({ method: "GET", url: `/api/crawls/${crawls[0]!.id}` });
    await app.close();
    return res.json<Record<string, unknown>>();
  };

  it("keep の宣言は行のシークレットに archive で写り、段の本文の secret_archive に載り、GET が archive で返す。隠すシークレットは載らない", async () => {
    const { res, crawls, sent } = await start(
      withParams(
        { name: "note", kind: "secret", archive: "keep" },
        { name: "password", kind: "secret" },
      ),
    );
    expect(res.statusCode).toBe(202);
    // 写しの宣言にも残る (読み直しの元)
    expect(crawls[0]?.scripts[0]?.params).toEqual([
      { name: "note", kind: "secret", required: false, archive: "keep" },
      { name: "password", kind: "secret", required: false },
    ]);
    expect(crawls[0]?.secrets).toEqual({
      note: { path: NOTE, editedAt: EDITED, rotated: null, archive: "keep" },
      password: { path: PASSWORD, editedAt: EDITED, rotated: null },
    });
    expect(sent[0]).toMatchObject({
      secrets: { note: NOTE, password: PASSWORD },
      secretArchive: { note: "keep" },
    });
    expect((await read(crawls))["secrets"]).toEqual([
      { name: "note", path: NOTE, editedAt: EDITED, rotated: null, archive: "keep" },
      { name: "password", path: PASSWORD, editedAt: EDITED, rotated: null, archive: null },
    ]);
  });

  it("任意で Windmill に無い keep のシークレットは、行にも secrets にも secret_archive にも載らない（載せると BrowserHive がクロールの取り込みを全部 400 で断る）", async () => {
    const { res, crawls, sent } = await start(
      withParams(
        { name: "note", kind: "secret", archive: "keep" },
        { name: "absent_note", kind: "secret", archive: "keep" },
      ),
      { windmill: windmillWith([NOTE]) },
    );
    expect(res.statusCode).toBe(202);
    expect(Object.keys(crawls[0]?.secrets ?? {})).toEqual(["note"]);
    expect(sent[0]?.secrets).toEqual({ note: NOTE });
    expect(sent[0]?.secretArchive).toEqual({ note: "keep" });
  });

  it("残すシークレットが無ければ、段の本文の secret_archive は空の object", async () => {
    const { sent } = await start(withParams({ name: "password", kind: "secret" }));
    expect(sent[0]?.secretArchive).toEqual({});
    const none = await start({ seeds: [SEED] });
    expect(none.sent[0]?.secretArchive).toEqual({});
  });

  it("その場の TS の archive は schema で keep だけを通す", async () => {
    const hide = await start(withParams({ name: "password", kind: "secret", archive: "hide" }));
    expect(hide.res.statusCode).toBe(400);
    expect(hide.res.json<{ message: string }>().message).toContain("archive");
    expect(hide.crawls).toEqual([]);
  });

  it("同じ名前のシークレットを、残す宣言と隠す宣言で食い違えれば 400 conflicting params で、行は立たない", async () => {
    const { res, crawls, sent } = await start({
      seeds: [SEED],
      scripts: [
        {
          inline: {
            name: "a",
            phase: "behavior",
            source: "x;",
            params: [{ name: "note", kind: "secret", archive: "keep" }],
          },
        },
        {
          inline: {
            name: "b",
            phase: "behavior",
            source: "x;",
            params: [{ name: "note", kind: "secret" }],
          },
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "conflicting params", names: ["note"] });
    expect(crawls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("形式に png がある配備で、隠すシークレットを使うクロールは 400 formats that cannot hide secrets で名指し、行は立たず webhook も飛ばない", async () => {
    const { res, crawls, sent } = await start(
      withParams(
        { name: "note", kind: "secret", archive: "keep" },
        { name: "password", kind: "secret" },
      ),
      { formats: "wacz,png" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "formats that cannot hide secrets",
      formats: ["png"],
      names: ["password"],
      hint: expect.stringContaining("CAPTURE_LEDGER_CAPTURE_FORMATS") as string,
    });
    expect(crawls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("対照: 同じ配備でも、シークレットが全部 keep なら始まり、png も頼む", async () => {
    const { res, sent } = await start(
      withParams({ name: "note", kind: "secret", archive: "keep" }),
      {
        formats: "wacz,png",
      },
    );
    expect(res.statusCode).toBe(202);
    expect(sent[0]?.captureFormats.png).toBe(true);
    expect(sent[0]?.secretArchive).toEqual({ note: "keep" });
  });

  it("対照: 隠すシークレットが任意で Windmill に無ければ送らないので、png の配備でも始まる", async () => {
    const { res, sent } = await start(withParams({ name: "password", kind: "secret" }), {
      windmill: windmillWith([]),
      formats: "wacz,png",
    });
    expect(res.statusCode).toBe(202);
    expect(sent[0]?.secrets).toEqual({});
  });
});
