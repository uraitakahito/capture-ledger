/**
 * ページの中で走らせる JavaScript の目録 (`scripts`) を足す・見る・切り替える・消す。
 * `pnpm run scripts` の芯で、クロールを始めるときの解決もここが持つ。
 *
 * **開発用の道具の中身で、認可は通らない。** DB に直接書く (`targets/store.ts` と同じ)。
 *
 * ## 版は足すもので、書き換えるものではない
 *
 * `addScript` は必ず**次の版**を作る。同じ `id` の同じ中身を 2 度足そうとしたときだけ、
 * 既に在る版をそのまま返す —— 中身が同じなら新しい版を作る意味が無く、版の番号だけが
 * 増えると、どの版が何だったのかが読みにくくなる。
 *
 * ## `enabled` が決めるのは「既定に入るか」だけ
 *
 * 無効な版でも、`scriptIds` で名指しすれば走る。名指しは明示なので、既定から外した
 * という意思とは別の話になる。消さずに無効にできる形にしてあるのは、版の履歴を
 * 残したまま既定から外せるようにするため。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { CrawlScript, Database, ScriptPhase } from "../db/database.js";

/** 目録の 1 行 (source は含めない —— 一覧で読むものではない)。 */
export interface ScriptRow {
  id: string;
  version: number;
  phase: ScriptPhase;
  sha256: string;
  enabled: boolean;
  bytes: number;
}

export interface AddResult {
  kind: "ok";
  id: string;
  version: number;
  sha256: string;
  reused: boolean;
}

export type ChangeResult =
  { kind: "missing"; ids: string[] } | { kind: "ok"; changed: { id: string; version: number }[] };

/** 目録に無い id が在れば、名指しで返す。**黙って落とさない。** */
export type ResolveResult =
  { kind: "missing"; ids: string[] } | { kind: "ok"; scripts: CrawlScript[] };

/**
 * 1 本足す。**版は自動で採番する** —— 呼ぶ側に決めさせると、飛んだ番号や
 * 同じ番号の取り合いを扱うことになる。
 *
 * 同じ `id` の最新版と `source` が同一なら、新しい版を作らずにその版を返す
 * (`reused: true`)。
 *
 * **`options` を渡したときだけ、その違いを見る。** 走る中身が同じでも渡す値が違えば
 * ページで起きることは違うので、`options` を明示した呼び出しは版を分ける。一方
 * `options` を省いた呼び出しは「渡す値について意見が無い」であって「`{}` にしろ」では
 * ない —— 区別しないと、`import` が運用側で付けた設定を**黙って捨てた新しい版**を作り、
 * それが既定になる (目録は id ごとに最新版を選ぶため)。
 */
export const addScript = async (
  db: Kysely<Database>,
  input: {
    id: string;
    phase: ScriptPhase;
    source: string;
    options?: Record<string, unknown>;
  },
): Promise<AddResult> => {
  const options = input.options ?? {};
  // 渡されなかったのか、`{}` と明示されたのか。前者は「意見が無い」。
  const opinionated = input.options !== undefined;
  return db.transaction().execute(async (trx) => {
    const latest = await trx
      .selectFrom("scripts")
      .select(["version", "source", "sha256", "options"])
      .where("id", "=", input.id)
      .orderBy("version", "desc")
      .limit(1)
      .executeTakeFirst();

    if (
      latest?.source === input.source &&
      (!opinionated || JSON.stringify(latest.options) === JSON.stringify(options))
    ) {
      return {
        kind: "ok" as const,
        id: input.id,
        version: latest.version,
        sha256: latest.sha256,
        reused: true,
      };
    }

    const inserted = await trx
      .insertInto("scripts")
      .values({
        id: input.id,
        version: (latest?.version ?? 0) + 1,
        phase: input.phase,
        source: input.source,
        options: JSON.stringify(options),
      })
      .returning(["version", "sha256"])
      .executeTakeFirstOrThrow();

    return {
      kind: "ok" as const,
      id: input.id,
      version: inserted.version,
      sha256: inserted.sha256,
      reused: false,
    };
  });
};

/**
 * 目録を読む。既定では**各 id の最新版だけ**を返す —— 一覧で知りたいのは
 * 「いま何が走るか」で、版の history はそれを聞いてから読むもの。
 */
export const listScripts = async (
  db: Kysely<Database>,
  input: { allVersions?: boolean } = {},
): Promise<ScriptRow[]> => {
  let query = db.selectFrom("scripts").select([
    "id",
    "version",
    "phase",
    "sha256",
    "enabled",
    // **`length` ではなく `octet_length`。** `length` は文字数を数えるので、
    // 日本語のコメントを持つスクリプトでは「B」と書いた列が実際のバイト数より
    // 小さく出る (autofetch は 3949 B なのに 3093 と出ていた)。
    sql<number>`octet_length(source)`.as("bytes"),
  ]);
  if (input.allVersions !== true) {
    query = query.distinctOn("id");
  }
  return query.orderBy("id").orderBy("version", "desc").execute();
};

/**
 * 既定の顔ぶれに入れる / 外す。版を指定しなければ最新版に効く。
 *
 * **消さずに外せること**が要点。消すと、過去のクロールが何を走らせたのかを
 * 目録の側から辿れなくなる。
 */
export const setScriptEnabled = async (
  db: Kysely<Database>,
  input: { ids: readonly string[]; version?: number; enabled: boolean },
): Promise<ChangeResult> => {
  return db.transaction().execute(async (trx) => {
    const targets = await resolveVersions(trx, input.ids, input.version);
    if (targets.kind === "missing") return targets;

    for (const target of targets.rows) {
      await trx
        .updateTable("scripts")
        .set({ enabled: input.enabled })
        .where("id", "=", target.id)
        .where("version", "=", target.version)
        .execute();
    }
    return { kind: "ok" as const, changed: targets.rows };
  });
};

/**
 * 行を消す。版を指定しなければ**その id の全版**が消える。
 *
 * `crawls.scripts` は解決済みの写しを持つので、消しても過去のクロールの記録は
 * 壊れない (`018` を見ること)。それでも既定から外すだけで済むなら
 * `setScriptEnabled` のほうがよい。
 */
export const removeScripts = async (
  db: Kysely<Database>,
  input: { ids: readonly string[]; version?: number },
): Promise<ChangeResult> => {
  return db.transaction().execute(async (trx) => {
    const targets = await resolveVersions(trx, input.ids, input.version);
    if (targets.kind === "missing") return targets;

    for (const target of targets.rows) {
      let query = trx.deleteFrom("scripts").where("id", "=", target.id);
      if (input.version !== undefined) query = query.where("version", "=", input.version);
      await query.execute();
    }
    return { kind: "ok" as const, changed: targets.rows };
  });
};

/**
 * クロールが走らせるものを決める。
 *
 * - `ids` を渡したら**その並びのまま**、各 id の最新版を返す。無効な版でも名指しは通る。
 * - 渡さなければ **有効な各 id の最新版**を `id` 順で返す。
 *
 * 1 つでも見つからなければ、名指しで返して何も返さない —— 黙って落とすと、頼んだ側は
 * 全部走ったつもりで結果を読むことになる (`targets/store.ts` の「読めない URL」と同じ判断)。
 */
export const resolveScripts = async (
  db: Kysely<Database>,
  ids?: readonly string[],
): Promise<ResolveResult> => {
  const columns = ["id", "version", "phase", "source", "sha256", "options"] as const;

  if (ids === undefined) {
    const rows = await db
      .selectFrom("scripts")
      .select(columns)
      .distinctOn("id")
      .where("enabled", "=", true)
      .orderBy("id")
      .orderBy("version", "desc")
      .execute();
    return { kind: "ok", scripts: rows.map(toScript) };
  }

  if (ids.length === 0) return { kind: "ok", scripts: [] };

  const rows = await db
    .selectFrom("scripts")
    .select(columns)
    .distinctOn("id")
    .where("id", "in", [...ids])
    .orderBy("id")
    .orderBy("version", "desc")
    .execute();

  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) return { kind: "missing", ids: [...new Set(missing)] };

  // **頼まれた並びのまま**返す。behavior は書かれた順に走るので、並びは意味を持つ。
  return { kind: "ok", scripts: ids.map((id) => toScript(byId.get(id)!)) };
};

const toScript = (row: {
  id: string;
  version: number;
  phase: ScriptPhase;
  source: string;
  sha256: string;
  options: Record<string, unknown>;
}): CrawlScript => ({
  id: row.id,
  version: row.version,
  phase: row.phase,
  source: row.source,
  sha256: row.sha256,
  options: row.options,
});

/** 指定された版 (無ければ最新版) を id ごとに 1 つ引く。見つからない id は名指しで返す。 */
const resolveVersions = async (
  trx: Kysely<Database>,
  ids: readonly string[],
  version?: number,
): Promise<
  { kind: "missing"; ids: string[] } | { kind: "ok"; rows: { id: string; version: number }[] }
> => {
  if (ids.length === 0) return { kind: "ok", rows: [] };

  let query = trx
    .selectFrom("scripts")
    .select(["id", "version"])
    .where("id", "in", [...ids]);
  query = version === undefined ? query.distinctOn("id") : query.where("version", "=", version);

  const rows = await query.orderBy("id").orderBy("version", "desc").execute();
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) return { kind: "missing", ids: [...new Set(missing)] };
  return { kind: "ok", rows };
};
