#!/usr/bin/env node
/**
 * スタックの `openfga-db` に対して OpenFGA のスキーマ migration を走らせる。
 *
 * これは 1 回きりのジョブで、container-compose のサブコマンドは 4 つしかない
 * (up / down / build / version) —— サービスとして表現する方法が無い。`openfga` の
 * イメージは distroless なので、seaweedfs のように entrypoint で shell の再試行
 * ループを回すこともできない。だから `container run` で呼ぶ形でここに置いている。
 * wacz-validator が 1 回きりのイメージを動かしているのと同じやり方。
 *
 * これが成功するまで、`openfga` サービスはすべてのリクエストに 500 を返す
 * (/healthz も含む) —— migration していないデータベースに対しても起動自体は
 * 成功し、テーブルに触った時点で初めて失敗する。
 *
 * 冪等: 既に migration 済みのデータベースに対して再実行しても何も起きないので、
 * セットアップのスクリプトからも CI からも安全に呼べる。
 */
import { spawnSync } from "node:child_process";
import { guardEnv, optional } from "./env.js";

guardEnv();

const IMAGE = optional("CAPTURE_LEDGER_FGA_IMAGE", "docker.io/openfga/openfga:v1.10.2");
const URI = optional(
  "CAPTURE_LEDGER_FGA_DATASTORE_URI",
  "postgres://openfga:openfga@openfga-db.capture-ledger:5432/openfga?sslmode=disable",
);

/** 試行回数 × 間隔で、まだ initdb 中の冷えた `openfga-db` を待ち切れるようにする。 */
const ATTEMPTS = 30;
const DELAY_MS = 1000;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const result = spawnSync(
    "container",
    [
      "run",
      "--rm",
      IMAGE,
      "migrate",
      // 環境変数ではなくフラグで渡す: container-compose は Docker の link 形式の
      // 変数 (`openfga-db` サービスに対する OPENFGA_DB_*) を注入し、それを OpenFGA の
      // viper 設定が拾って読み違える —— 環境変数で与えた `--datastore-engine` が
      // データベースのコンテナの IP アドレスに解決された。フラグのほうが勝つ。
      "--datastore-engine=postgres",
      `--datastore-uri=${URI}`,
    ],
    { encoding: "utf8" },
  );

  if (result.status === 0) {
    process.stdout.write("openfga migrate: ok\n");
    process.exit(0);
  }

  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (attempt === ATTEMPTS) {
    process.stderr.write(`openfga migrate failed after ${ATTEMPTS} attempts:\n${detail}\n`);
    process.exit(1);
  }
  process.stdout.write(`openfga migrate: attempt ${attempt} failed, retrying...\n`);
  sleep(DELAY_MS);
}
