/**
 * 前のクロールのリンクを、保管庫の `.links.json` から読み直して `crawl_links` (`039`) に埋める (CAPTURE-246)。
 *
 * 読むか読まないか (`links-source.ts`)・どうなったか (`link-outcomes.ts`)・書き方 (`links-store.ts`) は、段の報告と
 * 同じ物を使う。違うのは、入らなかった理由の決め方だけ (`cutOfRecorded`)。
 *
 * **`.links.json` が 1 つでも保管庫に無いクロールは、書かずに飛ばす** —— 一部のページだけ埋めると、埋めなかった
 * ページが「リンクなし」と同じに見える。飛ばしたクロールは、記録の無いクロールのまま (図は木だけになる)。
 */
import type { S3Client } from "@aws-sdk/client-s3";
import { sql, type Kysely } from "kysely";

import { getJsonObject } from "../archive/s3.js";
import type { CrawlRule, CrawlStopReason, Database } from "../db/database.js";
import { cutOfRecorded, linkRows, type LinkRow } from "./link-outcomes.js";
import { distinctDiscovered } from "./links-read.js";
import { readPageLinks } from "./links-source.js";
import { pageParents, replaceLinks } from "./links-store.js";
import { compileRules } from "./rules.js";
import { parseHttpUrl, type ParsedUrl } from "./scope.js";

export interface BackfillCrawl {
  id: string;
  seeds: string[];
  rules: CrawlRule[];
  maxDepth: number;
  stopReason: CrawlStopReason | null;
}

export type BackfillResult =
  /** 書いた (か、`write` が false なら書くはずだった) 行の数と、リンクを読んだページの数。 */
  | { kind: "filled"; rows: number; pages: number; dropped: number }
  /** 飛ばした。理由を言う。 */
  | { kind: "skipped"; why: string };

/** クロール 1 本を埋める。`write` が false なら数えるだけ。 */
export const backfillCrawl = async (
  deps: { db: Kysely<Database>; s3: S3Client; bucket: string },
  crawl: BackfillCrawl,
  write: boolean,
): Promise<BackfillResult> => {
  const seeds: ParsedUrl[] = [];
  for (const raw of crawl.seeds) {
    const parsed = parseHttpUrl(raw);
    if (parsed === undefined) return { kind: "skipped", why: "起点の URL が読めない" };
    seeds.push(parsed);
  }
  const rules = compileRules(crawl.rules);
  if (rules === undefined) return { kind: "skipped", why: "規則が読めない" };

  // 取り込みの答え (.result.json) の在り処は、段の報告が書き留めた `capture_submissions.manifest_key`
  const pages = await sql<{
    id: string;
    url: string;
    depth: number;
    manifestKey: string | null;
  }>`
    select p.id, p.url, p.depth, s.manifest_key
      from crawl_pages p
      left join capture_submissions s on s.task_id::text = p.task_id
     where p.crawl_id = ${crawl.id} and p.state = 'captured'
     order by p.id`.execute(deps.db);

  const parents = await pageParents(deps.db, crawl.id);
  const rows: LinkRow[] = [];
  const read: string[] = [];
  let dropped = 0;
  for (const page of pages.rows) {
    if (page.manifestKey === null) {
      return { kind: "skipped", why: `ページ ${page.id} の取り込みの答えの在り処が無い` };
    }
    const manifest = await getJsonObject(deps.s3, deps.bucket, page.manifestKey);
    if (manifest === undefined || manifest === null || typeof manifest !== "object") {
      return { kind: "skipped", why: `保管庫に ${page.manifestKey} が無い` };
    }
    const location = (manifest as { artifacts?: { links?: unknown } }).artifacts?.links;
    // links を頼んでいない取り込み (古い版の最後の段など)。読んでいないので、行も「読んだページ」も作らない
    if (typeof location !== "string" || location === "") continue;
    const got = await readPageLinks(
      { s3: deps.s3, bucket: deps.bucket },
      { url: page.url, linksLocation: location },
      rules,
      seeds,
    );
    if (got.kind === "missing") return { kind: "skipped", why: `保管庫に ${location} が無い` };
    if (got.kind === "unread") continue;
    const made = linkRows(
      crawl.id,
      [{ from: page.id, links: got.links }],
      parents,
      cutOfRecorded({
        nextDepth: page.depth + 1,
        maxDepth: crawl.maxDepth,
        stopReason: crawl.stopReason,
      }),
    );
    rows.push(...made.rows);
    dropped += made.dropped;
    read.push(page.id);
  }

  if (write) {
    await deps.db.transaction().execute(async (trx) => {
      await replaceLinks(trx, crawl.id, read, rows);
      // 一覧の「リンク」を、規則が通した別々の URL の数に (`levels.ts` の `writeTotals` と同じ数)
      const distinct = await distinctDiscovered(trx, crawl.id);
      if (distinct !== null) {
        await trx
          .updateTable("crawls")
          .set({ pagesDiscovered: distinct })
          .where("id", "=", crawl.id)
          .execute();
      }
    });
  }
  return { kind: "filled", rows: rows.length, pages: read.length, dropped };
};

/** リンクの記録が無く、締まっているクロール。古い順。`only` を渡せば、その 1 本だけ (記録の有無は問う)。 */
export const unrecordedCrawls = async (
  db: Kysely<Database>,
  only?: string,
): Promise<BackfillCrawl[]> => {
  let query = db
    .selectFrom("crawls")
    .select(["id", "seeds", "rules", "maxDepth", "stopReason"])
    .where("linksRecordedAt", "is", null)
    .where("state", "<>", "running")
    .orderBy("startedAt");
  if (only !== undefined) query = query.where("id", "=", only);
  return query.execute();
};
