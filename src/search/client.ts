/**
 * OpenSearch の client と、索引の形。
 *
 * ## 解析器は組み込みの `cjk`
 *
 * 日本語をまともに引くには形態素解析が要る、というのは正しい。ただし kuromoji は
 * `opensearch-plugin install analysis-kuromoji` が要り、**既製イメージでは動かない**
 * —— compose に自前の Dockerfile が 1 つ増える。
 *
 * `cjk` は Lucene 組み込みの bigram で、プラグインを足さずに済む。切り方は
 * kuromoji に劣るが、**後から替えられる**: 索引を消して `009` のとおり
 * `UPDATE archives SET indexed_at = NULL` を打てば作り直せるので、この判断は安い。
 * 高い判断だけを先に固めておく必要は無い。
 *
 * ## `_id` はアーカイブの id と時点
 *
 * 同じアーカイブを二度索引しても増えない (`document.ts` の `searchDocumentId`)。
 * `indexed_at` が守っているのは無駄な往復であって、重複ではない —— **列を消しても
 * 索引は壊れない**ようにしてある。
 */
import { Client } from "@opensearch-project/opensearch";
import type { SearchConfig } from "../config/env.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "search-client" });

export const createSearchClient = (config: SearchConfig): Client =>
  new Client({ node: config.url });

/**
 * 索引が無ければ作る。あれば何もしない。
 *
 * mapping を先に置くのは、置かないと OpenSearch が最初のドキュメントから型を
 * 推測するため —— `text` が `keyword` として建つと、部分一致が一切効かなくなる
 * (そして**エラーは出ない**)。
 *
 * **在る索引の mapping は直さない。** 欄や解析器を変えたら、索引を消してから作り直す
 * (docs の「索引を作り直す」)。消さずに載せ直すと、新しい欄の型は OpenSearch が推測する。
 */
export const ensureIndex = async (client: Client, index: string): Promise<void> => {
  const exists = await client.indices.exists({ index });
  if (exists.body === true) return;

  await client.indices.create({
    index,
    body: {
      mappings: {
        properties: {
          // 認可の単位。検索の後にこの id で `can_view` を訊く。
          archiveId: { type: "keyword" },
          // 行の時点 (`after-load`・`after-behaviors`)。完全一致で絞るための物。
          stage: { type: "keyword" },
          // 引く対象は題と本文だけ。URL は完全一致で絞るためのもので、
          // 分かち書きすると「同じホストの別ページ」まで当たる。
          url: { type: "keyword" },
          title: { type: "text", analyzer: "cjk" },
          text: { type: "text", analyzer: "cjk" },
          textTruncated: { type: "boolean" },
          textWithheld: { type: "keyword" },
          objectKey: { type: "keyword" },
          sourceUrl: { type: "keyword" },
          labels: { type: "keyword" },
          capturedAt: { type: "date" },
        },
      },
    },
  });
  log.info({ index }, "search index created");
};
