/**
 * 試験のための、節目のスクリーンショットを持つ WACZ。BrowserHive と同じ形に組む: WARC はレコードごとに gzip の
 * member を分け (`data-NNN.browserhive.warc.gz`)、ZIP には stored で入れる。`datapackage.json` の
 * `browserhive:capture.screenshots[]` と、索引 (`indexes/index.cdxj`) の `<url> <14 桁> {…}` の行を添える。
 *
 * 絵の前に応答のレコードを 1 つ置くので、絵の `offset` は 0 でない (位置の数え違いが見える)。
 */
import { gzipSync } from "node:zlib";
import { storedZip, type ZipOptions } from "./zip.js";

/** WebP の頭を持つ、短いバイト列。`isWebp` が通す。 */
export const webpBytes = (fill: string, size = 64): Buffer => {
  const body = Buffer.alloc(size - 12, fill);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(size - 8, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
};

/** WARC のレコード 1 つを、BrowserHive と同じ直列化で (見出し・空行・block・CRLF CRLF)。 */
export const warcRecord = (headers: Readonly<Record<string, string>>, block: Buffer): Buffer => {
  const lines = ["WARC/1.1", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  return Buffer.concat([
    Buffer.from(`${lines.join("\r\n")}\r\nContent-Length: ${String(block.length)}\r\n\r\n`, "utf8"),
    block,
    Buffer.from("\r\n\r\n", "latin1"),
  ]);
};

export interface Shot {
  stage: string;
  /** 文書の URL。絵の url は `urn:browserhive:screenshot:<stage>:<この URL>`。 */
  documentUrl: string;
  date: string;
  record: string;
  picture: Buffer;
  /** 置き場の WARC の名前 (既定は data-000)。 */
  warc?: string;
  /** レコードの見出しを差し替える (名指しの絵でないレコードを作るため)。 */
  headers?: Readonly<Record<string, string>>;
}

export interface Skipped {
  stage: string;
  skipped: string;
}

export const shotUrl = (stage: string, documentUrl: string): string =>
  `urn:browserhive:screenshot:${stage}:${documentUrl}`;

/**
 * 絵と、残さなかった時点を持つ WACZ。`screenshots` を null にすると、欄そのものが無い (v30.2.0 より前の形)。
 * 索引の行は絵ごとに 1 本で、並びは `indexOrder` (既定は渡した順)。
 */
export const screenshotWacz = (
  screenshots: readonly (Shot | Skipped)[] | null,
  options: {
    indexOrder?: readonly number[];
    zip?: ZipOptions;
    dropIndexFor?: readonly string[];
    /** `datapackage.json` を丸ごと差し替える (形の壊れた項目を作るため)。 */
    datapackage?: unknown;
  } = {},
): Buffer => {
  const warcs = new Map<string, Buffer[]>();
  const append = (name: string, member: Buffer): number => {
    const list = warcs.get(name) ?? [];
    const offset = list.reduce((sum, m) => sum + m.length, 0);
    list.push(member);
    warcs.set(name, list);
    return offset;
  };
  // 絵の前の応答 (offset を 0 にしない)
  append(
    "data-000.browserhive.warc.gz",
    gzipSync(
      warcRecord(
        { "WARC-Type": "response", "WARC-Target-URI": "http://site.test/" },
        Buffer.from("hello"),
      ),
    ),
  );
  const lines: string[] = [];
  for (const item of screenshots ?? []) {
    if (!("picture" in item)) continue;
    const url = shotUrl(item.stage, item.documentUrl);
    const warc = item.warc ?? "data-000.browserhive.warc.gz";
    const member = gzipSync(
      warcRecord(
        item.headers ?? {
          "WARC-Type": "resource",
          "WARC-Record-ID": `<${item.record}>`,
          "WARC-Date": item.date,
          "WARC-Target-URI": url,
          "Content-Type": "image/webp",
        },
        item.picture,
      ),
    );
    const offset = append(warc, member);
    if (options.dropIndexFor?.includes(item.stage) === true) continue;
    const ts = item.date.replace(/[-:T]/g, "").slice(0, 14);
    lines.push(
      `${url} ${ts} ${JSON.stringify({ url, mime: "image/webp", length: String(member.length), offset: String(offset), filename: warc })}`,
    );
  }
  const ordered =
    options.indexOrder === undefined ? lines : options.indexOrder.map((i) => lines[i] ?? "");
  const datapackage = {
    "browserhive:capture": {
      build: { version: "31.1.0" },
      ...(screenshots !== null && {
        screenshots: screenshots.map((item) =>
          "picture" in item
            ? {
                stage: item.stage,
                url: shotUrl(item.stage, item.documentUrl),
                date: item.date,
                record: item.record,
                bytes: item.picture.length,
              }
            : { stage: item.stage, skipped: item.skipped },
        ),
      }),
    },
  };
  const entries: Record<string, string | Buffer> = {
    "datapackage.json": JSON.stringify(options.datapackage ?? datapackage),
    "indexes/index.cdxj": `${ordered.join("\n")}\n`,
    "pages/pages.jsonl": `${JSON.stringify({ format: "json-pages-1.0", id: "pages" })}\n`,
  };
  for (const [name, members] of warcs) entries[`archive/${name}`] = Buffer.concat(members);
  return storedZip(entries, options.zip);
};
