#!/usr/bin/env node
/**
 * capture-scheduler が置いた値を **取りに行って**、この repo の `.env.local` に写す。
 *
 *   pnpm run connect                      # ../capture-scheduler から
 *   pnpm run connect ../elsewhere         # 別の場所に clone しているとき
 *
 * ## なぜ「取りに行く」のか
 *
 * 値を決めるのは向こう (Windmill の token と、そこから組み立てた webhook の URL)。
 * だからといって **向こうのコマンドがこちらの `.env` を書き換えるのは、打った人の
 * 予想に反する**。書くのは自分の repo だけ、跨ぐときは読むだけ —— その規則の、
 * 読む側がこれ。向こうは `.dev/capture-ledger.env` に置くところまでをやる。
 *
 * ## 受け取る名前は、自分の `.env.example` が決める
 *
 * 相手のファイルをそのまま環境に流し込むと、向こうの都合でこちらの設定が変わる。
 * かといって名前の一覧をここに書き写すと、向こうが 1 行足した日に腐る。
 * **この repo の `.env.example` が宣言している名前だけを受ける** ——
 * あれは `scripts/check-env.mjs` が「コードが実際に読む名前」と突き合わせているので、
 * 写しではなく実体そのもの。知らない名前は写さずに **名指しで言う** (黙って捨てない)。
 *
 * ## 値は印字しない
 *
 * token が混じる。何が変わったかは名前で言えば足りる。
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { upsertEnvLocal } from "./env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 既定の相手。crawler の 9 つの repo は横並びに clone してある。 */
const DEFAULT_DIR = "../capture-scheduler";
/**
 * 向こうが置く場所。**capture-scheduler の scripts/env-local.ts の HANDOFF と同じ綴り**
 * でなければならない (CI は 1 つの repo しか checkout しないので、機械では確かめられない)。
 */
const HANDOFF = ".dev/capture-ledger.env";

/**
 * 表示用の path。遠くの場所を `../../../..` と書いても読めないので、
 * repo から見て素直に書けるときだけ相対にする。
 */
const shown = (path) => {
  const rel = relative(ROOT, path);
  return rel.startsWith("../..") ? path : rel;
};

const die = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const dir = process.argv[2] ?? DEFAULT_DIR;
const handoff = resolve(ROOT, dir, HANDOFF);

if (!existsSync(handoff)) {
  die(
    `引き渡しファイルがありません:\n  ${handoff}\n\n` +
      "値を決めるのは capture-scheduler なので、先に向こうで作らせること:\n" +
      `  cd ${dir} && pnpm run windmill:bootstrap\n\n` +
      `別の場所に clone しているなら、場所を渡す: pnpm run connect <capture-scheduler のパス>\n`,
  );
}

/** `NAME=VALUE` の行だけを読む。コメントと空行は飛ばす。 */
const parse = (source) => {
  const values = {};
  for (const line of source.split("\n")) {
    const match = /^\s*([A-Z_0-9]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
};

const template = resolve(ROOT, ".env.example");
if (!existsSync(template)) die(`.env.example がありません: ${template}`);
// コメント行も「宣言されている」と数える (`check-env.mjs` と同じ読み方)。
const declared = new Set(
  readFileSync(template, "utf8")
    .split("\n")
    .flatMap((line) => /^\s*#?\s*([A-Z_0-9]+)=/.exec(line)?.slice(1, 2) ?? []),
);

const incoming = parse(readFileSync(handoff, "utf8"));
const accepted = {};
const unknown = [];
for (const [name, value] of Object.entries(incoming)) {
  if (declared.has(name)) accepted[name] = value;
  else unknown.push(name);
}

if (Object.keys(accepted).length === 0) {
  die(
    `${shown(handoff)} に、この repo が読む名前がありません` +
      `${unknown.length === 0 ? " (中身が空です)" : `:\n${unknown.map((n) => `  - ${n}`).join("\n")}`}\n\n` +
      "  受けるのは .env.example が宣言している名前だけです。\n",
  );
}

const { path, added, updated } = upsertEnvLocal(accepted);
const changed = [...added, ...updated];

process.stderr.write(
  `${shown(handoff)} から ${String(Object.keys(accepted).length)} 個を読み、` +
    `${shown(path)} に書きました。\n` +
    `${
      changed.length === 0
        ? "  前と同じ値だったので、中身は変わっていません。\n"
        : `  変わった名前: ${changed.join(", ")}\n`
    }`,
);
if (unknown.length > 0) {
  process.stderr.write(
    `\n**写さなかった名前があります** (この repo の .env.example が宣言していない):\n` +
      `${unknown.map((n) => `  - ${n}`).join("\n")}\n` +
      "  capture-scheduler が新しく渡し始めた値なら、.env.example に足すこと。\n",
  );
}
process.stderr.write(
  "\n次は API を起こし直します (設定は起動のときに 1 回だけ読みます)。\n" +
    "起動ログの最後の行が「crawl level reports: ready」なら、効いています。\n",
);
