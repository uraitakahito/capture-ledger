/**
 * 前回からの変化を読むエンドポイント (CAPTURE-167)。capture-workbench のタブ「変化」が読む。
 *
 * - `GET /api/changes?before=`: 予定の回のまとめの一覧 (新しい順・50 本ずつ)
 * - `GET /api/crawls/:id/changes`: 回 1 本の、ページごとの差分・要約・前と今の WACZ と、比べて同じだったページ
 *   (`unchanged`・CAPTURE-236)
 *
 * **名乗りは `can_submit` で通し、中身は `can_view` で絞る。** 予定の一覧 (`GET /api/schedules`) と同じく、クロールを
 * 頼める名乗りだけが回を見る。差分と要約はページの文字から作った物なので、前と今の両方の WACZ を見てよいページだけを
 * 返す。一覧の 1 行の要約は、その回の WACZ を全部見てよいときだけ出す (`restricted`)。
 *
 * **要約は証拠ではない。** 答えに `evidence: false` と model・prompt の版・費用を必ず付ける。正は 2 本の WACZ と差分。
 */
import type { OpenFgaClient } from "@openfga/sdk";
import type { FastifyInstance } from "fastify";

import type { ChangeReads, ChangeRunRow } from "../changes/reads.js";
import type { ChangeSummary } from "../changes/summarize.js";
import { viewableArchiveIds } from "./archive-visibility.js";
import { maySubmit, unauthorized } from "./authorization.js";
import type { IdentityResolver } from "./identity.js";

export interface ChangeRouteDeps {
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
  reads: ChangeReads;
}

const runAnswer = (row: ChangeRunRow, restricted: boolean) => ({
  crawlId: row.crawlId,
  scheduleId: row.scheduleId,
  scheduleName: row.scheduleName,
  startedAt: row.startedAt,
  scheduledFor: row.scheduledFor,
  prev:
    row.prevCrawlId === null
      ? null
      : {
          crawlId: row.prevCrawlId,
          startedAt: row.prevStartedAt,
          scheduledFor: row.prevScheduledFor,
        },
  state: row.state,
  pagesCompared: row.pagesCompared,
  pagesChanged: row.pagesChanged,
  // 見てよくない WACZ を含む回は、ページの文字から作った物を出さない
  significance: restricted ? null : row.significance,
  headline: restricted ? null : row.headline,
  error: row.error,
  restricted,
});

export const registerChangeRoutes = (app: FastifyInstance, deps: ChangeRouteDeps): void => {
  const { fga, resolveIdentity, reads } = deps;

  app.get<{ Querystring: { before?: string } }>(
    "/api/changes",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { before: { type: "string", format: "date-time" } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) return reply.code(200).send({ runs: [] });
      const { before } = request.query;
      const rows = await reads.listRuns(before === undefined ? undefined : new Date(before));
      const allowed = await viewableArchiveIds(fga, identity, [
        ...new Set(rows.flatMap((row) => row.archiveIds)),
      ]);
      return reply.code(200).send({
        runs: rows.map((row) => runAnswer(row, !row.archiveIds.every((id) => allowed.has(id)))),
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/crawls/:id/changes",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      // 頼めない名乗りには、回が在るかも言わない
      if (!(await maySubmit(fga, identity))) return reply.code(404).send({ error: "not found" });
      const detail = await reads.runDetail(request.params.id);
      if (detail === undefined) return reply.code(404).send({ error: "not found" });

      const allowed = await viewableArchiveIds(fga, identity, [
        ...new Set(
          [
            ...detail.run.archiveIds,
            ...detail.pages.flatMap((p) => [p.after?.archiveId, p.before?.archiveId]),
            ...detail.unchanged.flatMap((p) => [p.after.archiveId, p.before.archiveId]),
          ].filter((id): id is string => id !== undefined),
        ),
      ]);
      const visible = (id: string | undefined) => id !== undefined && allowed.has(id);
      const restricted = !detail.run.archiveIds.every((id) => allowed.has(id));
      const output = detail.summary?.output as ChangeSummary | undefined;
      const pages = detail.pages
        .filter((page) => visible(page.after?.archiveId) && visible(page.before?.archiveId))
        .map((page) => {
          const said = output?.pages.find((p) => p.url === page.url);
          return {
            url: page.url,
            stage: page.stage,
            state: page.state,
            added: page.added,
            removed: page.removed,
            hunks: page.hunks,
            significance: said?.significance ?? null,
            headline: said?.headline ?? null,
            quotes: (said?.quotes ?? []).map((text) => ({
              text,
              verified: !said?.quotesUnverified.includes(text),
            })),
            before: page.before,
            after: page.after,
          };
        });
      return reply.code(200).send({
        ...runAnswer(detail.run, restricted),
        summary:
          detail.summary === null
            ? null
            : {
                evidence: false,
                model: detail.summary.model,
                promptVersion: detail.summary.promptVersion,
                usd: Number(detail.summary.usd),
              },
        pages,
        // pages と同じく、前と今の両方を見てよい組だけ。見てよい名乗りなら pages と足して pagesCompared
        unchanged: detail.unchanged
          .filter((page) => visible(page.after.archiveId) && visible(page.before.archiveId))
          .map((page) => ({
            url: page.url,
            stage: page.stage,
            before: page.before,
            after: page.after,
          })),
      });
    },
  );
};
