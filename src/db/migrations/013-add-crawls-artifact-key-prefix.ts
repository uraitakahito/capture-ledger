/**
 * 013-add-crawls-artifact-key-prefix
 *
 * そのクロールの成果物を**どこへ置いたか**。鍵の接頭辞そのものを 1 本の列に残す。
 *
 * ## なぜ導けないのか —— `org_id` が既に在るのに
 *
 * `org/<orgId>/` を再現するだけなら列は要らない。要るのは、**接頭辞が
 * 「そのクロールがどこへ置いたか」であって「いまのサーバがどこへ置くか」ではない**
 * から。
 *
 * いままで探す側 (`api/crawls.ts` → `crawl/admit-level.ts`) は、いまのサーバ設定に
 * 受け取り先が在るかで接頭辞を決めていた:
 *
 *   ...(sink && { keyPrefix: sinkObjectKey(crawl.orgId, "") })
 *
 * クロールは段を重ねるので数十分に達しうる。その途中で受け取り先を切り替えれば、前半の
 * 成果物と探し先がずれる。ずれると `archive/manifest.ts` が書いているとおり
 * **manifest が見つからず、台帳に 1 行も入らないまま静かに終わる**。
 * いまその穴を塞いでいるのは reconcile の全走査で、**絞り込みを入れると外れる**。
 *
 * ## そして接頭辞に月が入る
 *
 * 導けないもう 1 つの理由。`org/<orgId>/<YYYY-MM>/` の月は、置いた側と探す側が
 * 別々に「いま」から計算すると、深夜をまたぐクロールでずれる。**計算を 2 度しない。**
 * 置いた瞬間の答えをここに書き、以後は両側がこの 1 か所を読む。
 *
 * ## NULL の意味は 1 つだけ
 *
 * **「記録が無い」。「平らな名前空間」ではない。**
 *
 * 読む側は NULL のとき従来どおり設定から導くので、この migration を当てても既存の
 * 行の振る舞いは 1 ミリも変わらない。backfill もしない —— 過去のクロールが受け取り先を
 * 通ったかどうかは DB から言えず、それ自体がこの列で埋める穴だから。**分からない
 * ことを、分かっているふりで埋めない。**
 *
 * ## index を張らない理由
 *
 * `009` は部分 index を張ったが、ここは張らない。この列で引くのは reconcile が
 * 「直近 N 日のクロールが使った接頭辞」を集めるときだけで、その絞り込みは
 * `crawls_started_at_idx` (`007`) が既に効かせている。**先に無い負荷のために
 * index を置くと、掃除する仕事が増えるだけ。**
 */
import type { Kysely } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").addColumn("artifact_key_prefix", "text").execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable("crawls").dropColumn("artifact_key_prefix").execute();
};
