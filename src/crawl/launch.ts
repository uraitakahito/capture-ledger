/**
 * 確かめが済んだ頼みから `crawls` の行を立て、最初の段を Windmill へ投げる。
 *
 * `POST /api/crawls` と定期実行の周回で、同じ形の行を立てるために切り出した。周回は行を足す所を
 * トランザクションに入れるので、`insertCrawl` と投げる所を分けてある。
 */
import type { Insertable, Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { crawlKeyPrefix, sinkForCrawl, type SinkConfig } from "../api/sink.js";
import { isUniqueViolation } from "../api/authorization.js";
import type { CaptureFormats, CaptureSettings } from "../config/capture-formats.js";
import type { CrawlScript, CrawlSecret, CrawlsTable, Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import type { ReplayBundleResult } from "../replay-bundle/write.js";
import type { CrawlRequester, PreparedCrawl } from "./prepare.js";

const log = createChildLogger({ module: "api" });

/**
 * Windmill に投げる関数。既定は webhook を叩くもので、試験だけが差し替える。
 * 起こした job の id を返す (Windmill が返さなければ undefined)。
 */
export type CrawlDispatcher = (crawl: DispatchedCrawl) => Promise<string | undefined>;

/**
 * Windmill の flow に渡す 1 段ぶんの仕事。
 *
 * **段の繰り返しは ledger が回す。** flow は 1 段を処理して報告するだけで、次があるかを
 * 判断しない。そうしたのは、Windmill の while ループが止まらなかったから ——
 * `stop_after_if` を付けた最小の flow が 643 回まで回り続けた (実測)。相手のサーバに
 * 負荷をかけない仕組みを、暴走しうるループの上には載せられない。
 *
 * 上限の判定は `budget.ts` に在って単体試験がある。**繰り返しは、その判定と同じ場所に置く。**
 */
export interface DispatchedCrawl {
  crawlId: string;
  depth: number;
  /**
   * この段で取る URL。空で渡すことはない。
   *
   * `lastFinishedAt` は **そのホストを最後に触り終えた時刻**。段をまたぐ間隔を
   * 守るために要る —— 間隔は `crawl_host` の呼び出し 1 回の中でしか効かないので、
   * これが無いと段の境目だけ間隔が空かない。実測で 521ms まで詰まった。
   */
  frontier: { url: string; host: string; lastFinishedAt: string | null }[];
  perHostDelayMs: number;
  hostParallelism: number;
  /**
   * 取り込む形式と署名。**必ず載せる。**
   *
   * flow の schema の既定値には頼れない —— Windmill は webhook 起動のとき
   * 既定値を埋めないので、送らなければ `undefined` が届く (実測)。決めるのは
   * 依然として ledger 側で、flow は言われたとおりに投げる。
   */
  captureFormats: CaptureFormats;
  /**
   * 成果物の送り先。**在れば BrowserHive はそこへ押し出し、自前の保管庫へは書かない。**
   *
   * 段ごとに作る —— クロールは長く続きうるので、後の段には新しい期限を配る。
   * 無ければ従来どおり BrowserHive が自前の保管庫へ書く (2 つの経路は同時に生きる)。
   */
  artifactSink?: { url: string; token: string };
  signing: boolean;
  /**
   * ページの中で走らせるもの。**クロールを始めた時点で解決して固定したもの**を、
   * 段ごとにそのまま配る (`crawls.scripts`)。
   *
   * **必ず載せる。** BrowserHive は顔ぶれを持たないので、送らなければページでは
   * 何も走らない —— そしてそれは、成功した取り込みと archive を見分けられない形の
   * 劣化になる。空配列を送ることと、鍵ごと送らないことを区別する必要も無い
   * (どちらも「何も走らない」) ので、常に載せて形を 1 つに保つ。
   */
  scripts: CrawlScript[];
  /**
   * クロールごとの変数 (名前 → 文字列)。**必ず載せる** (空なら `{}`)。行に固定した物を段ごとにそのまま配る。
   * flow は運ぶだけで、BrowserHive が頁に渡して WACZ の `settings.variables` に値を書く。
   */
  variables: Record<string, string>;
  /**
   * 宣言で結んだシークレット (名前 → Windmill の変数の path)。**必ず載せる** (空なら `{}`)。値は無い ——
   * 解くのは flow の `crawl_host` で、BrowserHive に送る直前に読む。台帳・webhook・WACZ が持つのは名前と path だけ。
   */
  secrets: Record<string, string>;
  /**
   * 値を WARC に残すシークレット (名前 → `"keep"`。宣言の `archive`)。**必ず載せる** (空なら `{}`)。BrowserHive の
   * `secretArchive` になり、無い名前の値は BrowserHive が隠す。**名前は `secrets` の部分集合** —— BrowserHive は
   * `secrets` に無い名前を 400 で断るので、行の同じ写しから組む (`secretsForFlow`)。`crawl_host` も、実際に解いた
   * 名前だけを残してから送る (二重の守り)。
   */
  secretArchive: Record<string, "keep">;
  /**
   * 頼まれた User-Agent。打った字のままで、`{chrome}` は BrowserHive が解く。**必ず載せる** (指定なしは `""`)。
   * flow が省いた入力は `null` で届くので、`""` と分ければ `crawl_host` が取り違えに気づける。
   */
  userAgent: string;
}

/**
 * 合本を 1 本書く (`replay-bundle/write.ts` の `writeReplayBundle` を、配備の db・保管庫・署名のクライアントで包んだ物)。
 * クロールを締めた後に、ここから呼ぶ。
 */
export type ReplayBundleWriter = (
  crawlId: string,
  depth: number | null,
) => Promise<ReplayBundleResult | undefined>;

/**
 * flow へ渡す形は変えない。報告で写した JS の hash と変換の記録は台帳の物で、
 * 変換サービスと BrowserHive には見せない (見せても読まないが、契約を 1 つに保つ)。
 */
export const toDispatched = ({
  id,
  version,
  phase,
  source,
  sha256,
  options,
}: CrawlScript): CrawlScript => ({
  id,
  version,
  phase,
  source,
  sha256,
  options,
});

/**
 * flow へ渡すシークレットの 2 つの欄を、行の**同じ写し**から組む: 名前 → Windmill の変数の path と、値を WARC に残す
 * 名前 → `"keep"`。行が持つ更新時刻は渡さない (flow には要らない)。
 *
 * **2 つを別々に組まない。** `secretArchive` を宣言から組むと、任意で Windmill に無いシークレットの `keep` が
 * `secrets` に無いまま届き、BrowserHive がそのクロールの取り込みを全部 400 で断る (行に無い物は送らない —— `resolveSecrets`)。
 */
export const secretsForFlow = (
  secrets: Readonly<Record<string, CrawlSecret>>,
): Pick<DispatchedCrawl, "secrets" | "secretArchive"> => {
  const entries = Object.entries(secrets);
  return {
    secrets: Object.fromEntries(entries.map(([name, secret]) => [name, secret.path])),
    secretArchive: Object.fromEntries(
      entries
        .filter(([, secret]) => secret.archive === "keep")
        .map(([name]) => [name, "keep" as const]),
    ),
  };
};

export interface LevelDeps {
  db: Kysely<Database>;
  dispatch: CrawlDispatcher;
  writeReplayBundle: ReplayBundleWriter;
}

/** 段を投げる係と、締めた後に合本を書く係。どちらも行の状態を書くので、同じ物に置く。 */
export const levelDispatcher = ({ db, dispatch, writeReplayBundle }: LevelDeps) => {
  /**
   * 締めた後に、合本を 1 本書く (`writeReplayBundle` の注)。**投げない** —— 締めたことが答えで、合本は撮った物から
   * 作る派生物 (書けなければ `crawls.replay_bundle_error` と log に残る)。
   */
  const bundleAfterClose = async (crawlId: string): Promise<void> => {
    try {
      const result = await writeReplayBundle(crawlId, null);
      log.info({ crawlId, ...result }, "Wrote the replay bundle of a closed crawl");
    } catch (err) {
      log.error({ err, crawlId }, "Could not write the replay bundle of a closed crawl");
    }
  };

  /**
   * 段を 1 つ Windmill へ投げる。**待たない** —— この Promise の行き先は `crawls` の行で、
   * 応答ではない。
   *
   * 起こした job の id を `last_job_*` に残す (`016`)。失敗したクロールから、その run へ
   * 1 回で辿れるように。**深さが戻る書き込みはしない** —— 段の報告は速いので、前の段の
   * id が次の段の id の後に届くことがありうる。
   *
   * 投げられなければクロールを締める。黙って `running` のまま置くと、部分 unique index が
   * 以後のクロールを全部塞ぐ。以前はこの 2 つを、最初の段と次の段の 2 か所に写していた。
   * 締めるのは走行中の行だけで (`/failed` と同じ)、締めたら終わった状態の合本を書く (CAPTURE-61)。
   */
  const dispatchLevel = (level: DispatchedCrawl): void => {
    const { crawlId, depth } = level;
    void dispatch(level)
      .then(
        async (jobId) => {
          if (jobId === undefined) return;
          await db
            .updateTable("crawls")
            .set({ lastJobId: jobId, lastJobDepth: depth })
            .where("id", "=", crawlId)
            .where((eb) => eb.or([eb("lastJobDepth", "is", null), eb("lastJobDepth", "<=", depth)]))
            .execute();
        },
        async (err: unknown) => {
          log.error({ err, crawlId, depth }, "Could not dispatch a level");
          const closed = await db
            .updateTable("crawls")
            .set({
              state: "failed",
              stopReason: "failed",
              finishedAt: new Date().toISOString(),
              error: err instanceof Error ? err.message : String(err),
            })
            .where("id", "=", crawlId)
            // **走行中のものだけ** (`/failed` と同じ)。先に締めた者の理由を上書きしない
            .where("state", "=", "running")
            .returning("id")
            .execute();
          // 締めたなら、終わった状態の合本を書く (次の段が無いので、ほかに書く者が居ない)
          if (closed.length > 0) await bundleAfterClose(crawlId);
        },
      )
      .catch((updateErr: unknown) => {
        log.error({ err: updateErr, crawlId, depth }, "Could not record the dispatch");
      });
  };

  return { bundleAfterClose, dispatchLevel };
};

export interface LaunchDeps {
  db: Kysely<Database>;
  capture: CaptureSettings;
  sink?: SinkConfig;
  dispatchLevel: (level: DispatchedCrawl) => void;
}

/** 起点の行を足した結果。最初の段に渡す。 */
export interface SeededPage {
  url: string;
  host: string;
}

/** 定期の回が行に残す欄 (`032`)。ふつうのクロールには無い。 */
export interface ScheduleMark {
  scheduleId: string;
  /** 本来の時刻。「いま撮る」は null。 */
  scheduledFor: string | null;
  /** 1 回にまとめた欠けの数。 */
  scheduleMissed: number;
}

/** `crawls` の行の値。走行中で足すときも、周回が失敗の行を足すときも同じ形にする。 */
export const crawlValues = (
  prepared: PreparedCrawl,
  crawlId: string,
  who: CrawlRequester,
  sink: SinkConfig | undefined,
  mark?: ScheduleMark,
): Insertable<CrawlsTable> => {
  const orgId = who.orgId;
  // **型注釈を付けること。** 注釈の無い変数に入れてから `.values()` へ渡すと
  // 余剰プロパティの検査が効かず、存在しない列名を書いても typecheck が緑で通る。
  const crawl: Insertable<CrawlsTable> = {
    id: crawlId,
    seeds: prepared.seeds.map((parsed) => parsed.normalized),
    rules: JSON.stringify(prepared.rules),
    maxDepth: prepared.maxDepth,
    maxPages: prepared.maxPages,
    perHostDelayMs: prepared.perHostDelayMs,
    hostParallelism: prepared.hostParallelism,
    orgId,
    requestedBy: who.subject,
    // 解決済みの写し。並びが実行順。
    scripts: JSON.stringify(prepared.scripts),
    // クロールごとの値。変数は値ごと、シークレットは path と更新時刻だけ (値は台帳を通らない)
    variables: JSON.stringify(prepared.variables),
    secrets: JSON.stringify(prepared.secrets),
    // 打った字のまま。解いた字は WACZ の settings.userAgent に残る
    userAgent: prepared.userAgent === "" ? null : prepared.userAgent,
    state: "running" as const,
    // **置く場所を、いま 1 度だけ決めて書き残す。** 以後は置く側 (受け取り先) がこの列を読む ——
    // 段ごとに計算し直すと、受け取り先の設定を切り替えた配備や月をまたぐクロールでずれる。探す側
    // (`admitLevel`) はこの列を読まず、報告が運んだ manifest の場所を読む (`014`)。
    // 受け取り先を使わない配備では書かない (NULL = 記録が無い)。
    ...(sink && { artifactKeyPrefix: crawlKeyPrefix(orgId, new Date()) }),
    ...(mark && mark),
  };
  return crawl;
};

/**
 * 行と起点のページを足す。`db` はトランザクションでもよい。**走行中の 1 本とぶつかると投げる**
 * (`crawls_single_active`)。呼ぶ側が読み替える。
 */
export const insertCrawl = async (
  db: Kysely<Database>,
  prepared: PreparedCrawl,
  crawlId: string,
  who: CrawlRequester,
  sink: SinkConfig | undefined,
  mark?: ScheduleMark,
): Promise<SeededPage[]> => {
  const crawl = crawlValues(prepared, crawlId, who, sink, mark);
  await db.insertInto("crawls").values(crawl).execute();

  // 起点を最初の行として置く。深さ 0。ここから flow が読む。
  //
  // **深さ 1 以降と同じ形にしてある** —— 配列で入れ、`onConflict` で重複を
  // index に落とさせ、`returning` で実際に入った行だけを次に渡す。
  // 起点が複数になると同じ URL が 2 度渡されうるので、ここも同じ守りが要る。
  return db
    .insertInto("crawlPages")
    .values(
      prepared.seeds.map((parsed) => ({
        crawlId,
        url: parsed.normalized,
        depth: 0,
        host: parsed.host,
        state: "pending" as const,
      })),
    )
    .onConflict((oc) => oc.columns(["crawlId", "urlHash"]).doNothing())
    .returning(["url", "host"])
    .execute();
};

/** 最初の段。**次の段と同じ形にする** (`crawls.ts` の段の報告)。 */
export const firstLevel = (
  prepared: PreparedCrawl,
  crawlId: string,
  seeded: readonly SeededPage[],
  capture: CaptureSettings,
  sink: SinkConfig | undefined,
): DispatchedCrawl => ({
  crawlId,
  depth: 0,
  // 最初の段には「前」が無い。
  frontier: seeded.map((row) => ({ url: row.url, host: row.host, lastFinishedAt: null })),
  perHostDelayMs: prepared.perHostDelayMs,
  hostParallelism: prepared.hostParallelism,
  captureFormats: capture.formats,
  signing: capture.signing,
  // 次の段と同じく `toDispatched` を通す。行の写しには対象サイト (`021`) が在るが、flow には送らない ——
  // compile の段は scripts をそのまま ts-compile-service に渡すので、知らない欄が届く
  scripts: prepared.scripts.map(toDispatched),
  // クロールごとの値。段ごとに同じ物を配る (行に固定した物)。シークレットは名前 → path と、残す名前だけ
  variables: prepared.variables,
  ...secretsForFlow(prepared.secrets),
  userAgent: prepared.userAgent,
  ...(sink && { artifactSink: sinkForCrawl(sink, crawlId) }),
});

/** 走行中の 1 本を名指す 409 の本文。 */
const busyBody = async (db: Kysely<Database>): Promise<Record<string, unknown>> => {
  // 塞いでいる 1 本を名指しする (走行中は全体で 1 本 —— `007` の部分 unique index)。
  // 止まっているなら、呼び手はこの id で `POST /api/crawls/:id/failed` を叩ける。
  // 呼び手は `can_submit` を通った後で、その許可は組織を跨いで効く (`maySubmit`) ので、
  // 他の組織のクロールの id を見せても新しく漏れるものは無い。
  const running = await db
    .selectFrom("crawls")
    .select(["id", "startedAt"])
    .where("state", "=", "running")
    .executeTakeFirst();
  return {
    error: "a crawl is already in progress",
    ...(running && { crawlId: running.id, startedAt: running.startedAt }),
  };
};

export type Launched =
  { kind: "started"; crawlId: string } | { kind: "busy"; body: Record<string, unknown> };

/** 行を足して最初の段を投げる。走行中の 1 本とぶつかれば `busy` を返す (行は残らない)。 */
export const launchCrawl = async (
  deps: LaunchDeps,
  prepared: PreparedCrawl,
  who: CrawlRequester,
): Promise<Launched> => {
  const { db, capture, sink, dispatchLevel } = deps;
  const crawlId = randomUUID();
  let seeded: SeededPage[];
  try {
    seeded = await insertCrawl(db, prepared, crawlId, who, sink);
  } catch (err) {
    if (isUniqueViolation(err, "crawls_single_active")) {
      return { kind: "busy", body: await busyBody(db) };
    }
    throw err;
  }
  dispatchLevel(firstLevel(prepared, crawlId, seeded, capture, sink));
  return { kind: "started", crawlId };
};
