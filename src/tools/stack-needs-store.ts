#!/usr/bin/env node
/**
 * `scripts/stack.sh up` の preflight が呼ぶ。引数 (`container-compose up` に渡す物) と `docker-compose.yml` から、
 * 共有の保管庫を確かめるかを決め、1 行で答える:
 *
 *   check<TAB>理由   確かめる
 *   skip<TAB>理由    飛ばしてよい
 *
 * 判断は `stack-store.ts`。stack.sh は、この道具が無い・落ちた・知らない答えのときも確かめる。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./root.js";
import { decideStoreCheck } from "./stack-store.js";

const decision = decideStoreCheck(
  process.argv.slice(2),
  readFileSync(join(ROOT, "docker-compose.yml"), "utf8"),
);
console.log(`${decision.check ? "check" : "skip"}\t${decision.reason}`);
