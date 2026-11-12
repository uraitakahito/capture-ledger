/**
 * 1 ページの `.links.json` を保管庫から読み、規則を当てる。段の報告 (`api/crawls.ts`) と、前のクロールの埋め直し
 * (`crawl/links-backfill-cli.ts`) が同じ物を使う —— 読むか読まないかの決まりが 2 か所に分かれると、同じクロールに
 * 違う行を残す。
 */
import type { S3Client } from "@aws-sdk/client-s3";

import { getJsonObject } from "../archive/s3.js";
import { pageLinks, takeLinksFrom, type CompiledRule, type PageLink } from "./rules.js";
import { parseHttpUrl, type DiscoveredLink, type ParsedUrl } from "./scope.js";

export type PageLinksRead =
  /** 読んだ。リンクが 0 本でも、読んだことに変わりはない。 */
  | { kind: "links"; links: PageLink[] }
  /** 読まないページ (撮るだけの先・外へ跳ばされた先)。`.links.json` は在っても見ない。 */
  | { kind: "unread" }
  /** 保管庫に無い・読めない形。 */
  | { kind: "missing" };

/**
 * `linksLocation` (`s3://bucket/key`) の指す `.links.json` を読む。
 *
 * **リンク元が「撮って辿る」でなければ、そのページのリンクは見ない** —— 撮るだけの先は辿らない。links はどの
 * ページでも取る (`capture-formats.ts`) ので撮るだけのページにも在るが、取って読まない。
 *
 * **リダイレクトの後のページでも決める。** 頼んだ URL が辿る範囲でも、外へ跳ばされた先は辿るページではない ——
 * 読むと、撮るだけのはずの外のページのリンクが次の段に入る。`finalUrl` は BrowserHive が links の JSON に必ず
 * 書く (無い古い形なら頼んだ URL で決める)。
 *
 * bucket はこちらの設定を使う —— 報告に入っていた bucket を信じると、報告する側が読み先を選べることになる。
 */
export const readPageLinks = async (
  source: { s3: S3Client; bucket: string },
  page: { url: string; linksLocation: string },
  rules: readonly CompiledRule[],
  seeds: readonly ParsedUrl[],
): Promise<PageLinksRead> => {
  const from = parseHttpUrl(page.url);
  if (from === undefined || !takeLinksFrom(from, rules, seeds)) return { kind: "unread" };
  const key = page.linksLocation.replace(/^s3:\/\/[^/]+\//, "");
  const raw = await getJsonObject(source.s3, source.bucket, key);
  if (raw === null || typeof raw !== "object") return { kind: "missing" };
  const finalUrl = (raw as { finalUrl?: unknown }).finalUrl;
  if (typeof finalUrl === "string") {
    const landed = parseHttpUrl(finalUrl);
    if (landed === undefined || !takeLinksFrom(landed, rules, seeds)) return { kind: "unread" };
  }
  const parsed = (raw as { links?: unknown }).links;
  if (!Array.isArray(parsed)) return { kind: "missing" };
  const links: DiscoveredLink[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as DiscoveredLink).href === "string"
    ) {
      links.push(item as DiscoveredLink);
    }
  }
  return { kind: "links", links: pageLinks(links, rules, seeds) };
};
