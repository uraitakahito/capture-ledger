/**
 * 027-replay-bundles
 *
 * **合本** (クロールの WACZ を全部並べた `replay.json` と、その頁の行を全部並べた `pages.json` の組) を、段ごとに
 * 保管庫へ書くための列と表。replay はそれを 1 つのアーカイブとして開き、どの WACZ の頁へもリンクで行ける。
 * 書くのは `POST /api/crawls/:id/replay-bundle` (`api/replay-bundle.ts`) と `pnpm run replay-bundle:rebuild`。
 *
 * ## archives: どのクロールの取り込みか・検めた結果
 *
 * - `crawl_id` —— 取り込みを受けたときに入れる (`archive/admit.ts`)。いままでは `crawl_pages.task_id` との
 *   文字列の突き合わせ (uuid を text に倒す) でしか繋がらず、`archives_task_id_idx` も効かなかった。
 *   **在り処と来歴の列で、持ち主の列ではない** (`002`)。クロールの行が消えても証拠の行は残すので
 *   `ON DELETE SET NULL` (クロールを消すエンドポイントはいまは無い)。
 * - `wacz_sha256`・`wacz_bytes`・`index_empty`・`inspected_at` —— WACZ を 1 度読んで数えた物。sha256 は合本の
 *   `resources[].hash` に載せる。`index_empty` は `indexes/index.cdxj` が空 (または無い)、あるいは BrowserHive の答えの
 *   `waczStats.totalRecorded` が 0 —— **記録が 0 の WACZ** で、合本から外す (replay は長さ 0 の Range を求め、保管庫の
 *   416 で JSON を読み直し続ける)。`inspected_at` が NULL の行が「まだ検めていない」。
 * - `replay_bundle_rev` —— その WACZ が最初に入った合本の版。頁が、capture-ledger の指す合本に入っているかを言うため
 *   (`版 ≤ crawls.replay_bundle_rev`)。
 *
 * 検めた行は 3 つの値を必ず持つ (CHECK)。検めるのは 1 つの UPDATE で 4 つを一緒に書く (`replay-bundle/inspect.ts`)。
 *
 * ## archive_pages: WACZ の頁の行
 *
 * `pages/pages.jsonl` の 1 行 (先頭の `{"format":…}` の行は除く) が 1 行。合本の `pages.json` はここから組む ——
 * 段ごとに全部の WACZ を読み直さないため。`id`・`url`・`ts`・`title`・`stage` は行のまま (無ければ NULL)。
 * `keys` は文書の行 (`stage` の無い行) だけが持ち、頼んだ URL と BrowserHive の答えの `document.url`
 * (リダイレクトの後) を正規化した物 (`crawl/scope.ts` の `parseHttpUrl` と同じ)。写しの行は空。
 *
 * **主キーは (archive_id, ordinal)。** `ordinal` は pages.jsonl の中の何番目の頁の行か (0 から)。行の `id` は
 * BrowserHive が WACZ の中で一意に振るが、契約の外の WACZ では欠けうるので、鍵にしない —— 一意の制約にすると、
 * 重複した 1 本のために検めが落ち続ける。WACZ は書き換わらないので、何番目かは変わらない。
 *
 * `ts` を text で持つのは、行のまま写すため (合本の約束)。timestamptz に通すと `…57Z` が `…57.000Z` に変わる。
 *
 * ## crawls: 版の払い出しと、capture-ledger が指す版
 *
 * - `replay_bundle_next_rev` —— 次に払い出す版 (1 から)。合本を作るたびに行の更新で原子的に払い出す。
 * - `replay_bundle_rev`・`_key`・`_pages`・`_built_at` —— capture-ledger が指す合本 (書き終えた版のうち最も大きい物)。
 *   **前へだけ進める**: 書き終えた版がいまより大きいときだけ差し替える。段 N+1 の報告は段 N の合本より先に来うる
 *   ので、遅れて書き終えた古い版が新しい版を戻さないように。`_key` は `replay.json` の鍵
 *   (`org/<orgId>/crawls/<crawlId>/r<版>/replay.json`)。
 * - `replay_bundle_error` —— 書けなかった理由。**合本の失敗ではクロールを止めない** (合本は撮った物から作る派生物で、
 *   失敗でクロールを failed にすると、次の段が既に出ているときに状態が食い違う)。次に書けたら消す。
 *
 * ## 移行は書かない
 *
 * 既存の行は空のまま (版の払い出しの番号だけは既定の 1)。027 より前のクロールの合本が要るなら
 * `pnpm run replay-bundle:rebuild --crawl <id>` が、そのクロールのアーカイブに `crawl_id` を入れてから書く。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("archives")
    // #region archives-replay-bundle-columns
    .addColumn("crawl_id", "uuid", (col) => col.references("crawls.id").onDelete("set null"))
    .addColumn("wacz_sha256", "text")
    .addColumn("wacz_bytes", "bigint")
    .addColumn("index_empty", "boolean")
    .addColumn("inspected_at", "timestamptz")
    .addColumn("replay_bundle_rev", "integer")
    // #endregion archives-replay-bundle-columns
    .execute();
  // 検めた行は 3 つの値を必ず持つ。合本を組む問い合わせは、検めた行の sha256 が在ると読む
  await sql`
    ALTER TABLE archives ADD CONSTRAINT archives_inspected_check CHECK (
      inspected_at IS NULL
      OR (wacz_sha256 IS NOT NULL AND wacz_bytes IS NOT NULL AND index_empty IS NOT NULL)
    )
  `.execute(db);
  // 合本はクロールのアーカイブを全部引く (まだ検めていない物と、検めた物)
  await db.schema.createIndex("archives_crawl_id_idx").on("archives").column("crawl_id").execute();

  await db.schema
    .createTable("archive_pages")
    // #region archive-pages-columns
    .addColumn("archive_id", "uuid", (col) =>
      col.notNull().references("archives.id").onDelete("cascade"),
    )
    // pages.jsonl の中の何番目の頁の行か (0 から。先頭の format の行は数えない)
    .addColumn("ordinal", "integer", (col) => col.notNull())
    // 行の `id`。BrowserHive は文書の行に taskId、写しの行に `<taskId>-<stage>` を振る
    .addColumn("page_id", "text")
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("ts", "text")
    .addColumn("title", "text")
    // 写しの時点 (`after-load`・`after-behaviors`)。文書の行は NULL
    .addColumn("stage", "text")
    // 正規化した URL。文書の行だけが持つ (写しの行は空)
    .addColumn("keys", sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    // #endregion archive-pages-columns
    .addPrimaryKeyConstraint("archive_pages_pkey", ["archive_id", "ordinal"])
    .execute();

  await db.schema
    .alterTable("crawls")
    // #region crawls-replay-bundle-columns
    .addColumn("replay_bundle_next_rev", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("replay_bundle_rev", "integer")
    .addColumn("replay_bundle_key", "text")
    .addColumn("replay_bundle_pages", "integer")
    .addColumn("replay_bundle_built_at", "timestamptz")
    .addColumn("replay_bundle_error", "text")
    // #endregion crawls-replay-bundle-columns
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    .dropColumn("replay_bundle_error")
    .dropColumn("replay_bundle_built_at")
    .dropColumn("replay_bundle_pages")
    .dropColumn("replay_bundle_key")
    .dropColumn("replay_bundle_rev")
    .dropColumn("replay_bundle_next_rev")
    .execute();
  await db.schema.dropTable("archive_pages").execute();
  // 索引・外部キー・CHECK は列と一緒に消える
  await db.schema
    .alterTable("archives")
    .dropColumn("replay_bundle_rev")
    .dropColumn("inspected_at")
    .dropColumn("index_empty")
    .dropColumn("wacz_bytes")
    .dropColumn("wacz_sha256")
    .dropColumn("crawl_id")
    .execute();
};
