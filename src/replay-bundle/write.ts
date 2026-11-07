/**
 * クロール 1 本の合本を、新しい版として保管庫に書く。口 (`POST /api/crawls/:id/replay-bundle`)・`/failed` で締めた後
 * (`api/crawls.ts`)・作り直しの道具 (`pnpm run replay-bundle:rebuild`) が同じこれを呼ぶ。形を決めるのは
 * `replay-bundle/format.ts` で、ここは配管。
 *
 * 1. まだ検めていない WACZ を検める (`replay-bundle/inspect.ts`)。1 本の失敗で止めない (`failed` に数える)
 * 2. **1 つのトランザクションで**、版を払い出し (`crawls.replay_bundle_next_rev` を行の更新で 1 つ進める。
 *    同じ UPDATE の returning でクロールの状態も取る)、クロールのアーカイブとその頁の行を読む
 * 3. 組む。終わったクロールで、未検めのアーカイブが 0 本なら、`replay.json` のバイト列の sha256 に署名を貰い、
 *    自分で検める (`replay-bundle/sign.ts`)。**トランザクションの外で** —— TSA を待つ間、クロールの行の鍵を持たない
 * 4. `pages.json`・(署名したなら) `replay-digest.json`・`replay.json` の順に保管庫へ書く (`application/json`)
 * 5. **1 つのトランザクションで**、台帳が指す版と署名した版を、それぞれ **前へだけ** 進め、その版で初めて入った
 *    アーカイブに版を書く
 *
 * ## 版の払い出しと読みを 1 つのトランザクションに置く理由
 *
 * 払い出しの UPDATE はクロールの行に鍵を掛け、commit まで持つ。2 本が同時に来ても、後の版の読みは前の版の読みより
 * 後になる —— **大きい版ほど、入っているアーカイブが多いか同じ**。これが崩れると、台帳が指す (いちばん大きい) 版に、
 * 小さい版にはあった WACZ が無い、が起こりうる。capture-workbench は「頁の WACZ が入った最初の版 (`archives.replay_bundle_rev`)
 * ≤ 台帳の指す版」で頁を合本の中で開くので、それが嘘になる。保管庫に書くのは鍵を放した後。
 *
 * **クロールの状態も、同じ行の鍵の下で取る** (払い出しの returning)。合本に書く `crawlState` は、その版の中身を
 * 読んだ時のクロールの状態 —— 先に読んで後で払い出すと、間に締められた版が「走行中」と書かれるか、その逆になる。
 *
 * ## いつ署名するか
 *
 * 次の 3 つが揃ったときだけ:
 *
 * - 署名の設定が在る (`config/signer.ts`。無ければ署名しない配備)
 * - クロールが終わっている (`succeeded`・`failed`)。走っている版は、まだ顔ぶれが増える
 * - **未検めのアーカイブが 0 本**。検められなかった WACZ は合本に入らないので、署名が「このクロールの WACZ は
 *   これで全部」と言ってしまう。数えるのはアーカイブを読んだのと**同じ問い合わせ** —— 別の問い合わせで数えると、
 *   間に別の合本が検め終えた WACZ を、読みにも数えにも入れない形がありうる (Postgres の READ COMMITTED は文ごとに
 *   新しい snapshot を取る)
 *
 * 揃ったのに署名が付かなければ (wacz-signer が答えない・返ってきた署名が検めを通らない・未検めが残る)、合本は
 * 署名なしで書き、理由を `crawls.replay_bundle_sign_error` に残す。replay は開ける。新しい版を書けば署名し直せる
 * (作り直しの道具)。前の置き場に digest を足すことはしない —— 版ごとの置き場は書いたら変えない。
 *
 * ## 書く順
 *
 * `pages.json` → `replay-digest.json` → `replay.json`。入口 (replay が開く物・台帳が指す物) の `replay.json` が
 * 現れた時点で、それが指す `pages.json` も、それを覆う digest も、もう在る。
 *
 * ## 前へだけ
 *
 * 段 N+1 の報告は段 N の合本より先に来うる (次の段は段の報告の中で出る)。遅れて書き終えた古い版が、新しい版を
 * 指していた台帳を戻さないように、指す版は「書き終えた版がいまより大きいときだけ」差し替える。署名した版も同じ。
 * 版ごとの置き場は書いたら変えない (払い出した版は 1 度しか書かれない)。
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
import { composeReplayBundle, replayDigestBytes, sha256Of } from "./format.js";
import { inspectArchive, uninspectedArchives, type UninspectedArchive } from "./inspect.js";
import type { ReplayBundleSigner } from "./sign.js";
import type { SignedData } from "./verify-signed-data.js";

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
  /** 署名して `replay-digest.json` を書いたか。 */
  signed: boolean;
  /**
   * 終わったクロールの合本に署名しなかった (できなかった) 理由。署名した・走っているクロール・署名の設定が無い・
   * 書けなかったときは null。
   */
  signError: string | null;
  /** 書いた `replay-digest.json` の鍵。署名しなかったら null。 */
  digestKey: string | null;
}

export interface WriteReplayBundleOptions {
  db: Kysely<Database>;
  s3: S3Client;
  /** 合本を書き、`.result.json` を読む bucket (設定の物。WACZ と同じ bucket)。 */
  bucket: string;
  now?: () => Date;
  /** 差し替え口。既定は `inspectArchive`。試験は zip を作らずに数え方を見る。 */
  inspectOne?: (archive: UninspectedArchive) => Promise<void>;
  /** 署名の窓口 (`replay-bundle/sign.ts`)。無ければ署名しない (設定の無い配備)。 */
  signer?: ReplayBundleSigner;
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

/** 署名を頼むか、頼まないなら理由 (null は「署名する時でない」)。 */
const signingPlan = (
  signer: ReplayBundleSigner | undefined,
  state: string,
  uninspected: number,
  rev: number,
): { sign: true } | { sign: false; reason: string | null } => {
  if (signer === undefined || state === "running") return { sign: false, reason: null };
  if (uninspected > 0) {
    return {
      sign: false,
      reason:
        `not signed: ${String(uninspected)} archive(s) of the crawl are not inspected yet, so ` +
        `r${String(rev)} may not hold every WACZ of it (rebuild once they can be read)`,
    };
  }
  return { sign: true };
};

/**
 * 書く。クロールが無ければ `undefined`。DB に届かないときだけ投げる (保管庫・署名の失敗は答えの中で返す)。
 *
 * @param depth flow の段の深さ。`replay.json` の `replayBundle.depth` に記録するだけ (作り直し・締めた後は null)。
 */
export const writeReplayBundle = async (
  crawlId: string,
  depth: number | null,
  options: WriteReplayBundleOptions,
): Promise<ReplayBundleResult | undefined> => {
  const { db, s3, bucket, signer } = options;
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

  // ── 2. 版を払い出し (クロールの状態も)、アーカイブと頁の行を読む (1 つのトランザクション) ──────
  const { issued, rows, pages } = await db.transaction().execute(async (trx) => {
    const issued = await trx
      .updateTable("crawls")
      .set((eb) => ({ replayBundleNextRev: eb("replayBundleNextRev", "+", 1) }))
      .where("id", "=", crawlId)
      .returning((eb) => [
        eb("replayBundleNextRev", "-", 1).as("rev"),
        "state",
        "stopReason",
        "finishedAt",
      ])
      .executeTakeFirstOrThrow();
    // **検めていない物も読む** —— 同じ問い合わせで未検めを数える (上の「いつ署名するか」)
    const rows = await trx
      .selectFrom("archives as a")
      // 深さは、その取り込みを報告した頁の行から。`crawl_pages.task_id` は text なので uuid 側を倒す
      .leftJoin("crawlPages as p", (join) =>
        join
          .onRef("p.crawlId", "=", "a.crawlId")
          .onRef("p.taskId", "=", sql<string>`${sql.ref("a.taskId")}::text`),
      )
      .select([
        "a.id",
        "a.objectKey",
        "a.waczSha256",
        "a.indexEmpty",
        "a.capturedAt",
        "a.inspectedAt",
        "p.depth",
      ])
      .where("a.crawlId", "=", crawlId)
      // 1 つの取り込みの頁の行は 1 つのはずだが、増えれば合本の WACZ が重なる。浅いほうを採る
      .distinctOn("a.id")
      .orderBy("a.id")
      .orderBy("p.depth")
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
    return { issued, rows, pages };
  });
  const { rev } = issued;

  // 検めた行は sha256 と index_empty を必ず持つ (`027` の CHECK)。持たない行は検めていない物に数える
  const archives = rows.flatMap((row) =>
    row.inspectedAt !== null && row.waczSha256 !== null && row.indexEmpty !== null
      ? [{ ...row, waczSha256: row.waczSha256, indexEmpty: row.indexEmpty }]
      : [],
  );
  const uninspected = rows.length - archives.length;

  const builtAt = now();
  const bundle = composeReplayBundle({
    crawlId,
    orgId: crawl.orgId,
    rev,
    depth,
    builtAt,
    crawlState: issued.state,
    stopReason: issued.stopReason,
    finishedAt: issued.finishedAt,
    archives,
    pages,
  });
  const totalPages = bundle.replayJson.totalPages;
  const counts = { members: bundle.members.length, skipped: bundle.skipped, failed };
  const unsigned = { signed: false, signError: null, digestKey: null };

  // 入れる WACZ が無ければ書かない (空の合本を指すと、開いても何も無い)。払い出した版は欠番になる
  if (bundle.members.length === 0) {
    log.info({ crawlId, rev, ...counts }, "nothing to bundle yet");
    return { rev: null, pages: 0, ...counts, error: null, ...unsigned };
  }

  // ── 3. 署名を貰い、自分で検める (トランザクションの外) ───────────────────────
  const plan = signingPlan(signer, issued.state, uninspected, rev);
  let signature: { hash: string; signedData: SignedData } | undefined;
  let signError = plan.sign ? null : plan.reason;
  if (plan.sign && signer !== undefined) {
    // 署名する hash は、保管庫に置くのと同じ Buffer から計る
    const hash = sha256Of(bundle.replayBytes);
    const outcome = await signer.sign(hash);
    if (outcome.signed) signature = { hash, signedData: outcome.signedData };
    else signError = outcome.reason;
  }
  if (signError !== null) {
    log.warn({ crawlId, rev, signError }, "the replay bundle of a finished crawl is not signed");
  }

  // ── 4. 保管庫に書く。pages.json → replay-digest.json → replay.json ──────────────
  try {
    await putObject(s3, bucket, bundle.pagesKey, bundle.pagesBytes, "application/json");
    if (signature !== undefined) {
      await putObject(
        s3,
        bucket,
        bundle.digestKey,
        replayDigestBytes(signature.hash, signature.signedData),
        "application/json",
      );
    }
    await putObject(s3, bucket, bundle.replayKey, bundle.replayBytes, "application/json");
  } catch (err) {
    const error = `could not write r${String(rev)} to the store: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ err, crawlId, rev, key: bundle.replayKey }, "could not write the replay bundle");
    await db
      .updateTable("crawls")
      .set({ replayBundleError: error })
      .where("id", "=", crawlId)
      .where((eb) => eb.or([eb("replayBundleRev", "is", null), eb("replayBundleRev", "<", rev)]))
      .execute();
    // 置き場に replay.json が無いので、署名も無いのと同じ (digest だけが残りうるが、誰も指さない)
    return { rev, pages: totalPages, ...counts, error, ...unsigned };
  }

  // ── 5. 指す版と署名した版を前へだけ進め、初めて入ったアーカイブに版を書く ─────────────────
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
        // 指す版の署名の理由。指す版と一緒にだけ動くので、いつも指す版のことを言う
        replayBundleSignError: signError,
      })
      .where("id", "=", crawlId)
      // 前へだけ: 台帳の指す版が無いか、この版より小さいときだけ差し替える
      .where((eb) => eb.or([eb("replayBundleRev", "is", null), eb("replayBundleRev", "<", rev)]))
      .execute();
    if (signature !== undefined) {
      await trx
        .updateTable("crawls")
        .set({ replayBundleSignedRev: rev, replayBundleDigestKey: bundle.digestKey })
        .where("id", "=", crawlId)
        // 前へだけ: 署名した版が無いか、この版より小さいときだけ。指す版とは別に動く
        .where((eb) =>
          eb.or([eb("replayBundleSignedRev", "is", null), eb("replayBundleSignedRev", "<", rev)]),
        )
        .execute();
    }
  });

  const signed = signature !== undefined;
  log.info({ crawlId, rev, pages: totalPages, ...counts, signed }, "replay bundle written");
  return {
    rev,
    pages: totalPages,
    ...counts,
    error: null,
    signed,
    signError,
    digestKey: signed ? bundle.digestKey : null,
  };
};
