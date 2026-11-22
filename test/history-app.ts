/**
 * 同じ URL の取り込みの一覧・好きな 2 本の差分・その要約のエンドポイント (`api/history.ts`。CAPTURE-462) を、
 * 試験のために組む。3 つの試験が同じ代役を使う。
 *
 * - DB は、Kysely が実際に組んだ SQL を記録する代役 (`recording-db.ts`)。答えは SQL の形を見て、渡した取り込みから
 *   作る。**読む SQL (`changes/history.ts`・`changes/pair-summary.ts`) と派生の層の store は本物**
 * - 保管庫は、頼まれた Range を記録して、その範囲ちょうどを返す偽物
 * - OpenFGA は、訊かれた内容 (関係・相手・一貫性) を記録する偽物。まとめ訊きは別に記録する
 * - Claude は、呼ばれた数を数える偽物。答えを渡さなければ、呼ばれた時に投げる
 */
import { createHash } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import type { OpenFgaClient } from "@openfga/sdk";
import Fastify, { type FastifyError } from "fastify";

import { registerHistoryRoutes } from "../src/api/history.js";
import { PAGES_ENTRY_PATH } from "../src/archive/wacz.js";
import { TAIL_BYTES } from "../src/archive/wacz-range.js";
import { historyReadsOf } from "../src/changes/history.js";
import { pairSummaryReadsOf } from "../src/changes/pair-summary.js";
import type { Claude, ClaudeReply } from "../src/claude/types.js";
import { derivationStoreOf } from "../src/derivations/store.js";
import { recordingDb } from "./recording-db.js";
import { storedZip } from "./zip.js";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `archive_pages` の 1 行 (試験が渡す形)。 */
export interface PageSeed {
  stage: string | null;
  textSha256?: string | null;
  textChars?: number | null;
  textWithheld?: string | null;
}

/** 取り込み 1 本 (試験が渡す形)。DB の行は、ここから SQL ごとに作る。 */
export interface ArchiveSeed {
  id: string;
  sourceUrl?: string;
  capturedAt?: Date;
  inspected?: boolean;
  browserhiveVersion?: string | null;
  /** クロール。null はクロールに繋がらない取り込み。 */
  crawl?: {
    id: string;
    orgId: string;
    scheduleId?: string | null;
    scheduleName?: string | null;
    recipeSha256?: string | null;
  } | null;
  /** `archive_pages` の行 (ordinal の順)。 */
  pages?: PageSeed[];
  /** 保管庫に置く WACZ。無ければ、保管庫に無い。 */
  wacz?: Buffer;
  /** DB の `wacz_bytes`。省けば WACZ の長さ。 */
  waczBytes?: number | null;
}

export const URL_A = "https://site.test/";
export const NOW = new Date("2026-11-22T04:00:00.000Z");
export const CRAWL = {
  id: "c0000000-0000-4000-8000-000000000001",
  // 頼む人 (alice) の組織とは別にしてある。費用を数える先がクロールの組織であることを見るため
  orgId: "crawl-org",
  scheduleId: "50000000-0000-4000-8000-000000000001",
  scheduleName: "毎朝の 5 サイト",
  recipeSha256: "a".repeat(64),
};

/** WARC の代わりの大きい entry。WACZ を末尾の控えより大きくし、丸ごと読む実装と区別する。 */
const WARC = Buffer.alloc(TAIL_BYTES + 8 * 1024, "W");

/**
 * BrowserHive WACZ と同じ並びの作り物 (WARC が前、`pages.jsonl` はその後ろ)。`doc` は文書の行の文字、`behaviors` は
 * after-behaviors の写しの文字 (省けば写しの行を入れない)。
 */
export const pagesWacz = (text: { doc?: string; behaviors?: string }, url = URL_A): Buffer =>
  storedZip(
    {
      "archive/data.browserhive.warc.gz": WARC,
      [PAGES_ENTRY_PATH]: [
        JSON.stringify({ format: "json-pages-1.0", id: "pages" }),
        JSON.stringify({ url, ...(text.doc !== undefined && { text: text.doc }) }),
        JSON.stringify({
          url: `urn:browserhive:snapshot:after-load:${url}`,
          stage: "after-load",
          text: "読み込みの後の文字",
        }),
        ...(text.behaviors === undefined
          ? []
          : [
              JSON.stringify({
                url: `urn:browserhive:snapshot:after-behaviors:${url}`,
                stage: "after-behaviors",
                text: text.behaviors,
              }),
            ]),
      ].join("\n"),
      "datapackage.json": "{}",
    },
    { deflate: [PAGES_ENTRY_PATH] },
  );

/** 検め済みで、文書の行と after-behaviors の写しを持つ取り込み。WACZ も同じ文字で作る。 */
export const archiveOf = (
  id: string,
  text: { doc?: string; behaviors?: string },
  over: Partial<ArchiveSeed> = {},
): ArchiveSeed => ({
  id,
  crawl: CRAWL,
  pages: [
    {
      stage: null,
      textSha256: text.doc === undefined ? null : sha256(text.doc),
      textChars: text.doc?.length ?? null,
    },
    { stage: "after-load", textSha256: sha256("読み込みの後の文字"), textChars: 9 },
    ...(text.behaviors === undefined
      ? []
      : [
          {
            stage: "after-behaviors",
            textSha256: sha256(text.behaviors),
            textChars: text.behaviors.length,
          },
        ]),
  ],
  wacz: pagesWacz(text, over.sourceUrl ?? URL_A),
  ...over,
});

const keyOf = (seed: ArchiveSeed) => `${seed.id}.browserhive.wacz`;

/** 派生の層に在る要約 1 行 (`pairSummaryReadsOf` の select の形)。 */
export interface StoredSummary {
  model: string;
  promptVersion: string;
  usd: string;
  output: Record<string, unknown>;
}

export interface BuildOptions {
  archives?: ArchiveSeed[];
  /** 一覧の SQL に返す行の id (新しい順)。省けば `archives` の全部。 */
  listed?: string[];
  signedIn?: boolean;
  /** クロールを頼めるか (`can_submit`)。 */
  submit?: boolean;
  /** 見てよい取り込みの id。省けば全部。 */
  viewable?: string[];
  /** 保管庫が答えない取り込みの id。 */
  storeDown?: string[];
  /** 派生の層に在る要約。関数なら、訊かれるたびに呼ぶ。 */
  summary?: StoredSummary | (() => StoredSummary | undefined);
  /** 組織がこの月に使った額。 */
  spent?: string;
  budgetUsd?: number;
  /** `false` は鍵の無い配備。答えを渡さなければ、呼ばれた時に投げる。 */
  claude?: false | (() => Promise<unknown>);
  /** 派生の層に残す INSERT で投げる誤り。 */
  insertError?: Error;
}

export const build = async (opts: BuildOptions = {}) => {
  const seeds = opts.archives ?? [];
  const byId = new Map(seeds.map((seed) => [seed.id, seed]));
  const inserted: { sql: string; parameters: readonly unknown[] }[] = [];

  const archiveRow = (seed: ArchiveSeed) => ({
    id: seed.id,
    bucket: "browserhive",
    objectKey: keyOf(seed),
    sourceUrl: seed.sourceUrl ?? URL_A,
    capturedAt: seed.capturedAt ?? NOW,
    browserhiveVersion: seed.browserhiveVersion === undefined ? "32.0.3" : seed.browserhiveVersion,
    inspectedAt: seed.inspected === false ? null : NOW,
    // bigint は node-pg が文字列で返す
    waczBytes:
      seed.inspected === false || seed.waczBytes === null
        ? null
        : String(seed.waczBytes ?? seed.wacz?.length ?? 1),
    crawlId: seed.crawl?.id ?? null,
    orgId: seed.crawl?.orgId ?? null,
    scheduleId: seed.crawl?.scheduleId ?? null,
    scheduleName: seed.crawl?.scheduleName ?? null,
    recipeSha256: seed.crawl?.recipeSha256 ?? null,
  });

  const { db, queries } = recordingDb([], {
    answer: (sql, parameters) => {
      if (sql.includes('from "archive_pages"')) {
        return parameters.flatMap((id) =>
          (byId.get(String(id))?.pages ?? []).map((page, ordinal) => ({
            archiveId: String(id),
            ordinal,
            stage: page.stage,
            textSha256: page.textSha256 ?? null,
            textChars: page.textChars ?? null,
            textWithheld: page.textWithheld ?? null,
          })),
        );
      }
      if (sql.includes('"a"."source_url_hash"')) {
        return (opts.listed ?? seeds.map((seed) => seed.id)).flatMap((id) => {
          const seed = byId.get(id);
          return seed === undefined ? [] : [archiveRow(seed)];
        });
      }
      if (sql.includes('from "archives" as "a"')) {
        return parameters.flatMap((id) => {
          const seed = byId.get(String(id));
          return seed === undefined ? [] : [archiveRow(seed)];
        });
      }
      if (sql.startsWith('insert into "derivations"')) {
        inserted.push({ sql, parameters });
        if (opts.insertError !== undefined) throw opts.insertError;
        return [];
      }
      if (sql.includes("coalesce(sum(usd), 0)")) return [{ spent: opts.spent ?? "0" }];
      if (sql.includes('from "derivations"')) {
        const stored = typeof opts.summary === "function" ? opts.summary() : opts.summary;
        return stored === undefined ? [] : [stored];
      }
      return undefined;
    },
  });

  const ranges: string[] = [];
  const s3 = {
    send: (command: { input: { Bucket: string; Key: string; Range?: string } }) => {
      const { Key, Range } = command.input;
      ranges.push(`${Key} ${Range ?? "(whole)"}`);
      const seed = seeds.find((s) => keyOf(s) === Key);
      if (seed !== undefined && opts.storeDown?.includes(seed.id) === true) {
        return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8333"));
      }
      if (seed?.wacz === undefined) {
        return Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec(Range ?? "");
      const bytes = m === null ? seed.wacz : seed.wacz.subarray(Number(m[1]), Number(m[2]) + 1);
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)) },
      });
    },
  } as unknown as S3Client;

  const mayView = (object: string) =>
    opts.viewable === undefined || opts.viewable.includes(object.replace(/^archive:/, ""));
  const asked: { relation: string; object: string; consistency: unknown }[] = [];
  const batchAsked: string[][] = [];
  const fga = {
    check: (body: { relation: string; object: string }, options?: { consistency?: unknown }) => {
      asked.push({
        relation: body.relation,
        object: body.object,
        consistency: options?.consistency,
      });
      return Promise.resolve({
        allowed: body.relation === "can_submit" ? (opts.submit ?? true) : mayView(body.object),
      });
    },
    batchCheck: (req: { checks: { object: string }[] }) => {
      batchAsked.push(req.checks.map((c) => c.object.replace(/^archive:/, "")));
      return Promise.resolve({
        result: req.checks.map((c) => ({
          allowed: mayView(c.object),
          request: { object: c.object },
        })),
      });
    },
  } as unknown as OpenFgaClient;

  let claudeAsked = 0;
  /** Claude に渡った頼み (決まりの文と、入力の JSON)。 */
  const claudeRequests: { system: string; input: unknown }[] = [];
  const answer = opts.claude;
  const claude: Claude = {
    ask<T>(request: Parameters<Claude["ask"]>[0]) {
      claudeAsked += 1;
      claudeRequests.push({
        system: request.system,
        input: JSON.parse(String(request.messages[0]?.content ?? "null")) as unknown,
      });
      if (answer === undefined || answer === false) throw new Error("Claude は呼ばれないはず");
      return answer() as Promise<ClaudeReply<T>>;
    },
  };

  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
    return reply.code(500).send({ error: "internal error", message: error.message });
  });
  registerHistoryRoutes(app, {
    fga,
    resolveIdentity: () =>
      Promise.resolve(
        opts.signedIn === false ? undefined : { subject: "alice", organizations: ["acme"] },
      ),
    reads: historyReadsOf(db),
    s3,
    summaries: pairSummaryReadsOf(db),
    ...(opts.claude !== false && {
      claude,
      derivations: derivationStoreOf(db),
      claudeBudgetUsd: opts.budgetUsd ?? 5,
    }),
  });
  await app.ready();
  return {
    app,
    queries,
    ranges,
    asked,
    batchAsked,
    inserted,
    claudeAsked: () => claudeAsked,
    claudeRequests,
    keyOf,
  };
};

export type Built = Awaited<ReturnType<typeof build>>;

/** エンドポイントを 1 度叩いて閉じる。 */
export const call = async (
  opts: BuildOptions,
  request: { method?: "GET" | "POST"; url: string; body?: unknown },
) => {
  const built = await build(opts);
  const res = await built.app.inject({
    method: request.method ?? "GET",
    url: request.url,
    ...(request.body !== undefined && { payload: request.body as object }),
  });
  await built.app.close();
  return { res, ...built };
};
