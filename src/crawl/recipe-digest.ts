/**
 * 撮り方の digest (`crawls.recipe_sha256`。CAPTURE-167)。前回からの変化は、同じ予定・同じ撮り方の回どうしだけを比べる。
 *
 * **ページの中身を変えうる物だけを入れる。** スクリプト (id・版・phase・sha256・options)、変数の値、User-Agent、宣言した
 * シークレットの名前 (値は capture-ledger を通らない。文字の中では BrowserHive が `***` に置き換える)。起点・規則・
 * `maxDepth`・`maxPages`・間隔・並列の数は入れない —— 組はページの URL で作るので、撮るページの数や礼儀が変わっても
 * 同じページは比べられる。BrowserHive の版も入れない (上げた翌朝の回が「初回」になってしまう。版は `archives` に
 * 残し、差分の見出しに出す)。乱数を控えるか (`recordRandom`) も入れない —— 控える物は頁の JS が受け取った値を変えずに
 * 写すだけで、ページの中身を変えない。入れると、控えを頼み始めた回と前の回が組にならず、変化が「初回」に戻る。
 *
 * 新しいクロールの行 (`crawl/launch.ts` の `crawlValues`) と、行の列から埋め直す道具 (`changes:backfill`) が同じ関数を
 * 使う。鍵の並びは JSON の中まで揃えるので、jsonb から読み戻した物でも同じ値になる。
 */
import { createHash } from "node:crypto";

import type { CrawlScript } from "../db/database.js";

/** digest の形の版。入れる物を変えたら上げる (古い回とは組にならなくなる)。 */
export const RECIPE_DIGEST_VERSION = 1;

export interface RecipeParts {
  scripts: readonly Pick<CrawlScript, "id" | "version" | "phase" | "sha256" | "options">[];
  variables: Readonly<Record<string, string>>;
  /** 打った字のまま。指定なしは `""` (行では NULL)。 */
  userAgent: string;
  /** 宣言したシークレットの名前。並びは問わない。 */
  secretNames: readonly string[];
}

/** 鍵を並べ替えた JSON。配列の並びは保つ (スクリプトの並びは実行順なので意味がある)。 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const recipeDigestOf = (parts: RecipeParts): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        v: RECIPE_DIGEST_VERSION,
        scripts: parts.scripts.map((s) => ({
          id: s.id,
          version: s.version,
          phase: s.phase,
          sha256: s.sha256,
          options: s.options,
        })),
        variables: parts.variables,
        userAgent: parts.userAgent,
        secrets: [...parts.secretNames].sort(),
      }),
    )
    .digest("hex");
