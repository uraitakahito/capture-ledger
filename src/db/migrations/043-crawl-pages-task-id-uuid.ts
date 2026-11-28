/**
 * 043-crawl-pages-task-id-uuid
 *
 * `crawl_pages.task_id` を text から uuid に揃え、索引を足す (CAPTURE-474)。
 *
 * ## なぜ
 *
 * BrowserHive の task id は、`capture_submissions.task_id` (`004`) と `archives.task_id` (`002`) では uuid、
 * `crawl_pages.task_id` (`008`) だけ text だった。繋ぐたびに uuid の側を `::text` に倒していたので、
 * 主キーと `archives_task_id_idx` が効かず、ページ 1 つを開くたびに表をまるごと読んでいた。逆向き
 * (`capture_submissions` から `crawl_pages` を引く reconcile) は `crawl_pages.task_id` に索引が無く、
 * 1 行ごとに表を頭から探していた。100 万行で、ページ 1 つ 122 ms・reconcile の全件が約 25 分の見込み。
 *
 * `004`・`008`・`027` の注記にある「uuid を text に倒して繋ぐ」は、この migration より前の話。
 * その注記は書き換えない —— 書いた時の話として残す。Kysely は file の中身を照らさないので、書き換えても migrate は
 * 止まらない (`corrupted migrations` で止まるのは、走った file を消した時と、順が変わった時)。
 *
 * ## 空の文字列は NULL に
 *
 * 段の報告は `taskId: ""` を受けていた (帰属は「taskId 無し」として飛ばしていた)。NULL は同じ扱いを
 * 型で言い直したもの。読み手はみな NULL を「取り込みの答えが無い」と読む。down では `''` に戻らない。
 *
 * ## ほかの uuid でない値が在れば止まる
 *
 * 黙って NULL にすると、何の取り込みだったかの手がかりが消える。数と先頭の行の id を出して投げ、
 * 何も変えない (Kysely は Postgres では migrate の 1 回をまるごと transaction の中で流す)。
 *
 * `pg_input_is_valid` を使うので、Postgres 16 以上が要る (dev の compose と CI は 17)。
 *
 * ## 鍵
 *
 * 先に ACCESS EXCLUSIVE を取ってから数える。数えた後に古いコードが uuid でない値を書く隙を作らない
 * (どうせ型の書き換えで同じ鍵を取るので、止まる時間は変わらない)。長く走る問い合わせが表を
 * 読んでいたら、5 秒で諦めて落ちる —— 後ろに読み書きを並ばせ続けない。落ちても何も変わらないので、
 * 待って打ち直す。
 *
 * 型を変えると表を書き直し、索引をすべて作り直す。その間は `crawl_pages` の読み書きがみな止まる
 * (本物と同じ列と索引で 100 万行のとき約 2.4 秒)。
 *
 * ## コードと同じ時に入れ替える
 *
 * この migration の前のコードは `uuid::text = text`、後のコードは `uuid = uuid` で繋ぐ。どちらも、
 * もう一方の型に当たると `operator does not exist` で落ちる。migrate とコードの入れ替えは一緒に、
 * 戻すときも down とコードの revert を一緒に。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

const lockCrawlPages = async (db: Kysely<unknown>): Promise<void> => {
  await sql`set local lock_timeout = '5s'`.execute(db);
  await sql`lock table crawl_pages in access exclusive mode`.execute(db);
};

/**
 * 鍵の待ちを既定に戻す。Kysely はまだ流していない migration をまとめて 1 つの transaction で流すので、
 * `set local` は後に続く migration にも効いてしまう —— 鍵を頼んでいない後の migration が 5 秒で落ち、
 * 043 ごと戻らないように、鍵を取り終えたら戻す (鍵は transaction の終わりまで持ったまま)。
 */
const resetLockTimeout = async (db: Kysely<unknown>): Promise<void> => {
  await sql`set local lock_timeout to default`.execute(db);
};

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await lockCrawlPages(db);
  await resetLockTimeout(db);

  const { rows } = await sql<{ bad: string; ids: string[] | null }>`
    select count(*)::text as bad,
           (array_agg(id order by id))[1:5]::text[] as ids
      from crawl_pages
     where task_id <> '' and not pg_input_is_valid(task_id, 'uuid')`.execute(db);
  const bad = Number(rows[0]?.bad ?? "0");
  if (bad > 0) {
    throw new Error(
      `crawl_pages has ${String(bad)} task_id value(s) that are not uuids ` +
        `(first ids: ${(rows[0]?.ids ?? []).join(", ")}). Nothing was changed. ` +
        `Decide what to do with these rows before migrating.`,
    );
  }

  await sql`alter table crawl_pages alter column task_id type uuid using nullif(task_id, '')::uuid`.execute(
    db,
  );
  await db.schema
    .createIndex("crawl_pages_task_id_idx")
    .on("crawl_pages")
    .column("task_id")
    .execute();
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await lockCrawlPages(db);
  await resetLockTimeout(db);
  await db.schema.dropIndex("crawl_pages_task_id_idx").execute();
  await sql`alter table crawl_pages alter column task_id type text using task_id::text`.execute(db);
};
