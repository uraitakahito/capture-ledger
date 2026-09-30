/**
 * `pages.jsonl` の行を、索引に載せる 1 件へ写す。**純粋な部分**。
 *
 * ここだけが「何を索引するか」を決めている。S3 も OpenSearch も知らないので、
 * どちらも立てずに確かめられる —— `archive/admit.ts` の `archiveRow` を
 * 切り出してあるのと同じ理由。
 *
 * ## 本文は既に抽出されている
 *
 * BrowserHive が `pages/pages.jsonl` に `title` と `text` を書いている
 * (browserhive の storage/wacz/pages.ts)。`text` の出どころは `document.body.innerText` ——
 * **描画後の本文**であって HTML ではない。だからここで解析する必要が無いし、
 * すべきでもない: HTML から起こし直すと、アーカイブが署名して主張している内容と
 * 索引が食い違いうる。
 *
 * ## 「本文が無い」と「本文を出さなかった」を潰さない
 *
 * `textWithheld` は、ページから作るものを伏せた申告で、値は BrowserHive の `DocumentWithheld`
 * （`url-policy`・`content-type`・`no-archive`・`deny`・`unattributed`）。
 * これを捨てて `text` の有無だけを見ると、**取り込みが空だった**のと**保存するなと言われた**のが、
 * 同じ見た目になる。前者は調べるべき異常で、後者は正常な運用。
 * BrowserHive が 2 つを分けている以上、こちらで畳まない。
 *
 * `textTruncated` も同じ。100 万文字で切られた本文を「全文」として索引に載せると、
 * 「その語はこのページに無い」と言えなくなる。
 */

/** `pages.jsonl` の 1 行。BrowserHive の `PagesLineInput` に対応する。 */
export interface PageLine {
  id?: string;
  url: string;
  ts?: string;
  title?: string;
  text?: string;
  textTruncated?: boolean;
  textWithheld?: string;
}

/** 索引に載せる 1 件。 */
export interface SearchDocument {
  /** 台帳の archive id。**認可の単位はこれ** —— 検索の結果はこの id で `can_view` を訊く。 */
  archiveId: string;
  url: string;
  title: string;
  text: string;
  /** 本文が上限で切られたか。`false` は「全文」の主張になる。 */
  textTruncated: boolean;
  /** 方針が本文を落とした理由。落としていなければ `null`。 */
  textWithheld: string | null;
  /** 台帳が持つ来歴。ヒットから replay へ渡すのに要る。 */
  objectKey: string;
  sourceUrl: string;
  labels: string[];
  capturedAt: string;
}

/** 索引の元になる台帳の行。 */
export interface ArchiveRow {
  id: string;
  objectKey: string;
  sourceUrl: string;
  labels: string[];
  capturedAt: Date;
}

/**
 * `pages.jsonl` を解析する。**1 行目のヘッダは落とす。**
 *
 * WACZ の `pages.jsonl` は 1 行目が `{"format":"json-pages-1.0","id":"pages",
 * "title":"All Pages"}` というヘッダで、ページではない。載せると「All Pages」が
 * 検索に出る。
 *
 * 見分けるのは **`url` を持つかどうか**。`format` の有無で見ないのは、あちらは
 * 形式の版であって「ページかどうか」ではないため —— 版が上がると判定が壊れる。
 * ページには必ず URL がある。
 *
 * 壊れた行は飛ばす。1 行の破損で WACZ 1 本ぶんを落とさない。
 */
export const parsePagesJsonl = (raw: string): PageLine[] => {
  const pages: PageLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const url = (parsed as { url?: unknown }).url;
    if (typeof url !== "string" || url === "") continue;
    pages.push(parsed as PageLine);
  }
  return pages;
};

/**
 * ページ 1 つと台帳の行から、索引の 1 件を組む。
 *
 * `text` と `title` は無ければ空文字にする —— `undefined` を送ると OpenSearch 側で
 * 「その field が無い」になり、`exists` の問い合わせが「まだ索引していない」と
 * 区別できなくなる。**空であることは、無いことと違う。**
 */
export const searchDocument = (page: PageLine, archive: ArchiveRow): SearchDocument => ({
  archiveId: archive.id,
  url: page.url,
  title: page.title ?? "",
  text: page.text ?? "",
  textTruncated: page.textTruncated === true,
  textWithheld: typeof page.textWithheld === "string" ? page.textWithheld : null,
  objectKey: archive.objectKey,
  sourceUrl: archive.sourceUrl,
  labels: archive.labels,
  capturedAt: archive.capturedAt.toISOString(),
});
