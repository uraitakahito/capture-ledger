/**
 * 取り込み 1 回の経緯を読むエンドポイント (CAPTURE-270)。capture-workbench の「経緯」の画面が読む。
 *
 * - `GET /api/crawls/:id/pages/:page/trace`: ページの行・WACZ の在り処・取り込みの欄・ログ・trace を 1 本で返す
 *
 * **capture-ledger は経緯を持たない。** ログのエンドポイント (`GET /api/crawls/:id/pages/:page/log`) と同じく、
 * BrowserHive が答えと一緒に `.result.json` に書いた物を、そのたびに保管庫から読んで返す。DB に写さないので、
 * migration は無い。引く順と、読めないときの答え方もログのエンドポイントと同じ (ページの行 → `task_id` →
 * `capture_submissions.manifest_key` → 保管庫 → 契約に照らす)。違うのは次の 3 つ:
 *
 * - 取り込みの欄 (`capture`) を返す。待ちの内訳 (`settle`)・記録の数 (`waczStats`)・止まった段 (`errorDetails`) など、
 *   時間軸を組むのに要る物だけを選び、下位の object は書かれたまま通す
 * - WACZ の在り処 (`archive`) を返す。**鍵は、その WACZ を見てよいときだけ** (`can_view`)。見てよくなければ id だけ
 * - `log` を持たない `.result.json` (BrowserHive v24.0.0 より前) を、読めない理由にしない —— `log: null` で、
 *   取り込みの欄は返す。ログのエンドポイントの理由 `no-log` は、ここには無い
 *
 * **認可の線。** 名乗りは `can_submit` で通す (ログ・リンクの構成と同じ線)。`trace` の行は要求の URL と時刻で、
 * ログが運ぶ物 (取り込みのページの console の字) と同じ広さに置く。WACZ の中身 (`can_view`) より広いので、
 * 鍵だけを `can_view` で絞る。
 *
 * `trace` (要求の出来事の行) は BrowserHive v30.0.0 から、WACZ を求めた取り込みの `.result.json` に載る。
 * 契約で任意の欄なので、在れば書かれたまま返し、無ければ (それより前の取り込み・WACZ を求めなかった取り込み) null。
 * 行の欄は選び直さない —— 行の形は BrowserHive の契約 (`CaptureTraceLine`) が決め、画面はそれを読む。
 */
import type { S3Client } from "@aws-sdk/client-s3";
import type { OpenFgaClient } from "@openfga/sdk";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";

import { readManifest, type CaptureResultReport } from "../archive/manifest.js";
import { getJsonObject } from "../archive/s3.js";
import type { Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import { mayViewArchive } from "./archive-visibility.js";
import { maySubmit, unauthorized } from "./authorization.js";
import { PAGE_ID, pageOf, pageRows } from "./crawls.js";
import type { IdentityResolver } from "./identity.js";

const log = createChildLogger({ module: "api" });

export interface TraceRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  /** `.result.json` を読むため。読むのは設定の bucket の、記録した鍵だけ。 */
  s3: S3Client;
  bucket: string;
  resolveIdentity: IdentityResolver;
}

/**
 * 経緯を読めなかった理由。どれも 200 で答える —— ページは在り、読めないことが答え。
 *
 * - `not-captured` 取り込みの答えが無い (`task_id` が無い: pending・skipped・flow が切った・断られた)
 * - `no-manifest` 答えはあるが、`.result.json` の場所が記録されていない (書けなかった・capture-ledger に読めない場所)
 * - `manifest-missing` 保管庫の、記録した場所に `.result.json` が無い
 * - `manifest-invalid` `.result.json` が契約に合わない (JSON でない・`readManifest` が断った)
 */
type TraceUnreadable = "not-captured" | "no-manifest" | "manifest-missing" | "manifest-invalid";

/**
 * 取り込みの欄。`.result.json` から、時間軸を組むのに要る物だけを選ぶ。**下位の object は書かれたまま** ——
 * 中の欄を選び直すと、BrowserHive が欄を足すたびにここを直すことになる。無い欄は鍵ごと出さない。
 */
const captureOf = (report: CaptureResultReport) => ({
  status: report.status,
  timestamp: report.timestamp,
  captureProcessingTimeMs: report.captureProcessingTimeMs,
  ...(report.httpStatusCode !== undefined && { httpStatusCode: report.httpStatusCode }),
  ...(report.errorDetails !== undefined && { errorDetails: report.errorDetails }),
  ...(report.settle !== undefined && { settle: report.settle }),
  ...(report.waczStats !== undefined && { waczStats: report.waczStats }),
  ...(report.completeness !== undefined && { completeness: report.completeness }),
  ...(report.document !== undefined && { document: report.document }),
  ...(report.windowsNotOpened !== undefined && { windowsNotOpened: report.windowsNotOpened }),
});

export const registerTraceRoutes = (app: FastifyInstance, deps: TraceRouteDeps): void => {
  const { db, fga, resolveIdentity } = deps;

  app.get<{ Params: { id: string; page: string } }>(
    "/api/crawls/:id/pages/:page/trace",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            page: { type: "string", pattern: PAGE_ID },
          },
          required: ["id", "page"],
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }

      const { id: crawlId, page: pageId } = request.params;
      const row = await pageRows(db, crawlId)
        .leftJoin("captureSubmissions as s", (join) =>
          join.onRef("p.taskId", "=", sql<string>`${sql.ref("s.taskId")}::text`),
        )
        .select(["s.manifestKey", "p.submittedAt", "p.finishedAt", "a.objectKey"])
        .where("p.id", "=", pageId)
        .executeTakeFirst();
      if (!row) return reply.code(404).send({ error: "not found" });

      // flow が測った投入と完了 (`crawl_pages`)。ほかの GET には出していない
      const page = { ...pageOf(row), submittedAt: row.submittedAt, finishedAt: row.finishedAt };
      // WACZ の鍵は、その WACZ を見てよいときだけ。見てよくなければ id だけ (ページの行が既に id を返している)
      const archive =
        row.archiveId === null
          ? null
          : {
              id: row.archiveId,
              objectKey: (await mayViewArchive(fga, identity, row.archiveId))
                ? row.objectKey
                : null,
            };
      const unreadable = (reason: TraceUnreadable) =>
        reply.code(200).send({ page, archive, capture: null, log: null, trace: null, reason });
      if (row.taskId === null) return unreadable("not-captured");
      if (row.manifestKey === null) return unreadable("no-manifest");

      let raw: unknown;
      try {
        raw = await getJsonObject(deps.s3, deps.bucket, row.manifestKey);
      } catch (err) {
        // 中身が JSON でない (`JSON.parse` が投げた) のは、届いたうえで読めない物
        if (err instanceof SyntaxError) {
          log.warn({ err, crawlId, page: pageId, key: row.manifestKey }, "Manifest is not JSON");
          return unreadable("manifest-invalid");
        }
        log.warn(
          { err, crawlId, page: pageId, key: row.manifestKey },
          "Could not read a capture's manifest from the store",
        );
        return reply.code(502).send({ error: "storage unreachable" });
      }
      if (raw === undefined) {
        log.warn(
          { crawlId, page: pageId, key: row.manifestKey },
          "Manifest is not where the capture reported writing it",
        );
        return unreadable("manifest-missing");
      }
      let report: CaptureResultReport;
      try {
        report = readManifest(raw);
      } catch (err) {
        log.warn(
          { err, crawlId, page: pageId, key: row.manifestKey },
          "Manifest is not a report the ledger can read",
        );
        return unreadable("manifest-invalid");
      }
      return reply.code(200).send({
        page,
        archive,
        capture: captureOf(report),
        // `log` は契約で任意の欄 (BrowserHive v24.0.0 より前の取り込みには無い)。在れば、書かれたまま返す
        log: report.log ?? null,
        // `trace` も契約で任意の欄 (BrowserHive v30.0.0 より前の取り込みと、WACZ を求めなかった取り込みには無い)
        trace: report.trace ?? null,
        reason: null,
      });
    },
  );
};
