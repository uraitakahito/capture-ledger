/**
 * 全文検索の口。索引に載せることと、引くこと。
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
 * **代償: 件数とページングが正確でない。** 50 件求めて 30 件返ることがある。
 * 見てよいものだけを数えるには、数える前に認可を掛けるしかなく、それは上の
 * 「索引に権限を持たせる」に戻る。数の正確さより権威が 1 つであることを採る。
 *
 * ## 索引の口が受け取るのはクロール id だけ
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
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "api-search" });

/** 1 回の検索で OpenSearch に求める件数。認可で落ちるので、返る数はこれ以下。 */
const PAGE_SIZE = 50;

export interface SearchRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  s3: S3Client;
  search: Client;
  index: string;
  resolveIdentity: IdentityResolver;
}

interface Hit {
  archiveId: string;
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

  /**
   * クロール 1 本ぶんを索引に載せる。
   *
   * 認可は `/api/crawls/:id/pages` と同じ (`can_submit`) —— 呼ぶのは同じ flow で、
   * 段を報告できる者は索引も書けてよい。載せる中身は既に台帳に在るので、
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
      // まだ載せていないものだけ。`crawl_pages.task_id` が台帳と繋ぐ唯一の鍵で、
      // `archives` はクロールを知らない (知るべきでもない —— 台帳が運ぶのは
      // 在り処と来歴だけ)。
      //
      // **型が揃っていないので cast する。** `archives.task_id` は `uuid` (`002`)、
      // `crawl_pages.task_id` は `text` (`008`) で、素の比較は
      // `operator does not exist: text = uuid` になる。向きは uuid → text ——
      // 逆向きは UUID として読めない値が 1 行でもあると問い合わせ全体が落ちる。
      //
      // `archives.correlation_id` で引く手もある (クロールは crawl id を
      // correlationId として投げるので一致する) が、あちらは **申し合わせ** で、
      // こちらは記録された関係。投げ方が変わったときに黙って壊れるのは前者。
      const pending = await db
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

      if (pending.length === 0) {
        return reply.code(202).send({ indexed: 0, pages: 0 });
      }

      await ensureIndex(search, index);

      let indexed = 0;
      let pages = 0;
      for (const archive of pending) {
        try {
          pages += await indexArchive(archive, { db, s3, search, index });
          indexed += 1;
        } catch (err) {
          // 1 本の失敗で全体を落とさない。`indexed_at` は立っていないので、
          // 次に同じ口を叩けば拾い直す。
          log.warn({ err, archiveId: archive.id }, "could not index this archive");
        }
      }
      log.info({ crawlId, pending: pending.length, indexed, pages }, "crawl indexed");
      return reply.code(202).send({ indexed, pages });
    },
  );

  /**
   * 引く。
   *
   * 返るのは**見てよいものだけ**だが、`total` は索引が数えた生の件数なので、
   * 返った件数とは一致しない。上の docstring のとおり、これは設計上の代償。
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
      const found = await search.search({
        index,
        // 索引がまだ無い配備で 404 を返さない。まだ何も載せていないだけなので、
        // 「見つからない」が正しい答え。
        ignore_unavailable: true,
        body: {
          size: PAGE_SIZE,
          query: { multi_match: { query: q, fields: ["title^2", "text"] } },
          highlight: { fields: { text: {} } },
        },
      });

      // client の型は `_source` を省略可能として持つ (`_source: false` で引けるため)。
      // こちらは必ず本体を求めているので、その形で受け直す。
      const hits = (found.body.hits?.hits ?? []) as unknown as {
        _source: Hit;
        highlight?: { text?: string[] };
      }[];
      if (hits.length === 0) return reply.code(200).send({ hits: [], total: 0 });

      // **ここが唯一の認可。** 索引は誰に見せてよいかを知らないし、知るべきでもない。
      const allowed = await viewableArchiveIds(
        fga,
        identity,
        hits.map((hit) => hit._source.archiveId),
      );

      return reply.code(200).send({
        hits: hits
          .filter((hit) => allowed.has(hit._source.archiveId))
          .map((hit) => ({ ...hit._source, highlight: hit.highlight?.text })),
        // 索引が数えた生の件数。**認可で落ちた分を含む** —— 返った配列の長さとは
        // 一致しないことがある。
        total: found.body.hits?.total ?? 0,
      });
    },
  );
};
