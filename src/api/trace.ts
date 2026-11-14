/**
 * 取り込み 1 回の経緯を読むエンドポイント (CAPTURE-270)。capture-workbench の「経緯」の画面が読む。
 *
 * - `GET /api/crawls/:id/pages/:page/trace`: ページの行・WACZ の在り処・取り込みの欄・ログ・trace を 1 本で返す
 * - `GET /api/crawls/:id/pages/:page/trace/failure-screenshot`: 失敗した取り込みの、失敗の時点の絵を返す
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
 *
 * ## 絵 (BrowserHive v30.2.0 から。絵を撮る設定 `BROWSERHIVE_STAGE_SCREENSHOTS` の配備だけ)
 *
 * - 節目のスクリーンショットの成り行き (`screenshots`) は、取り込みの欄に書かれたまま足す。絵そのものは BrowserHive WACZ の中の
 *   レコードで、ここが返すのは時点ごとの名指し (か、残さなかった理由) だけ
 * - 失敗の時点の絵 (`failureScreenshot`) は WACZ の外のファイル。取り込みの欄では**呼び出し元が受け取れる絵が在るか
 *   だけ**を言い、保管庫の場所は返さない。絵は別のエンドポイントが返す
 *
 * **絵の認可は、経緯より狭い。** 絵は取り込みのページが見せていた物そのもので、WACZ の中身と同じ広さに置く。
 * WACZ は `can_view` (その archive から、保存された経路で組織に届く) で絞るが、失敗した取り込みには archive が無い。
 * だから `can_submit` に加えて、**取り込みを出した組織 (`capture_submissions.org_id`) に呼び出し元が属するか**を見る。
 * 組織を決めるのは capture-ledger が記録した行で、呼び出し元は選べない —— `can_view` が所属の申告を受けてよいのと
 * 同じ形 (`api/archive-visibility.ts`)。属さなければ、無いページと同じ 404。経緯の答えの真偽も同じ線で決める
 * (`inSubmittingOrganization` と `failureScreenshotKey` の 2 つを、どちらのエンドポイントも通す) —— 属さない呼び出し元には
 * `false` で、経緯そのものは今までどおり見える。
 */
import type { S3Client } from "@aws-sdk/client-s3";
import type { OpenFgaClient } from "@openfga/sdk";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";

import {
  failureScreenshotKey,
  readManifest,
  type CaptureResultReport,
} from "../archive/manifest.js";
import { getJsonObject, getObjectBytes, objectSize } from "../archive/s3.js";
import type { Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import { mayViewArchive } from "./archive-visibility.js";
import { maySubmit, unauthorized } from "./authorization.js";
import { PAGE_ID, pageOf, pageRows } from "./crawls.js";
import type { Identity, IdentityResolver } from "./identity.js";

const log = createChildLogger({ module: "api" });

export interface TraceRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  /** `.result.json` と失敗の時点の絵を読むため。読むのは設定の bucket の、記録した鍵と、その `.result.json` が言う鍵だけ。 */
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
 * 失敗の時点の絵として返す大きさの上限。viewport 1 枚の WebP は数十〜数百 KiB で、答えは base64 の JSON なので
 * 丸ごとメモリに載る。読む鍵は `.result.json` が言った物なので、そこに何が在っても、これより大きい物は読まない。
 */
const FAILURE_SCREENSHOT_MAX_BYTES = 1024 * 1024;

/** WebP の頭 (RIFF の入れ物の `RIFF`・4 バイトの長さ・`WEBP`)。 */
const isWebp = (bytes: Buffer): boolean =>
  bytes.length >= 12 &&
  bytes.toString("latin1", 0, 4) === "RIFF" &&
  bytes.toString("latin1", 8, 12) === "WEBP";

const PAGE_PARAMS = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    page: { type: "string", pattern: PAGE_ID },
  },
  required: ["id", "page"],
} as const;

/**
 * 呼び出し元が、取り込みを出した組織に属するか。失敗の時点の絵を見てよいかの線で、経緯の答えの真偽
 * (`capture.failureScreenshot`) と、絵を返すエンドポイントの両方が通す。
 *
 * **組織は capture-ledger が記録した行の物** (`capture_submissions.org_id`) を渡す。呼び出し元が言った組織を渡すと、
 * 「属すると言った者に、属するかを訊く」形になる。行の無い取り込み (null) は、誰の物でもない。
 */
const inSubmittingOrganization = (identity: Identity, orgId: string | null): boolean =>
  orgId !== null && identity.organizations.includes(orgId);

/**
 * 取り込みの欄。`.result.json` から、時間軸を組むのに要る物だけを選ぶ。**下位の object は書かれたまま** ——
 * 中の欄を選び直すと、BrowserHive が欄を足すたびにここを直すことになる。無い欄は鍵ごと出さない。
 *
 * `failureScreenshot` だけは書かれたままにしない。`.result.json` の値は保管庫の場所なので、**呼び出し元が受け取れる絵が
 * 在るか**の真偽に替える (絵は `…/trace/failure-screenshot` が返す)。`mayViewPicture` は、呼び出し元が取り込みを出した
 * 組織に属するか —— 属さない呼び出し元に `true` と言うと、取りに行った先で 404 になる。
 */
const captureOf = (report: CaptureResultReport, bucket: string, mayViewPicture: boolean) => ({
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
  ...(report.screenshots !== undefined && { screenshots: report.screenshots }),
  failureScreenshot: mayViewPicture && failureScreenshotKey(report, bucket) !== null,
});

/** `.result.json` を読んだ結果。読めた報告か、読めない理由か、保管庫に届かなかったか。 */
type ManifestRead =
  | { report: CaptureResultReport }
  | { unreadable: "manifest-missing" | "manifest-invalid" }
  | { unreachable: true };

/** 記録した鍵の `.result.json` を保管庫から読み、契約に照らす。読めない理由は、ここでログに書く。 */
const readReport = async (
  deps: Pick<TraceRouteDeps, "s3" | "bucket">,
  where: { crawlId: string; page: string; key: string },
): Promise<ManifestRead> => {
  let raw: unknown;
  try {
    raw = await getJsonObject(deps.s3, deps.bucket, where.key);
  } catch (err) {
    // 中身が JSON でない (`JSON.parse` が投げた) のは、届いたうえで読めない物
    if (err instanceof SyntaxError) {
      log.warn({ err, ...where }, "Manifest is not JSON");
      return { unreadable: "manifest-invalid" };
    }
    log.warn({ err, ...where }, "Could not read a capture's manifest from the store");
    return { unreachable: true };
  }
  if (raw === undefined) {
    log.warn(where, "Manifest is not where the capture reported writing it");
    return { unreadable: "manifest-missing" };
  }
  try {
    return { report: readManifest(raw) };
  } catch (err) {
    log.warn({ err, ...where }, "Manifest is not a report the ledger can read");
    return { unreadable: "manifest-invalid" };
  }
};

export const registerTraceRoutes = (app: FastifyInstance, deps: TraceRouteDeps): void => {
  const { db, fga, resolveIdentity } = deps;

  app.get<{ Params: { id: string; page: string } }>(
    "/api/crawls/:id/pages/:page/trace",
    { schema: { params: PAGE_PARAMS } },
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
        .select(["s.manifestKey", "s.orgId", "p.submittedAt", "p.finishedAt", "a.objectKey"])
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

      const read = await readReport(deps, { crawlId, page: pageId, key: row.manifestKey });
      if ("unreachable" in read) return reply.code(502).send({ error: "storage unreachable" });
      if ("unreadable" in read) return unreadable(read.unreadable);
      const { report } = read;
      return reply.code(200).send({
        page,
        archive,
        capture: captureOf(report, deps.bucket, inSubmittingOrganization(identity, row.orgId)),
        // `log` は契約で任意の欄 (BrowserHive v24.0.0 より前の取り込みには無い)。在れば、書かれたまま返す
        log: report.log ?? null,
        // `trace` も契約で任意の欄 (BrowserHive v30.0.0 より前の取り込みと、WACZ を求めなかった取り込みには無い)
        trace: report.trace ?? null,
        reason: null,
      });
    },
  );

  /**
   * 失敗の時点の絵 (CAPTURE-270)。答えは JSON で、絵は base64 —— capture-workbench の `/api/*` の中継が文字だけを通すため。
   *
   * 絵の無い取り込みは 404。**無い理由は分けない** (ページが無い・別の組織の取り込み・答えが無い・`.result.json` が
   * 読めない・絵を言っていない・設定の bucket の外・保管庫に無い)。分けると、属さない組織の取り込みについて
   * 「在るが見せない」が外から読める。理由はログに書く。
   *
   * 在るのに返さない物は 502 で、理由を言う: 保管庫に届かない (`storage unreachable`)・上限より大きい
   * (`failure screenshot too large`)・WebP でない (`failure screenshot is not a WebP image`)。後の 2 つは、
   * `.result.json` が言った場所に、BrowserHive が置くはずの物と違う物が在る —— 中身を確かめずに `image/webp` と
   * 名乗って返すと、このエンドポイントが保管庫の任意の object を読み出す道になる。
   */
  app.get<{ Params: { id: string; page: string } }>(
    "/api/crawls/:id/pages/:page/trace/failure-screenshot",
    { schema: { params: PAGE_PARAMS } },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);
      const notFound = () => reply.code(404).send({ error: "not found" });
      if (!(await maySubmit(fga, identity))) return notFound();

      const { id: crawlId, page: pageId } = request.params;
      // 取り込みの答えの無いページ (`task_id` が無い) は行ごと出ない。繋ぎ方は `pageRows` と同じ (uuid 側を text に倒す)
      const row = await db
        .selectFrom("crawlPages as p")
        .innerJoin("captureSubmissions as s", (join) =>
          join.onRef("p.taskId", "=", sql<string>`${sql.ref("s.taskId")}::text`),
        )
        .select(["s.orgId", "s.manifestKey"])
        .where("p.crawlId", "=", crawlId)
        .where("p.id", "=", pageId)
        .executeTakeFirst();
      if (!row) return notFound();
      // **組織を決めるのは記録した行** (`capture_submissions.org_id`)。呼び出し元の所属は、それと比べるだけ
      if (!inSubmittingOrganization(identity, row.orgId)) {
        log.info({ subject: identity.subject, crawlId, page: pageId }, "Denied");
        return notFound();
      }
      if (row.manifestKey === null) return notFound();

      const where = { crawlId, page: pageId };
      const read = await readReport(deps, { ...where, key: row.manifestKey });
      if ("unreachable" in read) return reply.code(502).send({ error: "storage unreachable" });
      if ("unreadable" in read) return notFound();
      const key = failureScreenshotKey(read.report, deps.bucket);
      if (key === null) {
        if (read.report.failureScreenshot !== undefined) {
          log.warn(
            { ...where, location: read.report.failureScreenshot },
            "Failure screenshot is not at a location the ledger reads",
          );
        }
        return notFound();
      }

      let bytes: Buffer | undefined;
      try {
        // **読む前に大きさを訊く。** 上限より大きい物は、1 バイトも読まない
        const size = await objectSize(deps.s3, deps.bucket, key);
        if (size !== undefined && size > FAILURE_SCREENSHOT_MAX_BYTES) {
          log.warn({ ...where, key, size }, "Failure screenshot is larger than the ledger returns");
          return reply.code(502).send({ error: "failure screenshot too large" });
        }
        bytes = size === undefined ? undefined : await getObjectBytes(deps.s3, deps.bucket, key);
      } catch (err) {
        log.warn({ err, ...where, key }, "Could not read a failure screenshot from the store");
        return reply.code(502).send({ error: "storage unreachable" });
      }
      if (bytes === undefined) {
        log.warn({ ...where, key }, "Failure screenshot is not where the capture reported it");
        return notFound();
      }
      // 訊いた後に置き換わった物も、上限の外なら返さない
      if (bytes.length > FAILURE_SCREENSHOT_MAX_BYTES) {
        return reply.code(502).send({ error: "failure screenshot too large" });
      }
      if (!isWebp(bytes)) {
        log.warn({ ...where, key }, "Failure screenshot is not a WebP image");
        return reply.code(502).send({ error: "failure screenshot is not a WebP image" });
      }
      return reply.code(200).send({ contentType: "image/webp", base64: bytes.toString("base64") });
    },
  );
};
