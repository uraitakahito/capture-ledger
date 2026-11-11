/**
 * 全文検索のエンドポイント。索引に載せることと、引くこと。
 *
 * ## 認可を索引に持たせない
 *
 * 引くのは OpenSearch だが、**誰に見せてよいかは OpenFGA にしか無い**。索引に
 * 組織や権限を写せば問い合わせ 1 回で絞れて速いが、そうすると索引が認可の権威に
 * なり、1 つの事実に住処が 2 つできる。片方を直しても**両方とも動いているように
 * 見える** —— `api/authorization.ts` が同じ失敗の経緯を書いている。
 *
 * だから `GET /api/archives` と同じ形にする: 索引に訊いてから、返ってきた分に
 * ついて `batchCheck` する。`routes.ts` が `ListObjects` を選ばなかった理由
 * (既定 1,000 件の上限) はここにもそのまま当てはまる。
 *
 * **代償: ページングが無い。** 50 件求めて 30 件返ることがある。`total` は返した (見てよい) 当たりの
 * 数で、索引が数えた生の件数は返さない —— 生の件数は、見てはいけないアーカイブの当たりの数を
 * 漏らす (CAPTURE-53 で直した。以前は生の件数を返していた)。見てよいものだけを索引の側で数えるには、
 * 数える前に認可を掛けるしかなく、それは上の「索引に権限を持たせる」に戻る。
 *
 * ## OpenSearch が答えなければ 503
 *
 * 検索は必須 (CAPTURE-53)。どちらのエンドポイントも、OpenSearch が答えないときは 503 `search unavailable` を返す。
 * 以前は索引のエンドポイントが 500、検索のエンドポイントは索引が無いと 0 件で返り、どちらも「無い」と「壊れている」を
 * 分けなかった。
 *
 * ## 索引のエンドポイントが受け取るのはクロール id だけ
 *
 * archive の id を Windmill に持たせない。どれがまだ載っていないかは
 * `indexed_at IS NULL` が知っているので、**呼ぶ側は「このクロールぶんを」と
 * 言えれば足りる**。flow に判断を置かないための線引き。
 */
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Client } from "@opensearch-project/opensearch";
import type { Database } from "../db/database.js";
import type { IdentityResolver } from "./identity.js";
import { maySubmit, unauthorized } from "./authorization.js";
import { viewableArchiveIds } from "./archive-visibility.js";
import { indexArchive } from "../search/index-archive.js";
import { ensureIndex } from "../search/client.js";
import type { ArchiveRow } from "../search/document.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "api-search" });

/** 1 回の検索で OpenSearch に求める件数。認可で落ちるので、返る数はこれ以下。 */
const PAGE_SIZE = 50;

/** OpenSearch が答えないときの答え。検索は必須なので、「飛ばした」と読める答えにしない。 */
const SEARCH_UNAVAILABLE = {
  error: "search unavailable",
  message:
    "OpenSearch did not answer — full-text search is required (dev: pnpm run stack:up --profile search opensearch, then pnpm run search:reindex)",
} as const;

/** まだ索引に載せていないアーカイブ 1 本 (`indexArchive` が読む欄)。 */
export type PendingArchive = ArchiveRow & { bucket: string };

export interface SearchRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  s3: S3Client;
  search: Client;
  index: string;
  resolveIdentity: IdentityResolver;
  /**
   * 差し替える引数。既定は、capture-ledger からこのクロールのまだ載せていない行を引く問い合わせ
   * (`pendingArchivesOf`) と `indexArchive`。試験は DB と保管庫を立てずに、答えの形と数え方を見る
   * (capture-ledger に DB の試験は無い)。
   */
  pendingOf?: (crawlId: string) => Promise<PendingArchive[]>;
  indexOne?: (archive: PendingArchive) => Promise<number>;
}

/**
 * クロール 1 本ぶんの、まだ索引に載せていないアーカイブ。繋ぐのは `crawl_pages.task_id` —— `archives.crawl_id`
 * (`027`。合本のために足した来歴の列) は 027 より前の行で空なので、ここでは使わない。
 *
 * **型が揃っていないので cast する。** `archives.task_id` は `uuid` (`002`)、
 * `crawl_pages.task_id` は `text` (`008`) で、素の比較は
 * `operator does not exist: text = uuid` になる。向きは uuid → text ——
 * 逆向きは UUID として読めない値が 1 行でもあると問い合わせ全体が落ちる。
 *
 * `archives.correlation_id` で引く手もある (クロールは crawl id を
 * correlationId として投げるので一致する) が、あちらは **申し合わせ** で、
 * こちらは記録された関係。投げ方が変わったときに黙って壊れるのは前者。
 */
const pendingArchivesOf =
  (db: Kysely<Database>) =>
  (crawlId: string): Promise<PendingArchive[]> =>
    db
      .selectFrom("archives")
      .innerJoin("crawlPages", (join) =>
        join.onRef("crawlPages.taskId", "=", sql<string>`${sql.ref("archives.taskId")}::text`),
      )
      .select([
        "archives.id",
        "archives.bucket",
        "archives.objectKey",
        "archives.sourceUrl",
        "archives.labels",
        "archives.capturedAt",
      ])
      .where("crawlPages.crawlId", "=", crawlId)
      .where("archives.indexedAt", "is", null)
      .distinctOn("archives.id")
      .execute();

interface Hit {
  archiveId: string;
  stage: string | null;
  url: string;
  title: string;
  objectKey: string;
  capturedAt: string;
  textTruncated: boolean;
  textWithheld: string | null;
  highlight?: string[];
}

export const registerSearchRoutes = (app: FastifyInstance, deps: SearchRouteDeps): void => {
  const { db, fga, s3, search, index, resolveIdentity } = deps;
  const pendingOf = deps.pendingOf ?? pendingArchivesOf(db);
  const indexOne =
    deps.indexOne ??
    ((archive: PendingArchive) => indexArchive(archive, { db, s3, search, index }));

  /**
   * クロール 1 本ぶんを索引に載せる。
   *
   * 認可は段の報告 (`POST /api/crawls/:id/pages`) と同じ (`can_submit`) —— 呼ぶのは同じ flow で、
   * 段を報告できる者は索引も書けてよい。載せる中身は既に capture-ledger に在るので、
   * ここで新しく見えるようになるものは無い。
   */
  app.post<{ Params: { id: string } }>(
    "/api/crawls/:id/index",
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
      if (!(await maySubmit(fga, identity))) {
        return reply.code(404).send({ error: "not found" });
      }

      const crawlId = request.params.id;
      const pending = await pendingOf(crawlId);
      if (pending.length === 0) {
        return reply.code(202).send({ pending: 0, indexed: 0, failed: 0, pages: 0 });
      }

      // 起動の時にも作っているが、OpenSearch が作り直されていれば索引は消えている。ここでも確かめる。
      try {
        await ensureIndex(search, index);
      } catch (err) {
        log.warn({ err, crawlId }, "OpenSearch did not answer");
        return reply.code(503).send(SEARCH_UNAVAILABLE);
      }

      let indexed = 0;
      let pages = 0;
      for (const archive of pending) {
        try {
          pages += await indexOne(archive);
          indexed += 1;
        } catch (err) {
          // 1 本の失敗で残りを止めない。`indexed_at` は立っていないので、
          // もう一度このエンドポイントを叩けば拾い直す (周回は無い —— 叩くのは flow か search:reindex)。
          log.warn({ err, archiveId: archive.id }, "could not index this archive");
        }
      }
      const failed = pending.length - indexed;
      log.info({ crawlId, pending: pending.length, indexed, failed, pages }, "crawl indexed");
      // 取りこぼしも 202 で、数で言う。段を誤りにするかは呼ぶ側 (flow の index_level) が `failed` で決める。
      return reply.code(202).send({ pending: pending.length, indexed, failed, pages });
    },
  );

  /**
   * 引く。
   *
   * 返るのは**見てよいものだけ**で、`total` はその数 (最大 50)。索引が数えた生の件数は返さない
   * (上の docstring)。
   *
   * 1 件はアーカイブの 1 時点 (`stage`)。同じアーカイブの検索前と検索後が両方当たれば
   * 2 件返る。
   */
  app.get<{ Querystring: { q: string } }>(
    "/api/search",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["q"],
          properties: { q: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const identity = await resolveIdentity(request);
      if (!identity) return unauthorized(reply);

      const q = request.query.q;
      // 索引は起動の時に作るので、無いのは OpenSearch が作り直されたとき。そのときも 0 件ではなく 503 ——
      // 「当たらない」と「索引が無い」を同じ答えにしない (以前は `ignore_unavailable` で 0 件だった)。
      const found = await search
        .search({
          index,
          body: {
            size: PAGE_SIZE,
            query: { multi_match: { query: q, fields: ["title^2", "text"] } },
            highlight: { fields: { text: {} } },
          },
        })
        .catch((err: unknown) => {
          log.warn({ err }, "OpenSearch did not answer a search");
          return undefined;
        });
      if (found === undefined) return reply.code(503).send(SEARCH_UNAVAILABLE);

      // client の型は `_source` を省略可能として持つ (`_source: false` で引けるため)。
      // こちらは必ず本体を求めているので、その形で受け直す。
      const hits = (found.body.hits?.hits ?? []) as unknown as {
        _source: Hit;
        highlight?: { text?: string[] };
      }[];
      if (hits.length === 0) return reply.code(200).send({ hits: [], total: 0 });

      // **ここが唯一の認可。** 索引は誰に見せてよいかを知らないし、知るべきでもない。
      // 同じアーカイブが時点ごとに当たっても、答えはアーカイブで決まるので 1 回だけ訊く。
      const allowed = await viewableArchiveIds(fga, identity, [
        ...new Set(hits.map((hit) => hit._source.archiveId)),
      ]);

      const visible = hits
        .filter((hit) => allowed.has(hit._source.archiveId))
        .map((hit) => ({ ...hit._source, highlight: hit.highlight?.text }));
      // 見てよい当たりの数。索引の生の件数 (`hits.total`) は、認可で落ちた分を数えてしまう。
      return reply.code(200).send({ hits: visible, total: visible.length });
    },
  );
};
