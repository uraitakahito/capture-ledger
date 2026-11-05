/**
 * クロール 1 本の合本を、新しい版として保管庫に書く。口 (`POST /api/crawls/:id/replay-bundle`) と作り直しの道具
 * (`pnpm run replay-bundle:rebuild`) が同じこれを呼ぶ。形を決めるのは `replay-bundle/format.ts` で、ここは配管。
 *
 * 1. まだ検めていない WACZ を検める (`replay-bundle/inspect.ts`)。1 本の失敗で止めない (`failed` に数える)
 * 2. **1 つのトランザクションで**、版を払い出し (`crawls.replay_bundle_next_rev` を行の更新で 1 つ進める)、
 *    検めたアーカイブとその頁の行を読む
 * 3. 組んで、`pages.json`・`replay.json` の順に保管庫へ書く (`application/json`)
 * 4. 台帳が指す版を **前へだけ** 進め、その版で初めて入ったアーカイブに版を書く
 *
 * ## 版の払い出しと読みを 1 つのトランザクションに置く理由
 *
 * 払い出しの UPDATE はクロールの行に鍵を掛け、commit まで持つ。2 本が同時に来ても、後の版の読みは前の版の読みより
 * 後になる —— **大きい版ほど、入っているアーカイブが多いか同じ**。これが崩れると、台帳が指す (いちばん大きい) 版に、
 * 小さい版にはあった WACZ が無い、が起こりうる。dashboard は「頁の WACZ が入った最初の版 (`archives.replay_bundle_rev`)
 * ≤ 台帳の指す版」で頁を合本の中で開くので、それが嘘になる。保管庫に書くのは鍵を放した後。
 *
 * ## 前へだけ
 *
 * 段 N+1 の報告は段 N の合本より先に来うる (次の段は段の報告の中で出る)。遅れて書き終えた古い版が、新しい版を
 * 指していた台帳を戻さないように、指す版は「書き終えた版がいまより大きいときだけ」差し替える。版ごとの置き場は
 * 書いたら変えない (払い出した版は 1 度しか書かれない)。
 *
 * ## 失敗してもクロールを止めない
 *
 * 保管庫に書けなければ、理由を `crawls.replay_bundle_error` に残して返す (投げない)。合本は撮った物から作る派生物で、
 * 失敗でクロールを failed にすると、次の段が既に出ているときに状態が食い違う。理由も前へだけ —— 台帳がいま指す版より
 * 古い版の失敗は書かない。次に書けたら消える。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import { putObject } from "../archive/s3.js";
import type { Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import { composeReplayBundle } from "./format.js";
import { inspectArchive, uninspectedArchives, type UninspectedArchive } from "./inspect.js";

const log = createChildLogger({ module: "replay-bundle-write" });

/** 合本を書いた (書こうとした) 結末。口の答えの形そのもの。 */
export interface ReplayBundleResult {
  /** 書いた (書こうとした) 版。アーカイブが 1 本も入らず書かなかったときは null。 */
  rev: number | null;
  /** `pages.json` の行の数 (`totalPages`)。 */
  pages: number;
  /** `resources` に入れた WACZ の数。 */
  members: number;
  /** 記録が 0 で外した WACZ の数。 */
  skipped: number;
  /** 検められなかった WACZ の数 (保管庫に無い・zip として読めない・保管庫に届かない)。次の合本が拾い直す。 */
  failed: number;
  /** 書けなかった理由。書けたら null。 */
  error: string | null;
}

export interface WriteReplayBundleOptions {
  db: Kysely<Database>;
  s3: S3Client;
  /** 合本を書き、`.result.json` を読む bucket (設定の物。WACZ と同じ bucket)。 */
  bucket: string;
  now?: () => Date;
  /** 差し替え口。既定は `inspectArchive`。試験は zip を作らずに数え方を見る。 */
  inspectOne?: (archive: UninspectedArchive) => Promise<void>;
}

/**
 * 027 より前のアーカイブを、クロールに繋ぐ (`archives.crawl_id` が空で、そのクロールの頁の行が同じ task_id を
 * 持つ物)。繋いだ数を返す。作り直しの道具だけが呼ぶ —— 027 からは受けるときに入る (`archive/admit.ts`)。
 *
 * 繋ぎ方は台帳の他の口 (`waczCount`・索引の口) と同じ `crawl_pages.task_id` で、uuid 側を text に倒す。
 */
export const linkArchivesToCrawl = async (
  db: Kysely<Database>,
  crawlId: string,
): Promise<number> => {
  const linked = await db
    .updateTable("archives")
    .set({ crawlId })
    .where("crawlId", "is", null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("crawlPages as p")
          .select("p.id")
          .where("p.crawlId", "=", crawlId)
          .where("p.taskId", "=", sql<string>`${sql.ref("archives.taskId")}::text`),
      ),
    )
    .executeTakeFirst();
  return Number(linked.numUpdatedRows);
};

/**
 * 書く。クロールが無ければ `undefined`。DB に届かないときだけ投げる (保管庫の失敗は `error` で返す)。
 *
 * @param depth flow の段の深さ。`replay.json` の `replayBundle.depth` に記録するだけ (作り直しの道具は null)。
 */
export const writeReplayBundle = async (
  crawlId: string,
  depth: number | null,
  options: WriteReplayBundleOptions,
): Promise<ReplayBundleResult | undefined> => {
  const { db, s3, bucket } = options;
  const now = options.now ?? (() => new Date());
  const inspectOne =
    options.inspectOne ??
    ((archive: UninspectedArchive) => inspectArchive(archive, { db, s3, bucket, now }));

  const crawl = await db
    .selectFrom("crawls")
    .select(["id", "orgId"])
    .where("id", "=", crawlId)
    .executeTakeFirst();
  if (crawl === undefined) return undefined;

  // ── 1. まだ検めていない WACZ を検める ─────────────────────────────────
  let failed = 0;
  for (const archive of await uninspectedArchives(db, crawlId)) {
    try {
      await inspectOne(archive);
    } catch (err) {
      // 1 本の失敗で残りを止めない。`inspected_at` は立っていないので、次の合本が拾い直す
      failed += 1;
      log.warn({ err, crawlId, archiveId: archive.id }, "could not inspect this archive");
    }
  }

  // ── 2. 版を払い出し、検めたアーカイブと頁の行を読む (1 つのトランザクション) ──────
  const { rev, archives, pages } = await db.transaction().execute(async (trx) => {
    const issued = await trx
      .updateTable("crawls")
      .set((eb) => ({ replayBundleNextRev: eb("replayBundleNextRev", "+", 1) }))
      .where("id", "=", crawlId)
      .returning((eb) => eb("replayBundleNextRev", "-", 1).as("rev"))
      .executeTakeFirstOrThrow();
    const archives = await trx
      .selectFrom("archives as a")
      // 深さは、その取り込みを報告した頁の行から。`crawl_pages.task_id` は text なので uuid 側を倒す
      .leftJoin("crawlPages as p", (join) =>
        join
          .onRef("p.crawlId", "=", "a.crawlId")
          .onRef("p.taskId", "=", sql<string>`${sql.ref("a.taskId")}::text`),
      )
      .select(["a.id", "a.objectKey", "a.waczSha256", "a.indexEmpty", "a.capturedAt", "p.depth"])
      .where("a.crawlId", "=", crawlId)
      .where("a.inspectedAt", "is not", null)
      // 1 つの取り込みの頁の行は 1 つのはずだが、増えれば合本の WACZ が重なる。浅いほうを採る
      .distinctOn("a.id")
      .orderBy("a.id")
      .orderBy("p.depth")
      // 検めた行は sha256 と index_empty を必ず持つ (`027` の CHECK)
      .$narrowType<{ waczSha256: string; indexEmpty: boolean }>()
      .execute();
    const pages = await trx
      .selectFrom("archivePages as ap")
      .innerJoin("archives as a", "a.id", "ap.archiveId")
      .select([
        "ap.archiveId",
        "ap.ordinal",
        "ap.pageId",
        "ap.url",
        "ap.ts",
        "ap.title",
        "ap.stage",
        "ap.keys",
      ])
      .where("a.crawlId", "=", crawlId)
      .execute();
    return { rev: issued.rev, archives, pages };
  });

  const builtAt = now();
  const bundle = composeReplayBundle({
    crawlId,
    orgId: crawl.orgId,
    rev,
    depth,
    builtAt,
    archives,
    pages,
  });
  const totalPages = bundle.replayJson.totalPages;
  const counts = { members: bundle.members.length, skipped: bundle.skipped, failed };

  // 入れる WACZ が無ければ書かない (空の合本を指すと、開いても何も無い)。払い出した版は欠番になる
  if (bundle.members.length === 0) {
    log.info({ crawlId, rev, ...counts }, "nothing to bundle yet");
    return { rev: null, pages: 0, ...counts, error: null };
  }

  // ── 3. 保管庫に書く。pages.json が先 (replay.json は pagesQueryUrl でそれを指す) ──────────
  try {
    await putObject(
      s3,
      bucket,
      bundle.pagesKey,
      Buffer.from(JSON.stringify(bundle.pagesJson)),
      "application/json",
    );
    await putObject(
      s3,
      bucket,
      bundle.replayKey,
      Buffer.from(JSON.stringify(bundle.replayJson)),
      "application/json",
    );
  } catch (err) {
    const error = `could not write r${String(rev)} to the store: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ err, crawlId, rev, key: bundle.replayKey }, "could not write the replay bundle");
    await db
      .updateTable("crawls")
      .set({ replayBundleError: error })
      .where("id", "=", crawlId)
      .where((eb) => eb.or([eb("replayBundleRev", "is", null), eb("replayBundleRev", "<", rev)]))
      .execute();
    return { rev, pages: totalPages, ...counts, error };
  }

  // ── 4. 台帳が指す版を前へだけ進め、初めて入ったアーカイブに版を書く ─────────────────
  await db.transaction().execute(async (trx) => {
    // 最初に入った版を残す: 遅れて書き終えた小さい版が、先に書いた大きい版を下げる (逆には上げない)
    await trx
      .updateTable("archives")
      .set({ replayBundleRev: rev })
      .where("id", "in", bundle.members)
      .where((eb) => eb.or([eb("replayBundleRev", "is", null), eb("replayBundleRev", ">", rev)]))
      .execute();
    await trx
      .updateTable("crawls")
      .set({
        replayBundleRev: rev,
        replayBundleKey: bundle.replayKey,
        replayBundlePages: totalPages,
        replayBundleBuiltAt: builtAt.toISOString(),
        replayBundleError: null,
      })
      .where("id", "=", crawlId)
      // 前へだけ: 台帳の指す版が無いか、この版より小さいときだけ差し替える
      .where((eb) => eb.or([eb("replayBundleRev", "is", null), eb("replayBundleRev", "<", rev)]))
      .execute();
  });

  log.info({ crawlId, rev, pages: totalPages, ...counts }, "replay bundle written");
  return { rev, pages: totalPages, ...counts, error: null };
};
