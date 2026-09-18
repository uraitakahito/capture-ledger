#!/usr/bin/env node
/**
 * `fga/model.fga` を動いている OpenFGA へ送り、固定すべき id を印字する。
 *
 * stdout には .env の行の形で 2 行だけを出す。**.env は書き換えない** —— 書き写すのは人:
 *
 *   CAPTURE_LEDGER_FGA_STORE_ID=01K...
 *   CAPTURE_LEDGER_FGA_MODEL_ID=01K...
 *
 * 端末に貼っても効かない。export されないシェル変数になるだけで、pnpm から起動する
 * node には届かない。書き写す先は .env で、stderr にその旨を添える。
 *
 * モデルの id を固定することには意味がある。認可モデルは不変で、書き込むたびに
 * 新しい id が生まれる。id を省いた client は **そのとき最も新しいもの** に対して
 * 評価するので、モデルを編集した瞬間にすべての判断が黙って変わる。環境変数を
 * 上げることが、その切り替えをコードの配備とは別の意図的な一歩にしている。
 *
 * store は 1 度作って以後は使い回す: 名前の一致する既存の store は、複製せず
 * そのまま採用するので、これを再実行しても安全。
 */
import { spawnSync } from "node:child_process";
import { guardEnv, optional } from "./env.mjs";

guardEnv();

const API_URL = optional("CAPTURE_LEDGER_FGA_API_URL", "http://localhost:8090");
const API_TOKEN = optional("CAPTURE_LEDGER_FGA_API_TOKEN", "dev-key");
const STORE_NAME = optional("CAPTURE_LEDGER_FGA_STORE_NAME", "wacz-validator");

const fga = (args) => {
  const result = spawnSync("fga", args, {
    encoding: "utf8",
    env: { ...process.env, FGA_API_URL: API_URL, FGA_API_TOKEN: API_TOKEN },
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`fga ${args.join(" ")} failed:\n${detail}`);
  }
  return result.stdout;
};

const findStore = () => {
  const listed = JSON.parse(fga(["store", "list"]));
  return (listed.stores ?? []).find((s) => s.name === STORE_NAME);
};

const store = findStore() ?? JSON.parse(fga(["store", "create", "--name", STORE_NAME]));
// `store create` は store を入れ子で返し、`store list` は平らに返す。
const storeId = store.id ?? store.store?.id;
if (!storeId) throw new Error(`could not determine store id from: ${JSON.stringify(store)}`);

const written = JSON.parse(
  fga(["model", "write", "--store-id", storeId, "--file", "fga/model.fga"]),
);
const modelId = written.authorization_model_id;
if (!modelId) throw new Error(`could not determine model id from: ${JSON.stringify(written)}`);

process.stdout.write(`CAPTURE_LEDGER_FGA_STORE_ID=${storeId}\n`);
process.stdout.write(`CAPTURE_LEDGER_FGA_MODEL_ID=${modelId}\n`);
// 印字の形が `名前=値` なので「設定された」と読み違えやすい。2026-09-19 に実際にそう
// 読んで、書き写さないまま API を起動して止まった。添え書きを stderr に出すのは、stdout を
// 2 行のまま保つため (機械で拾う使い方を汚さない)。
process.stderr.write(
  "\n↑ 印字しただけで、.env は書き換えていない。\n" +
    "  この 2 行を .env に書き写してから pnpm run api を起動すること (起動中なら起動し直す)。\n",
);
