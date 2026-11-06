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
  /**
   * どのクロールの取り込みか (`027`)。受けるときに入れる (`archive/admit.ts`)。NULL は 027 より前の行か、
   * クロールの外の取り込み。更新するのは作り直しの道具だけ (027 より前の行をクロールに繋ぐ)。
   */
  crawlId: ColumnType<string | null, string | null, string>;
  /** WACZ のファイル全体の sha256 (16 進の小文字)。検めたときに入る (`027`)。 */
  waczSha256: ColumnType<string | null, never, string>;
  /** WACZ の大きさ。bigint なので node-pg は文字列で返す。 */
  waczBytes: ColumnType<string | null, never, number>;
  /** 記録が 0 の WACZ (索引が空、または `waczStats.totalRecorded` が 0)。合本から外す (`027`)。 */
  indexEmpty: ColumnType<boolean | null, never, boolean>;
  /** 検めた時刻。NULL は「まだ」。検めた行は上の 3 つを必ず持つ (CHECK)。 */
  inspectedAt: ColumnType<Date | null, never, string>;
  /** その WACZ が最初に入った合本の版 (`027`)。 */
  replayBundleRev: ColumnType<number | null, never, number>;
}

/**
 * WACZ の `pages/pages.jsonl` の頁の行 1 つ (`027`)。合本の `pages.json` はここから組む。
 * 主キーは (archiveId, ordinal)。`pageId` は行の `id`。
 */
export interface ArchivePagesTable {
  archiveId: string;
  ordinal: number;
  pageId: string | null;
  url: string;
  ts: string | null;
  title: string | null;
  stage: string | null;
  /** 正規化した URL。文書の行だけが持つ (写しの行は空)。 */
  keys: ColumnType<string[], string[], never>;
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
  /** 出発点。1 本以上。起点からの範囲は、このどれかと比べて決まる (`crawl/scope.ts`)。 */
  seeds: string[];
  /**
   * どのリンクを辿り、撮り、落とすか。**上から当て、最初に当たった規則が勝つ** (`crawl/rules.ts`・`022`)。
   * 始めたときに読んだ形 (前方一致は正規化した URL) で固定し、後から書き換えない。
   *
   * 書くときは JSON の文字列 (`scripts` と同じ扱い)。
   */
  rules: ColumnType<CrawlRule[], string, never>;
  maxDepth: number;
  maxPages: number;
  perHostDelayMs: number;
  hostParallelism: number;
  orgId: string;
  requestedBy: string;
  /**
   * このクロールがページの中で走らせるもの。**解決済み・並びが実行順**で、
   * 台帳のスクリプト (`scripts`) を引き直すことはしない —— 途中で版が足されても、同じクロールの
   * 前半と後半で違うコードが走ることは無い (`018` を見ること)。
   *
   * 書くときは JSON の文字列 (`fgaOutbox.payload` と同じ扱い)。
   */
  scripts: ColumnType<CrawlScript[], string | undefined, string>;
  /**
   * 頼みで渡された変数 (名前 → 文字列。`024`)。スクリプトの宣言 (`params`) に照らして受け、行に固定する。
   * 段ごとに flow へ運ばれ、BrowserHive が WACZ の `settings.variables` に**値を書く**。
   *
   * 書くときは JSON の文字列 (`scripts` と同じ扱い)。後から書き換えない。
   */
  variables: ColumnType<Record<string, string>, string, never>;
  /**
   * 頼まれた User-Agent (`031`)。打った字のままで、`{chrome}` は解かない。`null` は「指定なし」。
   * 段ごとに flow へ運ばれる。後から書き換えない。
   */
  userAgent: ColumnType<string | null, string | null, never>;
  /**
   * 宣言で結んだシークレット (名前 → path と `edited_at`。`024`)。**値は持たない** —— 解くのは flow の
   * `crawl_host` で、台帳が持つのは Windmill の変数の path と、始めたときの更新時刻だけ。段を送るたびに読み直し、
   * 変わっていれば `rotated` を書き足す (`CrawlSecret`)。
   *
   * 書くときは JSON の文字列。
   */
  secrets: ColumnType<Record<string, CrawlSecret>, string, string>;
  state: CrawlState;
  // 走行中は NULL。なぜ終わったかが入る。
  stopReason: ColumnType<
    CrawlStopReason | null,
    CrawlStopReason | null | undefined,
    CrawlStopReason | null
  >;
  startedAt: ColumnType<Date, string | undefined, never>;
  finishedAt: ColumnType<Date | null, string | null | undefined, string | null>;
  // 撮ったページのリンクのうち規則が通した数。起点は数えないので、`pagesCaptured` との差は落とした数にならない。
  pagesDiscovered: ColumnType<number, number | undefined, number>;
  // 撮れたページの数 (起点も数える)。0 のまま締めたクロールは failed (`succeeded` は 1 枚以上撮れた行だけ)。
  pagesCaptured: ColumnType<number, number | undefined, number>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * 成果物を置いた場所の接頭辞 (`org/<orgId>/<YYYY-MM>/`)。**置く側 (受け口) が読む
   * 唯一の出どころ。** 探す側 (段の登録と reconcile) は読まない —— 報告が運んだ manifest の場所
   * (`capture_submissions.manifest_key`・`014`) を読む。
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
  /**
   * 合本の版の払い出し (`027`)。次に払い出す版で、合本を作るたびに行の更新で 1 つ進める。
   */
  replayBundleNextRev: ColumnType<number, never, number>;
  /**
   * 台帳が指す合本 (書き終えた版のうち最も大きい物) の版・`replay.json` の鍵・頁の数・書いた時刻 (`027`)。
   * **前へだけ進める** —— 書き終えた版がいまより大きいときだけ差し替える (`replay-bundle/write.ts`)。
   */
  replayBundleRev: ColumnType<number | null, never, number>;
  replayBundleKey: ColumnType<string | null, never, string>;
  replayBundlePages: ColumnType<number | null, never, number>;
  replayBundleBuiltAt: ColumnType<Date | null, never, string>;
  /** 合本を書けなかった理由。次に書けたら消す。クロールは止めない (`027`)。 */
  replayBundleError: ColumnType<string | null, never, string | null>;
  /**
   * 署名した合本の版のうち最も大きい物と、その `replay-digest.json` の鍵 (`028`)。**台帳が指す版とは別に持ち、
   * 前へだけ進める**。2 つは一緒に書く (両方 NULL か両方に値。CHECK)。
   */
  replayBundleSignedRev: ColumnType<number | null, never, number>;
  replayBundleDigestKey: ColumnType<string | null, never, string>;
  /**
   * 台帳が指す版に署名しなかった (できなかった) 理由 (`028`)。指す版と同じ UPDATE で書く。走っているクロールの版と、
   * 署名の設定が無い配備では NULL。
   */
  replayBundleSignError: ColumnType<string | null, never, string | null>;
}

/**
 * 走らせるもの 1 本。**`scripts` の行から解決した写し**で、`crawls.scripts` と、そこから
 * flow へ渡す本文に、同じ形で出る。
 *
 * `sha256` は `scripts` の生成列をそのまま運ぶ。BrowserHive が `source` と照合して、
 * 食い違えば `INVALID_ARGUMENT` で拒む —— 運ぶ途中で入れ替わっていないか、だけを見る。
 */
export interface CrawlScript {
  id: string;
  version: number;
  phase: ScriptPhase;
  source: string;
  sha256: string;
  options: Record<string, unknown>;
  /**
   * 札（どのサイト用か。`021`）。台帳のスクリプトだけが持つ写しで、その場の TS には無い。古いクロールの行にも
   * 無い（無ければ空と読む）。flow へは渡さない（`toDispatched`）—— 選ぶための物で、走らせる側には要らない。
   */
  sites?: string[];
  /**
   * 変換サービスが返した JS の sha256。段の報告 (`POST /api/crawls/:id/pages` の `compiled`) から
   * 写す (`crawl/compiled.ts`)。無ければまだ 1 段も報告が来ていない。archive の
   * `behaviors/custom.jsonl` に残る JS はこの hash の物。flow へは渡さない。
   */
  jsSha256?: string;
  /** 何で (typescript の版)・何に向けて (受け皿の型の tag) 変換したか。`jsSha256` と一緒に写す。 */
  compiledWith?: { typescript: string; hostTypes: string };
  /**
   * クロールごとの値の宣言 (`024`)。変数は始めるときに ts-compile-service が source の `defineParams` から読んだ物、
   * シークレットは `scripts.params` か頼みの `inline.params` の写し (`crawl/values.ts` の `pinDeclarations`)。
   * 古い行には無いことがある。flow へは渡さない (`toDispatched`)。
   */
  params?: ScriptParam[];
}

/** クロールごとの値の種類。`variable` は記録に値が残り、`secret` は名前しか残らない。 */
export type ParamKind = "variable" | "secret";

/** 変数の値の JSON Schema。鍵はこの 4 つだけ (capture-scripts の宣言の読み手が書ける物)。 */
export interface ParamSchema {
  type: "string";
  minLength?: number;
  maxLength?: number;
  enum?: string[];
}

/**
 * スクリプトが読む、クロールごとの値の宣言 1 つ (`024`)。capture-scripts の catalog.json の `params` と同じ形。
 * `name` は `^[a-z][a-z0-9_]*$` で 64 字まで (`scripts/store.ts` の `VALUE_NAME`)。**既定値は持たない** ——
 * 既定値はソースの中にだけ在り、省かれた値をスクリプトは `undefined` と読む。
 */
export interface ScriptParam {
  name: string;
  kind: ParamKind;
  /** 無ければ `POST /api/crawls` が 400 で止める。省けば false。 */
  required: boolean;
  /** 人に見せる 1 行。catalog では空にできない。その場の TS では省ける。 */
  summary?: string;
  /** 値の形。`variable` だけが持つ (シークレットの値を台帳は見ない)。 */
  schema?: ParamSchema;
}

/**
 * クロールの行に固定したシークレット 1 つ (`crawls.secrets` の値。鍵は名前)。**値は持たない** —— 持つのは
 * Windmill の変数の path (`f/waggle_secrets/<名前>`) と、始めたときの `edited_at`。段を送るたびに読み直し、
 * 変わっていれば `rotated` に、気づいた段の深さと新しい時刻を書く (もう 1 度変われば書き換える)。
 */
export interface CrawlSecret {
  path: string;
  /** Windmill が答えた更新時刻。答えに無ければ null。 */
  editedAt: string | null;
  rotated: { depth: number; editedAt: string | null } | null;
}

/**
 * どちらの口から入れるか。BrowserHive の 2 つの注入口にそのまま対応する。
 *
 * `behavior` は読み込みの後・主フレーム・1 回で、受け皿を通して報告できる。
 * `preload` は遷移の**前**・iframe を含む全フレーム・遷移のたびに走り、報告できない。
 */
export type ScriptPhase = "preload" | "behavior";

/**
 * ページの中で走らせるスクリプト。`017` を見ること。
 *
 * BrowserHive は顔ぶれを持たないので、**ここが「何を走らせるか」の唯一の出どころ**。
 */
export interface ScriptsTable {
  id: string;
  version: number;
  phase: ScriptPhase;
  source: string;
  // GENERATED ALWAYS AS (encode(digest(source, 'sha256'), 'hex')) STORED —— 書くことはない。
  sha256: GeneratedAlways<string>;
  options: ColumnType<Record<string, unknown>, string | undefined, string>;
  /** 札（どのサイト用か。`021`）。空ならどこでも走る。小文字のホスト名で、CHECK が形を見る */
  sites: ColumnType<string[], string[] | undefined, string[]>;
  /**
   * クロールごとの値の宣言 (`024`)。版の一部で、変えたら版を足す (`options`・`sites` と同じ)。
   * 書くときは JSON の文字列 (`options` と同じ扱い)。
   */
  params: ColumnType<ScriptParam[], string | undefined, string>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * 既定の実行順 (`029`)。小さいほど先。版ではなく id の性質で、全部の版に同じ値を持つ (`enabled` と同じく
   * カタログが正)。カタログに無い物は既定の 1000。
   */
  position: ColumnType<number, number | undefined, number>;
  createdAt: ColumnType<Date, string | undefined, never>;
}

/**
 * 受け皿 `__bh` の型の写し（読む人に見せる物）。`020` を見ること。
 *
 * 走る JS の型を決めるのは ts-compile-service の pin で、ここではない。
 */
export interface HostTypesTable {
  version: number;
  source: string;
  // GENERATED ALWAYS AS (encode(digest(source, 'sha256'), 'hex')) STORED —— 書くことはない。
  sha256: GeneratedAlways<string>;
  createdAt: ColumnType<Date, string | undefined, never>;
}

export type CrawlState = "running" | "succeeded" | "failed";

/** 規則の動き。撮って辿る・撮るだけ・落とす。 */
export type CrawlRuleAction = "follow" | "capture" | "skip";

/**
 * 規則 1 本。**鍵が 1 つの object** で、鍵が動き、値が当てる物 (`{ "skip": "ads.example.com" }`)。
 * 当てる物の読み方は `crawl/rules.ts` の `parsePattern`。
 */
export type CrawlRule = { follow: string } | { capture: string } | { skip: string };

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
  /**
   * 取り込みのログの level ごとの行の数と、残さなかった行の数 (`025`)。`.result.json` の `log` から写す。
   * NULL は「この行の取り込みの `.result.json` から数を読んでいない」—— 理由は列に残さない。
   * 書くときは JSON の文字列 (`crawls.variables` と同じ扱い)。
   */
  logCounts: ColumnType<LogCounts | null, string | null | undefined, string | null>;
}

/** 取り込みのログの数 (`crawl_pages.log_counts`・`025`)。`log.counts` の 4 つに `log.dropped` を足した物。 */
export interface LogCounts {
  debug: number;
  info: number;
  warn: number;
  error: number;
  dropped: number;
}

export type CrawlPageState = "pending" | "captured" | "failed" | "skipped";

/**
 * 規則でリンクをどう決めたか。段 × 規則 × ホスト名で 1 行 (`023`)。
 *
 * 数えるのは**その段で見つけた、別々の URL** で、同じ段の報告をやり直しても置き換えるだけなので増えない。
 * 撮るだけのページのリンクは見ていないので、ここには来ない。
 */
export interface CrawlDecisionsTable {
  crawlId: string;
  /** リンク先の深さ (見つけたページの深さ + 1)。 */
  depth: number;
  /** 当たった規則の番号。1 から数え、0 はどれにも当たらなかった (落とした)。 */
  rule: number;
  action: CrawlRuleAction;
  /** リンク先のホスト名。**ポートは外す** —— ドメインの規則も、ドメインで引く口も、ホスト名で照らす。 */
  hostname: string;
  /** 別々の URL の数。1 以上。 */
  links: number;
  /** 例の URL。見つけた順に `SAMPLES` 本まで (`crawl/decisions.ts`)。 */
  samples: string[];
}

/**
 * 派生の層 (`026`)。Claude が作った物を、証拠と分けて残す。いまの `kind` は `fix` だけ。
 * `usd` は numeric なので、node-pg は文字列で返す。
 */
export interface DerivationsTable {
  id: string;
  kind: "fix";
  orgId: string;
  crawlId: string | null;
  target: ColumnType<Record<string, unknown>, string, string>;
  inputSha256: string;
  model: string;
  promptVersion: string;
  effort: string;
  rounds: number;
  output: ColumnType<Record<string, unknown>, string, string>;
  usage: ColumnType<Record<string, unknown>, string, string>;
  usd: ColumnType<string, string, never>;
  createdBy: string;
  createdAt: ColumnType<Date, string | undefined, never>;
}

export interface Database {
  captureTargets: CaptureTargetsTable;
  archives: ArchivesTable;
  archivePages: ArchivePagesTable;
  fgaOutbox: FgaOutboxTable;
  captureSubmissions: CaptureSubmissionsTable;
  crawls: CrawlsTable;
  crawlPages: CrawlPagesTable;
  crawlDecisions: CrawlDecisionsTable;
  scripts: ScriptsTable;
  hostTypes: HostTypesTable;
  derivations: DerivationsTable;
}
