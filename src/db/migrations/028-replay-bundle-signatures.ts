/**
 * 028-replay-bundle-signatures
 *
 * **合本の署名** (CAPTURE-61)。終わったクロールの合本は、`replay.json` の sha256 に wacz-signer の署名を貰い、
 * 同じ置き場に `replay-digest.json` (`{path, hash, signedData}`) を書く (`replay-bundle/write.ts`)。署名 1 つで、
 * このクロールにどの WACZ がどの中身で属すか・クロールがどの状態で終わったかを、第三者が確かめられる。
 *
 * ## crawls: 署名した版と、署名しなかった理由
 *
 * - `replay_bundle_signed_rev`・`replay_bundle_digest_key` —— 署名した版のうち最も大きい物と、その
 *   `replay-digest.json` の鍵。**capture-ledger が指す版 (`replay_bundle_rev`) とは別に持つ** —— 署名に失敗した版を後から
 *   書いても、前に署名した版は署名されたまま在る。**前へだけ進める** (指す版と同じ理由: 遅れて書き終えた小さい
 *   版が戻さない)。2 つは一緒に書くので、両方 NULL か両方に値 (CHECK)。
 * - `replay_bundle_sign_error` —— capture-ledger が指す版に署名しなかった (できなかった) 理由。指す版と同じ UPDATE で書くので、
 *   いつも指す版のことを言う。走っているクロールの版と、署名の設定が無い配備では NULL (署名する時でない)。
 *   wacz-signer が答えない・TSA に届かない・返ってきた署名が検めを通らない・まだ検めていない WACZ が残っている、
 *   のどれか。
 *
 * ## 移行は書かない
 *
 * 既存の行は空のまま。終わったクロールの合本に署名したければ `pnpm run replay-bundle:rebuild --crawl <id>` が
 * 新しい版を書いて署名する (前の置き場に digest を足すことはしない —— 版ごとの置き場は書いたら変えない)。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable("crawls")
    // #region crawls-replay-bundle-signature-columns
    .addColumn("replay_bundle_signed_rev", "integer")
    .addColumn("replay_bundle_digest_key", "text")
    .addColumn("replay_bundle_sign_error", "text")
    // #endregion crawls-replay-bundle-signature-columns
    .execute();
  // 署名した版と、その digest の鍵は一緒に書く
  await sql`
    ALTER TABLE crawls ADD CONSTRAINT crawls_replay_bundle_signed_check CHECK (
      (replay_bundle_signed_rev IS NULL) = (replay_bundle_digest_key IS NULL)
    )
  `.execute(db);
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  // CHECK は列と一緒に消える
  await db.schema
    .alterTable("crawls")
    .dropColumn("replay_bundle_sign_error")
    .dropColumn("replay_bundle_digest_key")
    .dropColumn("replay_bundle_signed_rev")
    .execute();
};
