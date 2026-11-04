#!/usr/bin/env node
/**
 * 全文検索の OpenSearch が答えるのを待ち、宛先を `.env.local` に書く (dev:up の段 search-connect)。
 *
 * 全文検索は必須 (CAPTURE-53)。API は `CAPTURE_LEDGER_OPENSEARCH_URL` が無いか、OpenSearch が
 * 答えなければ起動しない。dev:up の段 search が profile search の opensearch を起こし、この段が
 * 答えを待って宛先を書く。`.env` (人のファイル) は書かない —— `fga:deploy` と `connect` と同じく
 * `.env.local` へ。
 *
 * 宛先は、`.env`・`.env.local` に在ればそれ (この script は両方を読んでから走る)、無ければ compose が
 * host に出す `http://127.0.0.1:9200`。待つのは cluster の health が yellow 以上になるまで —— 1 台なので
 * replica は割り当たらず、green にはならない (yellow で検索も索引も効く)。
 */
import { relative } from "node:path";
import { optional, upsertEnvLocal } from "./env.js";

const URL_NAME = "CAPTURE_LEDGER_OPENSEARCH_URL";
const url = optional(URL_NAME, "http://127.0.0.1:9200");
/** 冷えた OpenSearch は JVM の起動に数十秒かかる (heap 512m)。image の pull は段 search で済んでいる。 */
const WAIT_MS = 180_000;

const healthOf = async (): Promise<string | undefined> => {
  try {
    const res = await fetch(`${url}/_cluster/health?wait_for_status=yellow&timeout=5s`);
    if (!res.ok) return undefined;
    return ((await res.json()) as { status?: string }).status;
  } catch {
    return undefined;
  }
};

const ready = (status: string | undefined): boolean => status === "yellow" || status === "green";

const deadline = Date.now() + WAIT_MS;
let status = await healthOf();
while (!ready(status) && Date.now() < deadline) {
  await new Promise((done) => setTimeout(done, 2000));
  status = await healthOf();
}
if (!ready(status)) {
  process.stderr.write(
    `OpenSearch (${url}) が ${String(WAIT_MS / 1000)} 秒待っても答えない (health: ${status ?? "答えなし"})。\n` +
      "  起こすのは pnpm run stack:up --profile search opensearch (dev:up の段 search と同じ物を起こす)。\n",
  );
  process.exit(1);
}

const { path, added, updated } = upsertEnvLocal({ [URL_NAME]: url });
const changed = [...added, ...updated];
process.stdout.write(`${URL_NAME}=${url}\n`);
// 添え書きは stderr (stdout は 1 行のまま)。「書いた」ではなく「変わった」を言う —— 2 度目からは動かない。
process.stderr.write(
  `\n↑ OpenSearch は ${String(status)}。この 1 行を ${relative(process.cwd(), path)} に書いた` +
    ` (${changed.length > 0 ? `${changed.join(", ")} が変わった` : "変わっていない"})。\n` +
    "  .env は触っていない —— node は .env の後にこちらを読むので、名前が重なればこちらが勝つ。\n",
);
