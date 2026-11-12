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
import { recipeDigestOf } from "./recipe-digest.js";
import {
  findRequest,
  forgetOldRequests,
  type RememberedRequest,
  type RequestKey,
} from "./request-key.js";

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
   * 段の鍵 (CAPTURE-180)。段の行 (`crawl_levels.job_id`) を作るときに乱数で決めた値で、**Windmill の job の id
   * でもある** —— webhook に `?job_id=` で付けるので、同じ段を送り直しても Windmill は 2 本目を作らない
   * (在る id は 400 `already exists`)。flow は `level_key` の引数で受け、段の報告の `Idempotency-Key` と
   * fail_crawl の本文にそのまま返す。
   */
  levelKey: string;
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
   * 解くのは flow の `crawl_host` で、BrowserHive に送る直前に読む。capture-ledger・webhook・WACZ が持つのは名前と path だけ。
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
 * flow へ渡す形は変えない。報告で写した JS の hash と変換の記録は capture-ledger の物で、
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

/** その場の送り直しの間 (ms)。初回の後、この順に待って送り直す (計 3 回)。 */
export const LEVEL_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000];
/** 投げる係の時計の間隔。受け取りを確かめられない段を、同じ `job_id` で送り直す。 */
export const LEVEL_TICK_INTERVAL_MS = 30_000;
/** 段の行を作ってからこれだけ経っても受け取られなければ、諦めてクロールを failed で締める。 */
export const LEVEL_GIVE_UP_MS = 10 * 60_000;

export interface LevelDeps {
  db: Kysely<Database>;
  dispatch: CrawlDispatcher;
  writeReplayBundle: ReplayBundleWriter;
  /** 受け取り先の設定。時計が段の行の args から送り直すとき、受け取り先の印を作り直す (行には残さない) */
  sink?: SinkConfig;
  /** その場の送り直しの間。試験だけが縮める */
  retryDelaysMs?: readonly number[];
  now?: () => Date;
}

/** 投げる係。`server.ts` が 1 つ作り、クロールのエンドポイントと定期実行の周回と時計が分け合う。 */
export type LevelDispatcher = ReturnType<typeof levelDispatcher>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Windmill が送り直しても同じ答えで断った (flow の path・トークン・引数の誤り)。`dispatch.ts` が 4xx (408・429 と
 * 「同じ id が在る」の 400 を除く) で投げる。投げる係は 10 分待たずに段を諦めてクロールを締める。
 */
export class DispatchRefused extends Error {}
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 段の行を「投げる前」で足す (`038`)。`db` はトランザクションでもよい —— 最初の段は `crawls` の行と、次の段は
 * 前の段を報告済みにするのと同じトランザクションで足す。行が在れば、API が投げる前に落ちても時計が送る。
 *
 * 時計が最初に見るのは 30 秒後 (その間は、その場の送り直しに任せる)。
 */
export const insertLevel = async (
  db: Kysely<Database>,
  level: DispatchedCrawl,
  now = new Date(),
): Promise<void> => {
  // **受け取り先の印 (bearer) は残さない。** 送り直すときに投げる係が作り直す (期限も新しくなる)
  const stored: Omit<DispatchedCrawl, "artifactSink"> = { ...level };
  delete (stored as Partial<DispatchedCrawl>).artifactSink;
  await db
    .insertInto("crawlLevels")
    .values({
      crawlId: level.crawlId,
      depth: level.depth,
      jobId: level.levelKey,
      state: "pending",
      args: JSON.stringify(stored),
      nextAttemptAt: new Date(now.getTime() + LEVEL_TICK_INTERVAL_MS).toISOString(),
    })
    .execute();
};

/** 段を投げる係と、締めた後に合本を書く係。どちらも行の状態を書くので、同じ物に置く。 */
export const levelDispatcher = ({
  db,
  dispatch,
  writeReplayBundle,
  sink,
  retryDelaysMs = LEVEL_RETRY_DELAYS_MS,
  now = () => new Date(),
}: LevelDeps) => {
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
   * 1 回送る。**片が付いたら true** —— 受け取られた (段を「受け取り確認済み」に) か、送り直しても同じ答えの断りで
   * 段を諦めた。**受け取られたかが分からなければ「投げた」にして
   * false** —— 時間切れでも Windmill は job を作っているかもしれないが、同じ `job_id` で送り直せば、在れば 400
   * (`already exists`) で受け取り扱い、無ければ作られる。2 本にはならない。
   *
   * 状態を進めるのは投げる前・投げたの行だけ。報告が先に届いた段 (報告中・報告済み) と、締めた段は戻さない。
   */
  const sendOnce = async (level: DispatchedCrawl): Promise<boolean> => {
    const { crawlId, depth } = level;
    let jobId: string | undefined;
    try {
      jobId = await dispatch(level);
    } catch (err) {
      // **送り直しても同じ答えの断り** (flow の path・トークン・引数の誤り)。10 分待たずに締める ——
      // 以前と同じく、設定の誤りはその場でクロールの誤りとして見える
      if (err instanceof DispatchRefused) {
        log.error({ err, crawlId, depth }, "Windmill refused a level");
        await abandon(crawlId, depth, err.message);
        return true;
      }
      log.warn({ err, crawlId, depth }, "Could not confirm that Windmill took a level");
      await db
        .updateTable("crawlLevels")
        .set((eb) => ({
          state: "sent",
          attempts: eb("attempts", "+", 1),
          lastError: messageOf(err).slice(0, 2000),
          sentAt: eb.fn.coalesce("sentAt", eb.val(now().toISOString())).$castTo<string | null>(),
          nextAttemptAt: new Date(now().getTime() + LEVEL_TICK_INTERVAL_MS).toISOString(),
        }))
        .where("crawlId", "=", crawlId)
        .where("depth", "=", depth)
        .where("state", "in", ["pending", "sent"])
        .execute();
      return false;
    }
    const at = now().toISOString();
    await db
      .updateTable("crawlLevels")
      .set((eb) => ({
        state: "accepted",
        attempts: eb("attempts", "+", 1),
        sentAt: eb.fn.coalesce("sentAt", eb.val(at)).$castTo<string | null>(),
        acceptedAt: at,
      }))
      .where("crawlId", "=", crawlId)
      .where("depth", "=", depth)
      .where("state", "in", ["pending", "sent"])
      .execute();
    // 起こした job の id を `last_job_*` に残す (`016`)。失敗したクロールから、その run へ 1 回で辿れるように。
    // **深さが戻る書き込みはしない** —— 段の報告は速いので、前の段の id が次の段の id の後に届くことがありうる。
    await db
      .updateTable("crawls")
      .set({ lastJobId: jobId ?? level.levelKey, lastJobDepth: depth })
      .where("id", "=", crawlId)
      .where((eb) => eb.or([eb("lastJobDepth", "is", null), eb("lastJobDepth", "<=", depth)]))
      .execute();
    return true;
  };

  /**
   * 段を 1 つ Windmill へ投げる。**待たない** —— この Promise の行き先は段の行とクロールの行で、応答ではない。
   *
   * その場で 3 回 (初回と、2 秒・4 秒の後)。それでも受け取りを確かめられなければ、時計 (`tick`) が同じ `job_id` で
   * 送り直し続け、段の行を作ってから 10 分で諦めてクロールを締める (CAPTURE-180)。以前は 1 回の失敗で締めていたが、
   * webhook の時間切れでも Windmill は flow を走らせていることがあり、締めた行の上で flow が走った。
   */
  const dispatchLevel = (level: DispatchedCrawl): void => {
    void (async () => {
      if (await sendOnce(level)) return;
      for (const ms of retryDelaysMs) {
        await sleep(ms);
        if (!(await stillUnsent(level))) return;
        if (await sendOnce(level)) return;
      }
      log.warn(
        { crawlId: level.crawlId, depth: level.depth },
        "Windmill did not take a level; the level clock keeps resending",
      );
    })().catch((err: unknown) => {
      log.error({ err, crawlId: level.crawlId, depth: level.depth }, "Could not record a dispatch");
    });
  };

  /**
   * 段を諦め、走行中のクロールを failed で締める。締めたら終わった状態の合本を書く (CAPTURE-61)。
   *
   * **段の行とクロールの行を 1 つのトランザクションで。** 段がまだ投げる前・投げたのときだけ締める ——
   * 読んだ後に報告が届いて段を取っていたら (Windmill は受け取っていた)、締めない。2 つを別々に書くと、間で API が
   * 落ちたとき「締めた段・走行中のクロール」が残り、誰も次の段を作らず、走行中の 1 本の index が後を全部塞ぐ。
   */
  async function abandon(crawlId: string, depth: number, error: string): Promise<void> {
    const closed = await db.transaction().execute(async (trx) => {
      const given = await trx
        .updateTable("crawlLevels")
        .set({ state: "abandoned" })
        .where("crawlId", "=", crawlId)
        .where("depth", "=", depth)
        .where("state", "in", ["pending", "sent"])
        .returning("depth")
        .executeTakeFirst();
      if (given === undefined) return false;
      const rows = await trx
        .updateTable("crawls")
        .set({
          state: "failed",
          stopReason: "failed",
          finishedAt: now().toISOString(),
          error,
        })
        .where("id", "=", crawlId)
        // **走行中のものだけ** (`/failed` と同じ)。先に締めた者の理由を上書きしない
        .where("state", "=", "running")
        .returning("id")
        .execute();
      return rows.length > 0;
    });
    if (closed) await bundleAfterClose(crawlId);
  }

  /** まだ投げる前・投げたか (その場の送り直しの間に、時計か報告が先に進めていないか)。 */
  const stillUnsent = async (level: DispatchedCrawl): Promise<boolean> => {
    const row = await db
      .selectFrom("crawlLevels")
      .select("state")
      .where("crawlId", "=", level.crawlId)
      .where("depth", "=", level.depth)
      .executeTakeFirst();
    return row !== undefined && (row.state === "pending" || row.state === "sent");
  };

  /**
   * 時計の 1 回。受け取りを確かめられない段 (投げる前・投げた) を同じ `job_id` で送り直し、10 分経った段は諦めて
   * クロールを締める。API を起こし直した後の、投げる前の段もここが送る (段の行が送る段そのもの `args` を持つ)。
   * 締めたクロールの段は送らずに「締めた」にする。期限の切れた始める要求の鍵もここで消す (`crawl_requests`)。
   */
  const tick = async (): Promise<{ sent: number; abandoned: number }> => {
    const at = now();
    await forgetOldRequests(db, at);
    const rows = await db
      .selectFrom("crawlLevels")
      .innerJoin("crawls", "crawls.id", "crawlLevels.crawlId")
      .select([
        "crawlLevels.crawlId",
        "crawlLevels.depth",
        "crawlLevels.args",
        "crawlLevels.attempts",
        "crawlLevels.lastError",
        "crawlLevels.createdAt",
        "crawls.state as crawlState",
      ])
      .where("crawlLevels.state", "in", ["pending", "sent"])
      .where("crawlLevels.nextAttemptAt", "<=", at)
      .orderBy("crawlLevels.createdAt")
      .execute();
    let sent = 0;
    let abandoned = 0;
    for (const row of rows) {
      if (row.crawlState !== "running") {
        await db
          .updateTable("crawlLevels")
          .set({ state: "abandoned" })
          .where("crawlId", "=", row.crawlId)
          .where("depth", "=", row.depth)
          .where("state", "in", ["pending", "sent"])
          .execute();
        continue;
      }
      if (at.getTime() - new Date(row.createdAt).getTime() >= LEVEL_GIVE_UP_MS) {
        log.error(
          { crawlId: row.crawlId, depth: row.depth, attempts: row.attempts },
          "Gave up dispatching a level",
        );
        await abandon(
          row.crawlId,
          row.depth,
          `Windmill did not take level ${String(row.depth)} within 10 minutes ` +
            `(${String(row.attempts)} tries): ${row.lastError ?? "no answer"}`,
        );
        abandoned += 1;
        continue;
      }
      // 受け取り先の印は行に残していないので、作り直して載せる (期限も新しく)
      await sendOnce(
        sink ? { ...row.args, artifactSink: sinkForCrawl(sink, row.crawlId) } : row.args,
      );
      sent += 1;
    }
    return { sent, abandoned };
  };

  return { bundleAfterClose, dispatchLevel, tick };
};

/** 投げる係の時計 (`changes/worker.ts` の `changeClock` と同じ形)。定期実行の時計とは別に、自前で回る。 */
export const levelClock = (
  levels: Pick<LevelDispatcher, "tick">,
  intervalMs = LEVEL_TICK_INTERVAL_MS,
): { start: () => void; stop: () => Promise<void> } => {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const run = (): void => {
    if (running !== undefined) return;
    running = levels
      .tick()
      .then(
        (result) => {
          if (result.sent > 0 || result.abandoned > 0)
            log.info(result, "Level clock resent levels");
        },
        // **周回の例外で API を落とさない。** 送れなかった段は次の周回が拾い直す
        (err: unknown) => {
          log.error({ err }, "Level clock tick failed");
        },
      )
      .finally(() => {
        running = undefined;
      });
  };
  return {
    start() {
      timer = setInterval(run, intervalMs);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
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
    // クロールごとの値。変数は値ごと、シークレットは path と更新時刻だけ (値は capture-ledger を通らない)
    variables: JSON.stringify(prepared.variables),
    secrets: JSON.stringify(prepared.secrets),
    // 打った字のまま。解いた字は WACZ の settings.userAgent に残る
    userAgent: prepared.userAgent === "" ? null : prepared.userAgent,
    // 撮り方の digest (`035`)。前回からの変化が「同じ撮り方の前の回」を引く鍵。行の列から埋め直す道具と同じ関数
    recipeSha256: recipeDigestOf({
      scripts: prepared.scripts,
      variables: prepared.variables,
      userAgent: prepared.userAgent,
      secretNames: Object.keys(prepared.secrets),
    }),
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
 * 行と起点のページと、最初の段の行 (`038`) を足し、最初の段を返す (投げるのは呼ぶ側。commit の後に)。`db` は
 * トランザクションでもよい —— 3 つが同じトランザクションに入れば、API が投げる前に落ちても、段の行から時計が送る。
 * **走行中の 1 本とぶつかると投げる** (`crawls_single_active`)。呼ぶ側が読み替える。
 */
export const insertCrawl = async (
  db: Kysely<Database>,
  prepared: PreparedCrawl,
  crawlId: string,
  who: CrawlRequester,
  capture: CaptureSettings,
  sink: SinkConfig | undefined,
  mark?: ScheduleMark,
): Promise<DispatchedCrawl> => {
  const seeded = await insertCrawlRows(db, prepared, crawlId, who, sink, mark);
  const level = firstLevel(prepared, crawlId, seeded, capture, sink);
  await insertLevel(db, level);
  return level;
};

const insertCrawlRows = async (
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
  levelKey: string = randomUUID(),
): DispatchedCrawl => ({
  crawlId,
  depth: 0,
  levelKey,
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
  | { kind: "started"; crawlId: string }
  | { kind: "busy"; body: Record<string, unknown> }
  /** 同じ鍵の要求が先に始めていた (同時に届いた 2 本の後ろ)。覚えている答えを返す。 */
  | { kind: "remembered"; request: RememberedRequest };

/**
 * 行を足して最初の段を投げる。走行中の 1 本とぶつかれば `busy` を返す (行は残らない)。
 *
 * 鍵 (`request`。CAPTURE-180) があれば、**鍵の行を先に**、`crawls` の行と起点のページと同じトランザクションで
 * 入れる。同じ鍵が同時に来たら、後ろは鍵の主キーの待ちで前の commit を待ち、前の答えを読む ——
 * `crawls` の行を先にすると、後ろは走行中の 1 本の index で待ち、409 を返してしまう。
 * 走行中で断られたら鍵の行も残らない (409 は覚えない)。
 */
export const launchCrawl = async (
  deps: LaunchDeps,
  prepared: PreparedCrawl,
  who: CrawlRequester,
  request?: RequestKey,
): Promise<Launched> => {
  const { db, capture, sink, dispatchLevel } = deps;
  const crawlId = randomUUID();
  let level: DispatchedCrawl;
  try {
    level = await db.transaction().execute(async (trx) => {
      if (request) {
        await trx
          .insertInto("crawlRequests")
          .values({
            orgId: who.orgId,
            key: request.key,
            requestSha256: request.sha256,
            crawlId,
            answer: JSON.stringify({ crawlId }),
          })
          .execute();
      }
      return insertCrawl(trx, prepared, crawlId, who, capture, sink);
    });
  } catch (err) {
    if (isUniqueViolation(err, "crawls_single_active")) {
      return { kind: "busy", body: await busyBody(db) };
    }
    if (request && isUniqueViolation(err, "crawl_requests_pkey")) {
      const remembered = await findRequest(db, who.orgId, request.key);
      if (remembered) return { kind: "remembered", request: remembered };
    }
    throw err;
  }
  dispatchLevel(level);
  return { kind: "started", crawlId };
};
