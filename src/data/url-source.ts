/**
 * Postgres を裏に持つ URL の出どころ。
 *
 * `db/migrations/001-create-capture-targets.ts` が作った `capture_targets` から
 * 行を選ぶ。よく通る道の問い合わせは `capture_targets_enabled_id_idx` の partial
 * index が覆っている。
 *
 * 以前はここに `loadUrls` (生の `pg.Pool` を取る CLI 経路のもの) も在ったが、
 * その呼び出し元 (client/run.ts) ごと畳んだので消えている。
 */
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";

/**
 * クロールの起点として `capture_targets` を読む。
 *
 * ## 組織で絞る
 *
 * 以前の CLI 経路 (run.ts) は「他組織の対象が混じっていたら投げる」という仮の検査を
 * していた。
 * ここでは**絞り込みにしてある** —— クロールは `org_id` を 1 つ持つ行なので、
 * 別の組織の対象を混ぜると帰属が言えなくなる。テナントが増えたときに、
 * 「他人の対象まで取ってしまった」ではなく「自分のぶんだけ取った」になる形。
 *
 * 順は `id` 昇順。`capture_targets_enabled_id_idx` の partial index が覆う。
 */
export const loadTargets = async (
  db: Kysely<Database>,
  query: { orgId: string; limit?: number },
): Promise<{ url: string }[]> => {
  let q = db
    .selectFrom("captureTargets")
    .select("url")
    .where("enabled", "=", true)
    .where("orgId", "=", query.orgId)
    .orderBy("id", "asc");
  if (query.limit !== undefined) q = q.limit(query.limit);
  return q.execute();
};
