/**
 * robots.txt の例外の表 (`046`・t-6bc6) を読み書きする。エンドポイント (`api/robots-exemptions.ts`) は直に SQL を
 * 書かず、ここを呼ぶ。SQL の形は `test/robots-exemptions-store.test.ts` が記録する DB で照らし、Postgres で本当に
 * 通るか・同時の登録が 1 本だけ通るかは `src/tools/robots-exemptions-smoke.ts` が CI で見る。
 *
 * ## 「効いている行」
 *
 * 取り消していなくて (`revoked_at` が無い)、期限の前 (`expires_at > now`) の行。時刻は呼ぶ側が渡す ——
 * 期限の検査 (`exemptions/validate.ts`) と同じ時計で見るため。
 *
 * ## 登録の錠は、行ではなく組織とホストの組に掛ける
 *
 * 守る不変条件は 2 つ: 同じ組織・ホスト・path の型で効いている行は 1 つまで、同じ組織・ホストで効いている行の
 * 名乗りは 1 つ。どちらも「効いている」が時刻で変わるので、一意の索引では書けず、登録が「見てから足す」になる。
 *
 * 見る行を `FOR UPDATE` で掴む形だと、**行が 1 つも無い時に何も掴めない** —— 初めての登録が 2 本同時に来ると、
 * どちらも「重なりは無い」と見て両方が足す。だから行に頼らず、トランザクションの間だけの advisory lock
 * (`pg_advisory_xact_lock`) を組織とホストの hash の組で取る。同じ組の登録は 1 本ずつ進み、後の 1 本は前の 1 本が
 * 足した行を見る。錠は commit か rollback で勝手に外れる。hash がぶつかった別の組は、余計に待つだけで誤らない。
 * 行のロックは重ねない (advisory lock だけで登録どうしは並ばず、取り消しは効いている行を減らすだけなので、
 * 登録と並んでも不変条件を壊さない)。
 *
 * **READ COMMITTED に頼る。** 錠を取った後の SELECT が、前の持ち主の commit した行を見るのは、文ごとに snapshot を
 * 取る READ COMMITTED (Postgres と Kysely の既定) だから。REPEATABLE READ 以上にすると、snapshot は最初の文
 * (錠の select) で取られ、待つ間に commit された行が見えず、2 本とも通る。`db.transaction()` に分離の度合いを
 * 足さないこと (smoke の「同時の登録は 1 本だけ」が見張る)。
 */
import { sql, type ExpressionBuilder, type Kysely, type Selectable } from "kysely";

import type {
  Database,
  RobotsExemptionAppliesTo,
  RobotsExemptionScope,
  RobotsExemptionsTable,
} from "../db/database.js";

export type ExemptionRow = Selectable<RobotsExemptionsTable>;

/** 枚数の上限 (`daily_limit`) を測る幅。 */
export const DAY_MS = 24 * 60 * 60_000;

export type ExemptionState = "active" | "expired" | "revoked";

/** 行の今の状態。取り消しが期限切れより先 (取り消した行は、期限が過ぎても「取り消した」)。 */
export const exemptionState = (
  row: Pick<ExemptionRow, "expiresAt" | "revokedAt">,
  now: Date,
): ExemptionState => {
  if (row.revokedAt !== null) return "revoked";
  return row.expiresAt.getTime() > now.getTime() ? "active" : "expired";
};

/** 登録する行。字は検査を通った後の物 (`checkExemption`)。 */
export interface NewExemption {
  orgId: string;
  host: string;
  pathPattern: string;
  scope: RobotsExemptionScope;
  appliesTo: RobotsExemptionAppliesTo;
  userAgent: string;
  reason: string;
  dailyLimit: number;
  linkLimit: number;
  expiresAt: Date;
  createdBy: string;
  /** 登録した時の読める名前。分からなければ無い。 */
  createdByName?: string;
}

export type CreateExemptionResult =
  | { kind: "created"; row: ExemptionRow }
  /** 同じ組織・ホスト・path の型で、効いている行がもう在る。`id` はその行。 */
  | { kind: "overlap"; id: string }
  /** 同じ組織・ホストで効いている行が、別の名乗りを持つ。`userAgent` はその名乗り。 */
  | { kind: "user-agent-mismatch"; userAgent: string };

/** 取り消した主体。 */
export interface Revoker {
  subject: string;
  name?: string;
}

export type RevokeExemptionResult =
  | { kind: "revoked"; row: ExemptionRow }
  | { kind: "already-revoked" }
  /** 期限が過ぎていて、もう効いていない。取り消す物が無い。 */
  | { kind: "expired" }
  | { kind: "not-found" };

/**
 * その行で、`since` から後に外した頁の数 (`crawl_pages.robots_exemption_id`・`047`)。`robots_exemptions` を引く
 * select に足す式で、一覧の「24 時間で外した枚数」と、段ごとの残りの枚数 (`exemptions/dispatch.ts`) が同じ数え方を
 * 使う。測るのは頁を触り終えた時刻 (`finished_at`)。**外して撮りに行き、撮れなかった頁も数える** (上限は相手に送った
 * 要求の数に掛ける)。`count` は int8 なので int に倒す (node-pg は int8 を字で返す)。
 */
export const usedSince = (eb: ExpressionBuilder<Database, "robotsExemptions">, since: Date) =>
  eb
    .selectFrom("crawlPages")
    .select(sql<number>`count(*)::int`.as("n"))
    .whereRef("crawlPages.robotsExemptionId", "=", "robotsExemptions.id")
    .where("crawlPages.finishedAt", ">=", since);

/** 一覧の 1 行。行と、24 時間でその行で外した頁の数。 */
export type ListedExemption = ExemptionRow & { usedLast24h: number };

/**
 * その組織の行をみな (効いている・切れた・取り消した)、新しい順に。行ごとに、`now` までの 24 時間で外した頁の数を
 * 付ける。組織が無ければ SQL を出さない。
 */
export const listExemptions = async (
  db: Kysely<Database>,
  orgIds: readonly string[],
  now: Date,
): Promise<ListedExemption[]> => {
  if (orgIds.length === 0) return [];
  const rows = await db
    .selectFrom("robotsExemptions")
    .selectAll()
    .select((eb) => usedSince(eb, new Date(now.getTime() - DAY_MS)).as("usedLast24h"))
    .where("orgId", "in", orgIds)
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .execute();
  // 副問い合わせの型は null を含む (count は必ず 1 行返すので、実際には来ない)
  return rows.map((row) => ({ ...row, usedLast24h: row.usedLast24h ?? 0 }));
};

/** 行を 1 つ。状態は問わない。 */
export const getExemption = async (
  db: Kysely<Database>,
  id: string,
): Promise<ExemptionRow | undefined> =>
  db.selectFrom("robotsExemptions").selectAll().where("id", "=", id).executeTakeFirst();

/** 登録する。同じ組織・ホストの登録は 1 本ずつ進む (頭の注)。 */
export const createExemption = async (
  db: Kysely<Database>,
  exemption: NewExemption,
  now: Date,
): Promise<CreateExemptionResult> =>
  db.transaction().execute(async (trx): Promise<CreateExemptionResult> => {
    await sql`select pg_advisory_xact_lock(hashtext(${exemption.orgId}), hashtext(${exemption.host}))`.execute(
      trx,
    );
    const active = await trx
      .selectFrom("robotsExemptions")
      .select(["id", "pathPattern", "userAgent"])
      .where("orgId", "=", exemption.orgId)
      .where("host", "=", exemption.host)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", now)
      .orderBy("id")
      .execute();
    const overlap = active.find((row) => row.pathPattern === exemption.pathPattern);
    if (overlap !== undefined) return { kind: "overlap", id: overlap.id };
    const other = active.find((row) => row.userAgent !== exemption.userAgent);
    if (other !== undefined) return { kind: "user-agent-mismatch", userAgent: other.userAgent };

    const row = await trx
      .insertInto("robotsExemptions")
      .values({
        orgId: exemption.orgId,
        host: exemption.host,
        pathPattern: exemption.pathPattern,
        scope: exemption.scope,
        appliesTo: exemption.appliesTo,
        userAgent: exemption.userAgent,
        reason: exemption.reason,
        dailyLimit: exemption.dailyLimit,
        linkLimit: exemption.linkLimit,
        createdBy: exemption.createdBy,
        createdByName: exemption.createdByName ?? null,
        // 期限を見たのと同じ時計で書く (DB の now() だと、「登録から 90 日」が API の時計とずれる)
        createdAt: now.toISOString(),
        expiresAt: exemption.expiresAt.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { kind: "created", row };
  });

/**
 * 取り消す。**効いている行だけ** —— 行は消さず、時刻と主体を立てる。当たらなかった時は、訳を読み直して返す
 * (もう取り消した・期限が過ぎた・無い)。
 */
export const revokeExemption = async (
  db: Kysely<Database>,
  id: string,
  who: Revoker,
  now: Date,
): Promise<RevokeExemptionResult> => {
  const row = await db
    .updateTable("robotsExemptions")
    .set({
      revokedAt: now.toISOString(),
      revokedBy: who.subject,
      revokedByName: who.name ?? null,
    })
    .where("id", "=", id)
    // 2 本が同時に来ても、当たるのは 1 本 (後の 1 本は、立った `revoked_at` を見て外れる)
    .where("revokedAt", "is", null)
    .where("expiresAt", ">", now)
    .returningAll()
    .executeTakeFirst();
  if (row !== undefined) return { kind: "revoked", row };

  const current = await getExemption(db, id);
  if (current === undefined) return { kind: "not-found" };
  return current.revokedAt === null ? { kind: "expired" } : { kind: "already-revoked" };
};
