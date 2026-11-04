/**
 * 合本の形 v1 を組む。**純粋な部分** —— 保管庫も DB も知らないので、どちらも立てずに確かめられる
 * (`search/document.ts` と同じ切り方)。I/O は `replay-bundle/inspect.ts` (WACZ を検める) と
 * `replay-bundle/write.ts` (版を払い出して書く)。
 *
 * 合本は、クロールの WACZ を全部並べた `replay.json` (replay の `?source=` に渡す物) と、その頁の行を全部並べた
 * `pages.json` (replay の server が `pagesQueryUrl` に答えるために読む物) の組。形の約束は replay の
 * docs/replay-bundle.md (合本の形 v1) で、両方の repo が同じ正規化の例 (`test/vectors/canonical-url.json`) で試す。
 *
 * ## 並び
 *
 * - `resources`: **起点 (深さ 0) の WACZ を先頭に**、深さ・撮った時刻の順。replay は、頁の中で見つからない物を
 *   先頭の 3 本だけ試すので、起点の頁が読む物が先頭に要る
 * - `initialPages`: 文書の行だけ、起点の頁を先頭に深さ・時刻の順で 25 行まで。replay は一覧の 1 ページ目をここから
 *   作る (問いの口は検索と 2 ページ目以降だけ)。写しの行は入れない
 * - `pages.json`: 並びの約束は無い (server が自分で引けるように持つ)。ここでは `resources` の順・行の順
 *
 * ## 記録が 0 の WACZ は外す
 *
 * `indexes/index.cdxj` が空、または BrowserHive の答えの `waczStats.totalRecorded` が 0 の WACZ (`index_empty`)。
 * replay は長さ 0 の Range を求め、保管庫の 416 で JSON を読み直し続ける。`resources` にも `pages.json` にも入れず、
 * 数だけを `replayBundle.skipped` に残す。台帳の頁の表 (`crawl_pages`) には残る。
 */
import { parseHttpUrl } from "../crawl/scope.js";
import type { PageLine } from "../search/document.js";

/** 合本の形の版。replay の docs/replay-bundle.md と対。 */
export const REPLAY_BUNDLE_VERSION = 1;

/** `initialPages` の行の数の上限。replay の一覧の 1 ページの大きさ。 */
export const INITIAL_PAGES = 25;

/**
 * 正規化。WHATWG の URL として読み、http(s) でなければ null、fragment を外して直列化した物。
 * **台帳の `parseHttpUrl` (`crawl/scope.ts`) そのもの** —— クロールが重複を落とす形と、合本が頁を引く形を
 * 1 つにする。replay の server も同じ例で試す (`test/vectors/canonical-url.json`)。
 */
export const canonicalUrl = (raw: string): string | null => parseHttpUrl(raw)?.normalized ?? null;

/**
 * 文書の行の `keys`: 頼んだ URL と、BrowserHive の答えの `document.url` (リダイレクトの後。在れば) を
 * 正規化した物。読めない物は落とし、重複は 1 つに。
 */
export const pageKeys = (requestedUrl: string, documentUrl: string | undefined): string[] => {
  const keys: string[] = [];
  for (const raw of documentUrl === undefined ? [requestedUrl] : [requestedUrl, documentUrl]) {
    const key = canonicalUrl(raw);
    if (key !== null && !keys.includes(key)) keys.push(key);
  }
  return keys;
};

/** `archive_pages` の 1 行 (`archiveId` を除く)。 */
export interface ArchivePageRow {
  ordinal: number;
  pageId: string | null;
  url: string;
  ts: string | null;
  title: string | null;
  stage: string | null;
  keys: string[];
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * `pages.jsonl` の頁の行 (`search/document.ts` の `parsePagesJsonl` が読んだ物) を、`archive_pages` の行にする。
 * `id`・`url`・`ts`・`title`・`stage` は行のまま (無ければ null)。`keys` は文書の行 (`stage` の無い行) だけ。
 */
export const archivePageRows = (
  lines: readonly PageLine[],
  documentUrl: string | undefined,
): ArchivePageRow[] =>
  lines.map((line, ordinal) => {
    const stage = typeof line.stage === "string" && line.stage !== "" ? line.stage : null;
    return {
      ordinal,
      pageId: textOrNull(line.id),
      url: line.url,
      ts: textOrNull(line.ts),
      title: textOrNull(line.title),
      stage,
      keys: stage === null ? pageKeys(line.url, documentUrl) : [],
    };
  });

/** 合本に組む前の、クロールのアーカイブ 1 本 (検めた物)。 */
export interface BundleArchive {
  id: string;
  objectKey: string;
  waczSha256: string;
  indexEmpty: boolean;
  capturedAt: Date;
  /** その取り込みの頁の深さ (`crawl_pages.depth`)。引けなければ null (並びの最後)。 */
  depth: number | null;
}

/** 合本に組む前の、頁の行 1 つ。 */
export interface BundlePage extends ArchivePageRow {
  archiveId: string;
}

export interface ReplayResource {
  name: string;
  path: string;
  hash: string;
  crawlId: string;
}

export interface InitialPage {
  id: string | null;
  url: string;
  ts: string | null;
  title: string | null;
  filename: string;
  isSeed: boolean;
  crawl_id: string;
}

export interface ReplayJson {
  title: string;
  resources: ReplayResource[];
  pagesQueryUrl: string;
  initialPages: InitialPage[];
  totalPages: number;
  /** 台帳の記録。replay は読まない (ほかの欄の名前とぶつけない)。 */
  replayBundle: {
    version: number;
    crawlId: string;
    rev: number;
    depth: number | null;
    builtAt: string;
    members: number;
    skipped: number;
  };
}

export interface PagesJsonRow {
  id: string | null;
  url: string;
  ts: string | null;
  title: string | null;
  filename: string;
  depth: number | null;
  stage: string | null;
  keys: string[];
}

export interface PagesJson {
  version: number;
  crawlId: string;
  rev: number;
  pages: PagesJsonRow[];
}

export interface ReplayBundle {
  /** 合本の置き場 (`org/<orgId>/crawls/<crawlId>/r<rev>`)。 */
  dir: string;
  replayKey: string;
  pagesKey: string;
  replayJson: ReplayJson;
  pagesJson: PagesJson;
  /** `resources` に入れたアーカイブの id (並びのまま)。 */
  members: string[];
  /** 記録が 0 で外したアーカイブの数。 */
  skipped: number;
}

/** 合本の置き場。WACZ と同じ bucket の、持ち主を言う鍵の下 (受け口の `org/<orgId>/` と同じ考え)。 */
export const replayBundleDir = (orgId: string, crawlId: string, rev: number): string =>
  `org/${orgId}/crawls/${crawlId}/r${String(rev)}`;

/** 保管庫の鍵を、origin の根からの path にする (区切りごとに百分率の符号に)。 */
const keyPath = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

/** WACZ の鍵の最後の区切り (ファイル名。`<taskId>_<crawlId>.wacz` で、クロールの中で一意)。 */
export const waczName = (objectKey: string): string =>
  objectKey.slice(objectKey.lastIndexOf("/") + 1);

/** 深さの順 (引けない深さは最後)。 */
const byDepth = (a: number | null, b: number | null): number =>
  (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY);

/** 時刻 (`ts`) の順。読めない時刻は最後。 */
const timeOf = (ts: string | null): number => {
  const time = ts === null ? Number.NaN : Date.parse(ts);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ComposeInput {
  crawlId: string;
  orgId: string;
  rev: number;
  /** flow の段の深さ。記録だけ (作り直しの道具は null)。 */
  depth: number | null;
  builtAt: Date;
  archives: readonly BundleArchive[];
  pages: readonly BundlePage[];
}

/**
 * 合本を組む。`archives` はクロールの検めたアーカイブ全部 (記録が 0 の物も)、`pages` はその頁の行。
 * 並びは問わない (ここで並べる)。
 */
export const composeReplayBundle = (input: ComposeInput): ReplayBundle => {
  const { crawlId, rev } = input;
  const dir = replayBundleDir(input.orgId, crawlId, rev);

  const recorded = input.archives.filter((archive) => !archive.indexEmpty);
  const members = [...recorded].sort(
    (a, b) =>
      byDepth(a.depth, b.depth) ||
      a.capturedAt.getTime() - b.capturedAt.getTime() ||
      byText(waczName(a.objectKey), waczName(b.objectKey)),
  );

  const rowsOf = new Map<string, BundlePage[]>();
  for (const page of input.pages) {
    const rows = rowsOf.get(page.archiveId) ?? [];
    rows.push(page);
    rowsOf.set(page.archiveId, rows);
  }

  const pages: PagesJsonRow[] = [];
  for (const archive of members) {
    const filename = waczName(archive.objectKey);
    const rows = [...(rowsOf.get(archive.id) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    for (const row of rows) {
      pages.push({
        id: row.pageId,
        url: row.url,
        ts: row.ts,
        title: row.title,
        filename,
        depth: archive.depth,
        stage: row.stage,
        // 写しの行は、DB に何が在っても空 (replay は写しを、URL の後ろの http の部分で問う)
        keys: row.stage === null ? row.keys : [],
      });
    }
  }

  // 文書の行だけ。起点 (深さ 0) を先頭に、深さ・時刻の順
  const initialPages: InitialPage[] = pages
    .filter((page) => page.stage === null)
    .sort(
      (a, b) => byDepth(a.depth, b.depth) || timeOf(a.ts) - timeOf(b.ts) || byText(a.url, b.url),
    )
    .slice(0, INITIAL_PAGES)
    .map((page) => ({
      id: page.id,
      url: page.url,
      ts: page.ts,
      title: page.title,
      filename: page.filename,
      isSeed: page.depth === 0,
      crawl_id: crawlId,
    }));

  const replayJson: ReplayJson = {
    title: `クロール ${crawlId.slice(0, 8)} の合本 r${String(rev)}`,
    resources: members.map((archive) => ({
      name: waczName(archive.objectKey),
      path: `/wacz/${keyPath(archive.objectKey)}`,
      hash: `sha256:${archive.waczSha256}`,
      crawlId,
    })),
    pagesQueryUrl: `/q/${keyPath(dir)}/pages`,
    initialPages,
    totalPages: pages.length,
    replayBundle: {
      version: REPLAY_BUNDLE_VERSION,
      crawlId,
      rev,
      depth: input.depth,
      builtAt: input.builtAt.toISOString(),
      members: members.length,
      skipped: input.archives.length - recorded.length,
    },
  };

  return {
    dir,
    replayKey: `${dir}/replay.json`,
    pagesKey: `${dir}/pages.json`,
    replayJson,
    pagesJson: { version: REPLAY_BUNDLE_VERSION, crawlId, rev, pages },
    members: members.map((archive) => archive.id),
    skipped: input.archives.length - recorded.length,
  };
};
