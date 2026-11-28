/**
 * 写しと絵の時点の名 (CAPTURE-506)。**古い名を知るのは、この file だけ。**
 *
 * BrowserHive は BrowserHive WARC Profile 1.8.0・BrowserHive WACZ Profile 1.30.0 から、capture scripts の後の時点を
 * `after-capture-scripts` と書く。それより前の取り込みは `after-behaviors` と書いた。撮った物 (WACZ・`.result.json`) は
 * 書き換えないので、古い名はこの先も読み続ける。
 *
 * 決まり: 読む関数 (`pages.jsonl` の `parsePagesJsonl`・`.result.json` の `readManifest`・絵の在り処の
 * `locateStageScreenshots`) が、読んだ直後に新しい名に寄せる。capture-ledger の中 (DB の値・API の答え・検索の文書の id) は
 * 新しい名だけを扱う。DB の古い値は `049` が新しい名に書き換えた。
 *
 * 寄せないのは、記録の中の URI (`urn:browserhive:snapshot:after-behaviors:…`・`urn:browserhive:screenshot:after-behaviors:…`)。
 * これは撮った物の字で、`archive_pages.url` にもそのまま入っている。URI の頭を照らす所は {@link recordStageNames} で
 * 古い名の頭も受ける。
 */

/** Capture scripts の後の時点。 */
export const CAPTURE_SCRIPTS_STAGE = "after-capture-scripts";

/** BrowserHive WACZ Profile 1.30.0 より前の、同じ時点の名。 */
const LEGACY_CAPTURE_SCRIPTS_STAGE = "after-behaviors";

/** 読んだ時点の名を、capture-ledger の中で使う名にする。古い名だけを替え、ほかはそのまま返す。 */
export const normalizeStage = (stage: string): string =>
  stage === LEGACY_CAPTURE_SCRIPTS_STAGE ? CAPTURE_SCRIPTS_STAGE : stage;

/** その時点の記録の URI に現れうる名。新しい名には、古い取り込みが書いた名も足す。 */
export const recordStageNames = (stage: string): readonly string[] => {
  const normalized = normalizeStage(stage);
  return normalized === CAPTURE_SCRIPTS_STAGE
    ? [CAPTURE_SCRIPTS_STAGE, LEGACY_CAPTURE_SCRIPTS_STAGE]
    : [normalized];
};
