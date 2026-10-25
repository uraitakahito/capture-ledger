/**
 * ページの中で走らせるスクリプト (`scripts`) を足す・見る・切り替える・消す。
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
 * 無効な版でも、`POST /api/crawls` の `scripts` で名指しすれば走る。名指しは明示なので、
 * 既定から外したという意思とは別の話になる。消さずに無効にできる形にしてあるのは、版の履歴を
 * 残したまま既定から外せるようにするため。
 *
 * ## その場の JS は台帳に登録しない
 *
 * `scripts` の要素には、台帳のスクリプトの名指しのほかに、その場で書いた JS（`inline`）を置ける。
 * 台帳はそれを登録せず、クロールの行の写しにだけ固定する（`inlineScript`）。id は
 * `inline-<name>` で、台帳のスクリプトの id には `inline-` を使わせない（`019` の CHECK と CLI）——
 * アーカイブの id だけで、台帳のスクリプトか、その場の物かが分かるようにするため。
 *
 * ## 札（`sites`）は起点で効く
 *
 * 札のあるスクリプトは、クロールの起点のどれかがそのサイトにあるときだけ走る（`021`）。`scripts` を省いた
 * 頼みでは、有効な各 id の最新版を選んでから、札の無い物と起点に合う物を残す（`resolveScripts`）。
 * 名指しで起点に合わない物を入れるのは、頼む側が断る（`offsiteScripts`）。**最新版を選ぶのが先** ——
 * 札で絞ってから版を選ぶと、札の無い古い版が既定に出てくる（開発の Postgres で確かめた）。
 *
 * ## 受け皿の型も置く
 *
 * `host_types` (`020`) は、スクリプトの source を読む人に見せる受け皿 `__bh` の型の写し。足し方はスクリプトと
 * 同じで、中身が同じなら版を増やさない。走る JS の型を決めるのは ts-compile-service の pin で、ここではない。
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { CrawlScript, Database, ScriptPhase } from "../db/database.js";

/** `scripts` の 1 行 (source は含めない —— 一覧で読むものではない)。 */
export interface ScriptRow {
  id: string;
  version: number;
  phase: ScriptPhase;
  sha256: string;
  /** 札（`021`）。空ならどこでも走る */
  sites: string[];
  enabled: boolean;
  bytes: number;
  /** 取り込んだ時刻。版を並べたときに、どれがいつの物かを言う */
  createdAt: Date;
}

/** スクリプトの 1 版を丸ごと (`readScript`)。一覧の行に、source と渡す値を足した物。 */
export interface ScriptVersion extends ScriptRow {
  source: string;
  options: Record<string, unknown>;
}

/** 受け皿 `__bh` の型の 1 版 (`readHostTypes`)。読む人に見せる写し (`020`)。 */
export interface HostTypesRow {
  version: number;
  sha256: string;
  createdAt: Date;
  source: string;
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

/** 札の形。小文字の ASCII のホスト名 (IDN は punycode)。`021` の CHECK と capture-scripts の check と同じ式 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** 札として断るなら、その文。DB の CHECK (`021`) より先に、読める文で言う。 */
export const sitesRefusal = (sites: readonly string[]): string | undefined => {
  const bad = sites.filter((site) => !HOSTNAME.test(site));
  if (bad.length > 0) {
    return `札は小文字のホスト名だけ (ポート・scheme・* は書けない): ${bad.join(", ")}`;
  }
  if (new Set(sites).size !== sites.length) return "札に同じホスト名が 2 度ある";
  return undefined;
};

/** その札のスクリプトを、この起点で走らせてよいか。札が無ければどこでも。起点はホスト名 (ポートは見ない) */
export const onSeed = (sites: readonly string[], seedHosts: readonly string[]): boolean =>
  sites.length === 0 || sites.some((site) => seedHosts.includes(site));

/** 起点のどれもそのサイトに無い、サイト用のスクリプト (名指しで入れたもの)。その場の JS は札を持たない */
export const offsiteScripts = (
  scripts: readonly CrawlScript[],
  seedHosts: readonly string[],
): { id: string; sites: string[] }[] =>
  scripts.flatMap((script) =>
    onSeed(script.sites ?? [], seedHosts) ? [] : [{ id: script.id, sites: script.sites ?? [] }],
  );

/** その場の JS の id の頭。台帳が付け、台帳のスクリプトの id には使わせない。 */
export const INLINE_PREFIX = "inline-";

export const isInlineId = (id: string): boolean => id.startsWith(INLINE_PREFIX);

/** 台帳のスクリプトの id として断るなら、その文。DB の CHECK (`019`) より先に、読める文で言う。 */
export const catalogIdRefusal = (id: string): string | undefined =>
  isInlineId(id) ? `${id}: ${INLINE_PREFIX} で始まる id は、その場の JS に取ってある` : undefined;

/** その場で書いた JS 1 本 (`POST /api/crawls` の `scripts[].inline`)。 */
export interface InlineScript {
  name: string;
  phase: ScriptPhase;
  source: string;
}

/** 要求の 1 要素。台帳のスクリプトの名指しか、その場の JS か —— 鍵はどちらか 1 つだけ (schema が見る)。 */
export type RequestedScript = { catalog: string } | { inline: InlineScript };

/** 台帳に無い id と、同じ id の重ねが在れば、名指しで返す。**黙って落とさない。** */
export type ResolveResult =
  | { kind: "missing"; ids: string[] }
  | { kind: "duplicate"; ids: string[] }
  | { kind: "ok"; scripts: CrawlScript[] };

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
 * それが既定になる (台帳は id ごとに最新版を選ぶため)。
 *
 * **札 (`sites`) も同じ扱い。** 渡したときだけ最新版と比べ、違えば版を足す。`import` は catalog の札を
 * 必ず渡す (書いていなければ空) —— catalog が札の正なので、意見として渡す。
 */
export const addScript = async (
  db: Kysely<Database>,
  input: {
    id: string;
    phase: ScriptPhase;
    source: string;
    options?: Record<string, unknown>;
    sites?: readonly string[];
  },
): Promise<AddResult> => {
  const options = input.options ?? {};
  // 渡されなかったのか、`{}` と明示されたのか。前者は「意見が無い」。
  const opinionated = input.options !== undefined;
  return db.transaction().execute(async (trx) => {
    const latest = await trx
      .selectFrom("scripts")
      .select(["version", "source", "sha256", "options", "sites"])
      .where("id", "=", input.id)
      .orderBy("version", "desc")
      .limit(1)
      .executeTakeFirst();

    if (
      latest?.source === input.source &&
      (!opinionated || JSON.stringify(latest.options) === JSON.stringify(options)) &&
      (input.sites === undefined || latest.sites.join(" ") === input.sites.join(" "))
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
        sites: [...(input.sites ?? [])],
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
 * スクリプトを読む。既定では**各 id の最新版だけ**を返す —— 一覧で知りたいのは
 * 「いま何が走るか」で、版の history はそれを聞いてから読むもの。
 */
export const listScripts = async (
  db: Kysely<Database>,
  input: { allVersions?: boolean; id?: string } = {},
): Promise<ScriptRow[]> => {
  let query = db.selectFrom("scripts").select([
    "id",
    "version",
    "phase",
    "sha256",
    "sites",
    "enabled",
    // **`length` ではなく `octet_length`。** `length` は文字数を数えるので、
    // 日本語のコメントを持つスクリプトでは「B」と書いた列が実際のバイト数より
    // 小さく出る (autofetch は 3949 B なのに 3093 と出ていた)。
    sql<number>`octet_length(source)`.as("bytes"),
    "createdAt",
  ]);
  if (input.allVersions !== true) {
    query = query.distinctOn("id");
  }
  // 1 つの id の版だけ (`GET /api/scripts/:id/versions` と `list <id>`)
  if (input.id !== undefined) query = query.where("id", "=", input.id);
  return query.orderBy("id").orderBy("version", "desc").execute();
};

/**
 * スクリプトの 1 版を丸ごと (source を含む)。**有効かどうかは見ない** —— 無効な版も、過去のクロールが
 * 走らせた物。`GET /api/scripts/:id/versions/:version` と `show --version` の芯。
 */
export const readScript = async (
  db: Kysely<Database>,
  id: string,
  version: number,
): Promise<ScriptVersion | undefined> =>
  db
    .selectFrom("scripts")
    .select([
      "id",
      "version",
      "phase",
      "sha256",
      "sites",
      "enabled",
      sql<number>`octet_length(source)`.as("bytes"), // listScripts と同じく length ではない
      "createdAt",
      "source",
      "options",
    ])
    .where("id", "=", id)
    .where("version", "=", version)
    .executeTakeFirst();

/**
 * 受け皿の型を 1 つ足す。**いちばん新しい版と中身が同じなら、版を増やさない** (`addScript` と同じ)
 * —— `import` を何度流しても、型が変わらなければ何も起きない。
 */
export const addHostTypes = async (
  db: Kysely<Database>,
  source: string,
): Promise<{ version: number; sha256: string; reused: boolean }> =>
  db.transaction().execute(async (trx) => {
    const latest = await trx
      .selectFrom("hostTypes")
      .select(["version", "source", "sha256"])
      .orderBy("version", "desc")
      .limit(1)
      .executeTakeFirst();
    if (latest?.source === source) {
      return { version: latest.version, sha256: latest.sha256, reused: true };
    }
    const inserted = await trx
      .insertInto("hostTypes")
      .values({ version: (latest?.version ?? 0) + 1, source })
      .returning(["version", "sha256"])
      .executeTakeFirstOrThrow();
    return { ...inserted, reused: false };
  });

/** いちばん新しい受け皿の型。1 度も取り込んでいなければ undefined。 */
export const readHostTypes = async (db: Kysely<Database>): Promise<HostTypesRow | undefined> =>
  db
    .selectFrom("hostTypes")
    .select([
      "version",
      "sha256",
      "createdAt",
      "source",
      sql<number>`octet_length(source)`.as("bytes"),
    ])
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();

/**
 * 既定の顔ぶれに入れる / 外す。
 *
 * **版を指定しなければ、その id の全版に効く。** 既定の顔ぶれの単位は id であって
 * 版ではない —— 最新版だけを無効にすると、解決は「有効な中での最新版」を選ぶので、
 * **古い版が黙って昇格する**。運用する人が `disable autoscroll` と打ったとき、
 * 起きてほしいのは「autoscroll が走らなくなる」であって「1 つ前の autoscroll が走る」
 * ではない (2026-09-20 に実機で踏んだ: v2 を無効にしたら v1 が既定になった)。
 *
 * 版を指定したときだけ、その 1 つに効く —— 「v3 が悪かったので v2 に戻す」はこちら。
 *
 * **消さずに外せること**が要点。消すと、過去のクロールが何を走らせたのかを
 * 台帳の側から辿れなくなる。
 */
export const setScriptEnabled = async (
  db: Kysely<Database>,
  input: { ids: readonly string[]; version?: number; enabled: boolean },
): Promise<ChangeResult> => {
  return db.transaction().execute(async (trx) => {
    const targets = await resolveVersions(trx, input.ids, input.version);
    if (targets.kind === "missing") return targets;

    for (const target of targets.rows) {
      let query = trx
        .updateTable("scripts")
        .set({ enabled: input.enabled })
        .where("id", "=", target.id);
      // 版を名指ししたときだけ絞る。省いたら id の全版。
      if (input.version !== undefined) query = query.where("version", "=", input.version);
      await query.execute();
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
 * 有効な各 id の最新版を、札つきで (`GET /api/scripts`)。**サイト用のスクリプトも入れる** —— dashboard はこれで
 * 札を見せ、新しいクロールの画面で起点に合う物を選ぶ。既定で走るのは、この中の札の無い物と起点に合う物。
 */
export const enabledLatest = async (
  db: Kysely<Database>,
): Promise<
  { id: string; version: number; phase: ScriptPhase; sha256: string; sites: string[] }[]
> =>
  db
    .selectFrom("scripts")
    .select(["id", "version", "phase", "sha256", "sites"])
    .distinctOn("id")
    .where("enabled", "=", true)
    .orderBy("id")
    .orderBy("version", "desc")
    .execute();

/**
 * クロールが走らせるものを決める。
 *
 * - `requested` を渡したら**その並びのまま**写しを返す。台帳のスクリプトの名指しは各 id の最新版
 *   (無効な版でも名指しは通る)、その場の JS は台帳のスクリプトを引かずに写す (`inlineScript`)。
 * - 渡さなければ **有効な各 id の最新版**のうち、札の無い物と、札のどれかが起点のホストにある物を
 *   `id` 順で返す。**最新版を選んでから札で絞る** —— SQL で札を絞ってから `distinct on` すると、
 *   札の合わない最新版の代わりに、札の無い古い版が出てくる。絞るのは引いた後で、JS で。
 *
 * 名指しの札が起点に合うかは、ここでは見ない (`offsiteScripts`)。
 *
 * 台帳に無い id が 1 つでも在れば、名指しで返して何も返さない —— 黙って落とすと、頼んだ側は
 * 全部走ったつもりで結果を読むことになる (`targets/store.ts` の「読めない URL」と同じ判断)。
 * 同じ id を 2 度頼んだときも名指しで返す —— 報告 (`id@版`) でも変換 (`/src/<id>.ts`) でも、
 * 2 本目が 1 本目に黙って畳まれる。
 */
export const resolveScripts = async (
  db: Kysely<Database>,
  requested?: readonly RequestedScript[],
  seedHosts: readonly string[] = [],
): Promise<ResolveResult> => {
  const columns = ["id", "version", "phase", "source", "sha256", "options", "sites"] as const;

  if (requested === undefined) {
    const rows = await db
      .selectFrom("scripts")
      .select(columns)
      .distinctOn("id")
      .where("enabled", "=", true)
      .orderBy("id")
      .orderBy("version", "desc")
      .execute();
    return {
      kind: "ok",
      scripts: rows.filter((row) => onSeed(row.sites, seedHosts)).map(toScript),
    };
  }

  const ids = requested.map(idOf);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length > 0) return { kind: "duplicate", ids: [...new Set(twice)] };

  // **台帳のスクリプトを引くのは名指しがあるときだけ。** 空の配列は Kysely が `in ()` に組み、Postgres は
  // 構文エラーで断る —— その場の JS だけのクロールが 500 になる。
  const named = requested.flatMap((r) => ("catalog" in r ? [r.catalog] : []));
  const rows =
    named.length === 0
      ? []
      : await db
          .selectFrom("scripts")
          .select(columns)
          .distinctOn("id")
          .where("id", "in", named)
          .orderBy("id")
          .orderBy("version", "desc")
          .execute();

  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = named.filter((id) => !byId.has(id));
  if (missing.length > 0) return { kind: "missing", ids: [...new Set(missing)] };

  // **頼まれた並びのまま**返す。behavior は書かれた順に走るので、並びは意味を持つ。
  return {
    kind: "ok",
    scripts: requested.map((r) =>
      "catalog" in r ? toScript(byId.get(r.catalog)!) : inlineScript(r.inline),
    ),
  };
};

const idOf = (r: RequestedScript): string =>
  "catalog" in r ? r.catalog : INLINE_PREFIX + r.inline.name;

/**
 * その場の JS の写し。**形は台帳のスクリプトの写しと同じ** —— 段の先 (flow・変換・BrowserHive) は、
 * 台帳のスクリプトと区別しない。版は 1、options は空。sha256 は台帳が source から打つ (`scripts` の生成列
 * `encode(digest(source, 'sha256'), 'hex')` と同じ値)。
 */
const inlineScript = ({ name, phase, source }: InlineScript): CrawlScript => ({
  id: INLINE_PREFIX + name,
  version: 1,
  phase,
  source,
  sha256: createHash("sha256").update(source, "utf8").digest("hex"),
  options: {},
});

const toScript = (row: {
  id: string;
  version: number;
  phase: ScriptPhase;
  source: string;
  sha256: string;
  options: Record<string, unknown>;
  sites: string[];
}): CrawlScript => ({
  id: row.id,
  version: row.version,
  phase: row.phase,
  source: row.source,
  sha256: row.sha256,
  options: row.options,
  sites: row.sites,
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
