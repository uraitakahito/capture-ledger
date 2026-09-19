/**
 * Kysely のデータベース型定義。
 *
 * Kysely の client が触るすべてのテーブルの列について、唯一の出どころ。
 * migration と seed は `Kysely<Database>` を通してこれを参照するので、
 * `insertInto` / `selectFrom` に型検査が効き、`CamelCasePlugin` が TS 側の
 * camelCase (`urlHash`) を DB 側の snake_case (`url_hash`) へ自動で写せる。
 *
 * 取り込む対象は `capture_targets` から読む (`src/data/url-source.ts`)。
 */
import type { ColumnType, Generated, GeneratedAlways } from "kysely";

export interface CaptureTargetsTable {
  // BIGSERIAL —— node-pg は精度を落とさないために int8 を `string` で返す。
  id: Generated<string>;
  url: string;
  // GENERATED ALWAYS AS (digest(url, 'sha256')) STORED —— 書き込むことはない。
  urlHash: GeneratedAlways<Buffer>;
  labels: ColumnType<string[], string[] | undefined, string[]>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  // この URL がどの組織のために撮られるか。OpenFGA の tuple で使う
  // `organization:<id>` という識別子と一致する。`004` を見ること。
  //
  // **既定値は無い** (`015` で外した)。INSERT では必ず書く —— 型でも省けないようにしてある。
  // 既定値があった頃は、書き忘れた行が誰の `fromTargets` からも見えないまま黙って残った。
  orgId: ColumnType<string, string, string>;
  createdAt: ColumnType<Date, string | undefined, never>;
  updatedAt: ColumnType<Date, string | undefined, string>;
}

/**
 * BrowserHive が実際に生んだ WACZ 1 本。運ぶのは在り処と来歴だけ ——
 * 誰が読めるかは関係であり、関係は OpenFGA に在る。
 */
export interface ArchivesTable {
  id: Generated<string>;
  taskId: string;
  correlationId: string | null;
  bucket: string;
  objectKey: string;
  sourceUrl: string;
  labels: ColumnType<string[], string[] | undefined, string[]>;
  waczComplete: boolean | null;
  /** wacz-auth の署名を持って出たか。NULL は「求めていない」。`005` を見ること。 */
  signed: boolean | null;
  /** 全文検索の索引に載せた時刻。NULL は「まだ」。`009` を見ること。 */
  indexedAt: ColumnType<Date | null, string | null | undefined, string | null>;
  capturedAt: ColumnType<Date, string, string>;
  createdAt: ColumnType<Date, string | undefined, never>;
}

/**
 * 未処理の OpenFGA への書き込み。属するアーカイブの行と同じトランザクションで
 * 記録される。`003-create-fga-outbox` を見ること。
 */
export interface FgaOutboxTable {
  // BIGSERIAL —— node-pg は精度を落とさないために int8 を `string` で返す。
  id: Generated<string>;
  // OpenFGA への書き込みリクエスト 1 つ分そのまま: `{ writes: [...] }`。
  payload: ColumnType<unknown, string, string>;
  createdAt: ColumnType<Date, string | undefined, never>;
  processedAt: ColumnType<Date | null, string | null | undefined, string | null>;
  attempts: ColumnType<number, number | undefined, number>;
  lastError: ColumnType<string | null, string | null | undefined, string | null>;
}

/** その取り込みがどの組織のために投げられたか。`004` を見ること。 */
export interface CaptureSubmissionsTable {
  taskId: string;
  correlationId: string | null;
  orgId: string;
  submittedBy: string | null;
  submittedAt: ColumnType<Date, string | undefined, never>;
  /** 結果 manifest の鍵 (bucket を除く)。段の報告が運んだもの。`014`。 */
  manifestKey: string | null;
  /** manifest を書けなかった、または台帳に読めない場所だった理由。`014`。 */
  manifestError: string | null;
}

/**
 * リンクを辿る取り込み 1 本。走行中の行は部分 unique index により高々 1 つ。`007` を見ること。
 */
export interface CrawlsTable {
  id: string;
  /** 出発点。1 本以上。範囲はこのどれかに入るかで決まる (`crawl/scope.ts`)。 */
  seeds: string[];
  scope: CrawlScope;
  maxDepth: number;
  maxPages: number;
  perHostDelayMs: number;
  hostParallelism: number;
  orgId: string;
  requestedBy: string;
  state: CrawlState;
  // 走行中は NULL。なぜ終わったかが入る。
  stopReason: ColumnType<
    CrawlStopReason | null,
    CrawlStopReason | null | undefined,
    CrawlStopReason | null
  >;
  startedAt: ColumnType<Date, string | undefined, never>;
  finishedAt: ColumnType<Date | null, string | null | undefined, string | null>;
  // 見つけた件数と取った件数は別。差が「範囲や上限で落としたぶん」。
  pagesDiscovered: ColumnType<number, number | undefined, number>;
  pagesCaptured: ColumnType<number, number | undefined, number>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * 成果物を置いた場所の接頭辞 (`org/<orgId>/<YYYY-MM>/`)。**置く側と探す側が読む
   * 唯一の出どころ。**
   *
   * 更新側が `never` なのは、後から書き換えないから —— これは設定ではなく、
   * 既に置いた場所という事実。NULL は「記録が無い」であって「平ら」ではない。
   * 詳しくは `013`。
   */
  artifactKeyPrefix: ColumnType<string | null, string | null | undefined, never>;
  /**
   * 最後に投げた段の Windmill の job と、その段の深さ。段は 1 つずつ別の run として投げられ、
   * 失敗はいつも最後に投げた段で起きるので、辿る先はこの 1 つで足りる (`016`)。
   * Windmill が id を返さなかったら NULL。
   */
  lastJobId: ColumnType<string | null, string | null | undefined, string | null>;
  lastJobDepth: ColumnType<number | null, number | null | undefined, number | null>;
}

export type CrawlState = "running" | "succeeded" | "failed";

/** どこまでを同じ範囲と見なすか。判定は `finalUrl` (リダイレクト後) に対して行う。 */
export type CrawlScope = "same-origin" | "same-host";

/** なぜ終わったか。これが無いと「全部辿った」と「上限で切った」が区別できない。 */
export type CrawlStopReason = "completed" | "max_depth" | "max_pages" | "failed";

/**
 * クロールが触った URL 1 つ。重複排除は `(crawlId, urlHash)` の unique index が持つ。`008` を見ること。
 */
export interface CrawlPagesTable {
  // BIGSERIAL —— node-pg は精度を落とさないために int8 を `string` で返す。
  id: Generated<string>;
  crawlId: string;
  url: string;
  // GENERATED ALWAYS AS (digest(url, 'sha256')) STORED —— 書き込むことはない。
  urlHash: GeneratedAlways<Buffer>;
  depth: number;
  host: string;
  state: CrawlPageState;
  // 取らなかった・取れなかった理由。`skipped` と `failed` のときに入る —— `crawl_host` は
  // 取り込みの失敗の理由もここへ入れる (名前は `skip` だが、失敗の理由の置き場でもある)。
  skipReason: ColumnType<string | null, string | null | undefined, string | null>;
  taskId: ColumnType<string | null, string | null | undefined, string | null>;
  correlationId: ColumnType<string | null, string | null | undefined, string | null>;
  discoveredFrom: ColumnType<string | null, string | null | undefined, string | null>;
  // 礼儀の証拠。この 2 つが無いと、間隔と重なりを後から測れない。
  submittedAt: ColumnType<Date | null, string | null | undefined, string | null>;
  finishedAt: ColumnType<Date | null, string | null | undefined, string | null>;
  createdAt: ColumnType<Date, string | undefined, never>;
}

export type CrawlPageState = "pending" | "captured" | "failed" | "skipped";

export interface Database {
  captureTargets: CaptureTargetsTable;
  archives: ArchivesTable;
  fgaOutbox: FgaOutboxTable;
  captureSubmissions: CaptureSubmissionsTable;
  crawls: CrawlsTable;
  crawlPages: CrawlPagesTable;
}
