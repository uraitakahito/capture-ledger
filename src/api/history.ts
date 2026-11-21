/**
 * 同じ URL の取り込みの一覧と、好きな 2 本の差分 (CAPTURE-462)。capture-workbench のタブ「変化」の「URL の履歴」が読む。
 *
 * - `GET /api/history?url=&before=`: 同じ URL の取り込みを、撮った時刻の新しい順に (50 行ずつ)
 * - `GET /api/archives/:id/changes?since=`: `:id` (今) と `since` (前) の 2 本をその場で比べる。保存しない
 * - `POST /api/archives/:id/changes/summary`: 同じ 2 本の差分を Claude に要約させる。**鍵の無い配備では登録しない**
 *
 * **名乗りは `can_submit` で通し、取り込みは 1 本ずつ `can_view` で絞る** (前回からの変化のエンドポイント
 * `api/changes.ts` と同じ線。予定の名前と撮り方は、クロールを頼める名乗りだけが読める物)。`can_view` の訊き方は 2 つ:
 *
 * - 一覧は弱い一貫性のまとめ訊き (`viewableArchiveIds`)。一覧に出ることは何も与えない
 * - 差分と要約は、2 本それぞれを強い一貫性で (`mayViewArchive`)。WACZ の文字を返す読みなので、取り消した直後の
 *   許しで返さない (節目のスクリーンショットと同じ扱い)。**見てよいと分かるまで、DB も保管庫も読まない**
 *
 * 知らない引数は、どのエンドポイントも 400 で断る。
 */
import type { S3Client } from "@aws-sdk/client-s3";
import type { OpenFgaClient } from "@openfga/sdk";
import type { FastifyInstance, FastifyReply } from "fastify";

import { WaczStoreError } from "../archive/wacz-range.js";
import { comparePair, type PairComparison } from "../changes/compare.js";
import {
  notComparableOf,
  type HistoryArchive,
  type HistoryReads,
  type HistoryRow,
} from "../changes/history.js";
import {
  existingSummaryOf,
  summarizePair,
  type PairSummaryFields,
  type PairSummaryReads,
} from "../changes/pair-summary.js";
import type { Claude } from "../claude/types.js";
import { parseHttpUrl } from "../crawl/scope.js";
import type { DerivationStore } from "../derivations/store.js";
import { createChildLogger } from "../logger.js";
import { mayViewArchive, viewableArchiveIds } from "./archive-visibility.js";
import { maySubmit, unauthorized } from "./authorization.js";
import type { Identity, IdentityResolver } from "./identity.js";

const log = createChildLogger({ module: "history" });

export interface HistoryRouteDeps {
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
  reads: HistoryReads;
  s3: S3Client;
  summaries: PairSummaryReads;
  /** 無ければ、要約させるエンドポイントを登録しない。 */
  claude?: Claude;
  derivations?: DerivationStore;
  /** 組織ごとの月の上限 (USD)。直す係・周回の要約と分け合う。 */
  claudeBudgetUsd?: number;
}

const originOf = (row: HistoryRow) =>
  row.crawlId === null
    ? { kind: "unknown", scheduleId: null, scheduleName: null }
    : row.scheduleId === null
      ? { kind: "manual", scheduleId: null, scheduleName: null }
      : { kind: "schedule", scheduleId: row.scheduleId, scheduleName: row.scheduleName };

const UUID = { type: "string", format: "uuid" } as const;
const ARCHIVE_PARAMS = {
  type: "object",
  properties: { id: UUID },
  required: ["id"],
} as const;

/** 比べた 2 本。断るときは、その答え。 */
type Compared =
  | { kind: "refused"; code: number; body: Record<string, unknown> }
  | { kind: "compared"; comparison: PairComparison; after: HistoryArchive; before: HistoryArchive };

export const registerHistoryRoutes = (app: FastifyInstance, deps: HistoryRouteDeps): void => {
  const { fga, resolveIdentity, reads, s3, summaries } = deps;

  app.get<{ Querystring: { url: string; before?: string } }>(
    "/api/history",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            url: { type: "string", minLength: 1 },
            before: { type: "string", format: "date-time" },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      // クロールの起点と同じ関数で正規化してから引く (`https://a.test` は `https://a.test/` の取り込みに当たる)
      const parsed = parseHttpUrl(request.query.url);
      if (parsed === undefined) return reply.code(400).send({ error: "invalid url" });
      const url = parsed.normalized;
      if (!(await maySubmit(fga, identity))) {
        return reply.code(200).send({ url, archives: [], next: null });
      }

      const { before } = request.query;
      const page = await reads.list(url, before === undefined ? undefined : new Date(before));
      const allowed = await viewableArchiveIds(
        fga,
        identity,
        page.rows.map((row) => row.id),
      );
      const visible = page.rows.filter((row) => allowed.has(row.id));
      const lines = await reads.comparedLines(visible.map((row) => row.id));
      return reply.code(200).send({
        url,
        archives: visible.map((row) => {
          const line = lines.get(row.id);
          const notComparable = notComparableOf(row.inspectedAt, line);
          return {
            id: row.id,
            capturedAt: row.capturedAt,
            objectKey: row.objectKey,
            crawlId: row.crawlId,
            origin: originOf(row),
            recipeSha256: row.recipeSha256,
            browserhiveVersion: row.browserhiveVersion,
            text:
              notComparable !== null || line === undefined
                ? null
                : { stage: line.stage, sha256: line.textSha256, chars: line.textChars },
            notComparable,
          };
        }),
        // 見てよい行の数ではなく、SQL の行で決める (見てよい行が 0 でも、続きが在れば時刻)
        next: page.next,
      });
    },
  );

  /**
   * 2 本を見てよいかを確かめ、読み、比べる。差分を読む答えと要約させる答えが同じ道を通る。
   * 断る理由は分けず 404 (頼めない・どちらかを見てよくない・どちらかが無い)。
   */
  const compare = async (
    identity: Identity,
    afterId: string,
    beforeId: string,
  ): Promise<Compared> => {
    const notFound = { kind: "refused", code: 404, body: { error: "not found" } } as const;
    if (!(await maySubmit(fga, identity))) return notFound;
    // **強一貫で、1 本ずつ。** ここを通るまで、取り込みの行も保管庫も読まない
    const [mayAfter, mayBefore] = await Promise.all([
      mayViewArchive(fga, identity, afterId),
      mayViewArchive(fga, identity, beforeId),
    ]);
    if (!mayAfter || !mayBefore) {
      log.info(
        { subject: identity.subject, archiveId: afterId, prevArchiveId: beforeId },
        "Denied",
      );
      return notFound;
    }
    const { after, before } = await reads.pair(afterId, beforeId);
    if (after === undefined || before === undefined) return notFound;
    if (after.sourceUrl !== before.sourceUrl) {
      return { kind: "refused", code: 422, body: { error: "different url" } };
    }
    let compared;
    try {
      compared = await comparePair(s3, after, before);
    } catch (err) {
      if (!(err instanceof WaczStoreError)) throw err;
      log.warn({ err, archiveId: afterId, prevArchiveId: beforeId }, "The store did not answer");
      return { kind: "refused", code: 502, body: { error: "storage unreachable" } };
    }
    const { comparison, store } = compared;
    log.info(
      {
        archiveId: afterId,
        prevArchiveId: beforeId,
        state: comparison.state,
        reason: comparison.reason,
        sameBy: comparison.sameBy,
        storeRequests: store.requests,
        storeBytes: store.bytes,
      },
      "Archive pair compared",
    );
    return { kind: "compared", comparison, after, before };
  };

  const answerOf = (comparison: PairComparison, summary: PairSummaryFields) => ({
    url: comparison.url,
    state: comparison.state,
    reason: comparison.reason,
    sameBy: comparison.sameBy,
    added: comparison.added,
    removed: comparison.removed,
    hunks: comparison.hunks,
    recipeDiffers: comparison.recipeDiffers,
    stageDiffers: comparison.stageDiffers,
    before: comparison.before,
    after: comparison.after,
    summary: summary.summary,
    significance: summary.significance,
    headline: summary.headline,
    quotes: summary.quotes,
  });

  app.get<{ Params: { id: string }; Querystring: { since: string } }>(
    "/api/archives/:id/changes",
    {
      schema: {
        params: ARCHIVE_PARAMS,
        querystring: {
          type: "object",
          properties: { since: UUID },
          required: ["since"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      const compared = await compare(identity, request.params.id, request.query.since);
      if (compared.kind === "refused") return reply.code(compared.code).send(compared.body);
      // 在る要約は一緒に返す (画面を開き直しても、押し直さずに出る)。Claude は呼ばない
      const summary = await existingSummaryOf(summaries, compared.comparison);
      return reply.code(200).send(answerOf(compared.comparison, summary));
    },
  );

  const { claude, derivations } = deps;
  if (claude === undefined || derivations === undefined) return;
  const budgetUsd = deps.claudeBudgetUsd ?? 0;
  const refuse = (reply: FastifyReply, code: number, error: string, more = {}) =>
    reply.code(code).send({ error, ...more });

  app.post<{ Params: { id: string }; Body: { since: string } }>(
    "/api/archives/:id/changes/summary",
    {
      schema: {
        params: ARCHIVE_PARAMS,
        body: {
          type: "object",
          properties: { since: UUID },
          required: ["since"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      const compared = await compare(identity, request.params.id, request.body.since);
      if (compared.kind === "refused") return reply.code(compared.code).send(compared.body);
      const { comparison, after, before } = compared;
      const result = await summarizePair(
        { reads: summaries, derivations, claude, budgetUsd },
        { comparison, after, before, requestedBy: identity.subject },
      );
      log.info(
        { archiveId: after.id, prevArchiveId: before.id, kind: result.kind },
        "Archive pair summary asked",
      );
      switch (result.kind) {
        case "summarized":
          return reply
            .code(200)
            .send({ ...answerOf(comparison, result.fields), reused: result.reused });
        case "nothing_to_summarize":
          return refuse(reply, 422, "nothing to summarize");
        case "no_organization":
          return refuse(reply, 422, "no organization");
        case "budget_exhausted":
          return refuse(reply, 429, "claude budget exhausted", {
            spentUsd: result.spentUsd,
            budgetUsd: result.budgetUsd,
          });
        case "refused":
          return refuse(reply, 422, "claude refused");
        case "failed":
          return refuse(reply, 502, "claude failed");
      }
    },
  );
};
