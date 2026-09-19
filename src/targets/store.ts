/**
 * 撮る対象 (`capture_targets`) を足す・見る・外す・消す。`pnpm run targets` の芯。
 *
 * **開発用の道具の中身で、認可は通らない。** DB に直接書く。API の口 (`POST /api/crawls`
 * など) と違い、誰が足したかも記録しない。
 *
 * ## URL は、クロールが種を読むのと同じ関数で読む
 *
 * `parseHttpUrl` で読み、正規化した形 (フラグメントを落とした形) で保存する。
 * `crawls.seeds` に入る形と同じなので、ここで足せた URL は、撮るときにも読める。
 *
 * ## 読めない URL が 1 本でもあれば、何も足さない
 *
 * 黙って読み飛ばすと、足した側は「全部入った」と読む。名指しで返して、直してもらう。
 *
 * ## 組織は、足すときも引くときも必ず付ける
 *
 * `capture_targets` のユニークは `(org_id, url_hash)` (`015`)。同じ URL が別の組織の対象として
 * 在っても、それには触らない —— 既存の行を引くときも、組織で絞る。
 */
import type { Insertable, Kysely } from "kysely";
import { sql } from "kysely";
import { parseHttpUrl } from "../crawl/scope.js";
import type { CaptureTargetsTable, Database } from "../db/database.js";

/** 行を指すのに要るもの。id は BIGSERIAL なので、node-pg に合わせて文字列。 */
export interface TargetRef {
  id: string;
  url: string;
}

export interface TargetRow extends TargetRef {
  orgId: string;
  labels: string[];
  enabled: boolean;
}

export type AddResult =
  | { kind: "unreadable"; urls: string[] }
  | { kind: "ok"; added: TargetRef[]; reenabled: TargetRef[]; unchanged: TargetRef[] };

export type ChangeResult =
  { kind: "missing"; ids: string[] } | { kind: "ok"; changed: TargetRef[]; unchanged: TargetRef[] };

export type RemoveResult =
  { kind: "missing"; ids: string[] } | { kind: "ok"; removed: TargetRef[] };

const ref = (row: TargetRef): TargetRef => ({ id: row.id, url: row.url });

/** 頼まれた id のうち、見つからなかったもの。 */
const missingIds = (wanted: readonly string[], found: readonly TargetRef[]): string[] => {
  const present = new Set(found.map((row) => row.id));
  return wanted.filter((id) => !present.has(id));
};

/**
 * URL を、ある組織の撮る対象として足す。
 *
 * 1 つのトランザクションの中で、① 同じ組織の既存の行を引き、② 無いものだけを足し、
 * ③ 無効だった行を有効に戻す。既存の行の札 (labels) には触らない。
 */
export const addTargets = async (
  db: Kysely<Database>,
  input: { orgId: string; urls: readonly string[]; labels?: string[] },
): Promise<AddResult> => {
  const parsed = input.urls.map((raw) => ({ raw, url: parseHttpUrl(raw) }));
  const unreadable = parsed.filter((item) => item.url === undefined).map((item) => item.raw);
  if (unreadable.length > 0) return { kind: "unreadable", urls: unreadable };

  // 正規化すると同じになる URL (フラグメントだけが違う等) は、1 本に畳む。
  const urls = [...new Set(parsed.flatMap((item) => (item.url ? [item.url.normalized] : [])))];
  if (urls.length === 0) return { kind: "ok", added: [], reenabled: [], unchanged: [] };

  return db.transaction().execute(async (trx): Promise<AddResult> => {
    const existing = await trx
      .selectFrom("captureTargets")
      .select(["id", "url", "enabled"])
      .where("orgId", "=", input.orgId)
      .where("url", "in", urls)
      .execute();
    const known = new Set(existing.map((row) => row.url));

    // 型注釈を付けること。付けないと、存在しない列名を書いても typecheck が通る。
    const rows: Insertable<CaptureTargetsTable>[] = urls
      .filter((url) => !known.has(url))
      .map((url) => ({ url, orgId: input.orgId, labels: input.labels ?? [] }));
    const added =
      rows.length === 0
        ? []
        : await trx.insertInto("captureTargets").values(rows).returning(["id", "url"]).execute();

    const disabled = existing.filter((row) => !row.enabled);
    if (disabled.length > 0) {
      // updated_at に自動更新のトリガは無い (`001`) ので、ここで書く。
      await trx
        .updateTable("captureTargets")
        .set({ enabled: true, updatedAt: sql<string>`now()` })
        .where(
          "id",
          "in",
          disabled.map((row) => row.id),
        )
        .execute();
    }

    return {
      kind: "ok",
      added: added.map(ref),
      reenabled: disabled.map(ref),
      unchanged: existing.filter((row) => row.enabled).map(ref),
    };
  });
};

/** 撮る対象の一覧。組織を渡せばその組織のぶんだけ。組織ごとに、足した順 (id の順)。 */
export const listTargets = (
  db: Kysely<Database>,
  query: { orgId?: string },
): Promise<TargetRow[]> => {
  let q = db
    .selectFrom("captureTargets")
    .select(["id", "orgId", "url", "labels", "enabled"])
    .orderBy("orgId", "asc")
    .orderBy("id", "asc");
  if (query.orgId !== undefined) q = q.where("orgId", "=", query.orgId);
  return q.execute();
};

/**
 * 行を有効・無効にする。履歴を残したまま対象から外すための道。
 *
 * 見つからない id が 1 つでもあれば、何も変えずに名指しで返す —— 打ち間違いの id が
 * 混ざったまま、残りだけが変わるのを避ける。
 */
export const setEnabled = async (
  db: Kysely<Database>,
  input: { ids: readonly string[]; enabled: boolean },
): Promise<ChangeResult> => {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return { kind: "ok", changed: [], unchanged: [] };

  return db.transaction().execute(async (trx): Promise<ChangeResult> => {
    const found = await trx
      .selectFrom("captureTargets")
      .select(["id", "url", "enabled"])
      .where("id", "in", ids)
      .execute();
    const missing = missingIds(ids, found);
    if (missing.length > 0) return { kind: "missing", ids: missing };

    const toChange = found.filter((row) => row.enabled !== input.enabled);
    if (toChange.length > 0) {
      await trx
        .updateTable("captureTargets")
        .set({ enabled: input.enabled, updatedAt: sql<string>`now()` })
        .where(
          "id",
          "in",
          toChange.map((row) => row.id),
        )
        .execute();
    }
    return {
      kind: "ok",
      changed: toChange.map(ref),
      unchanged: found.filter((row) => row.enabled === input.enabled).map(ref),
    };
  });
};

/**
 * 行を消す。`capture_targets` を参照する外部キーは無いので、クロールの履歴には響かない。
 * 見つからない id が 1 つでもあれば、何も消さずに名指しで返す。
 */
export const removeTargets = async (
  db: Kysely<Database>,
  input: { ids: readonly string[] },
): Promise<RemoveResult> => {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return { kind: "ok", removed: [] };

  return db.transaction().execute(async (trx): Promise<RemoveResult> => {
    const found = await trx
      .selectFrom("captureTargets")
      .select(["id", "url"])
      .where("id", "in", ids)
      .execute();
    const missing = missingIds(ids, found);
    if (missing.length > 0) return { kind: "missing", ids: missing };

    await trx
      .deleteFrom("captureTargets")
      .where(
        "id",
        "in",
        found.map((row) => row.id),
      )
      .execute();
    return { kind: "ok", removed: found.map(ref) };
  });
};
