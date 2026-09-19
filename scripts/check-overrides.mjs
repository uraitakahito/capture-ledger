#!/usr/bin/env node
/**
 * pnpm-workspace.yaml の `overrides` が、**まだ要るか**を見張る。
 *
 * override は、入れた理由が消えた後も黙って効き続ける。困るのは 2 つ:
 *
 *   - 誰も外さない。「mermaid が chevrotain を上げたら外す」のような条件は、人の記憶に
 *     置いた時点で忘れられる。2026-09 に調べたら、`axios` の override は何もして
 *     いなかった —— 唯一の要求元 (@openfga/sdk 0.9.7) が、もう "1.19.0" を完全一致で
 *     指定していた。
 *   - 役目を終えた override は、**将来の版上げを黙って曲げる。** 要求元が axios 2 を
 *     求めるようになっても、`axios: "^1.18.1"` が在る限り 1 系が入る。落ちるのは実行時。
 *
 * ## 線引き
 *
 * **override が要るのは、「宣言した範囲が、override の範囲と交わらない」要求元が 1 つでも
 * 在る間だけ。** たとえば chevrotain 11.1.2 は lodash-es を "4.17.23" と完全一致で指定して
 * いて、修正版の "^4.18.1" とは交わらない —— lockfile の更新では動かせないので、override が
 * 要る。交わるなら (minimatch の "^5.0.8" と "^5.0.9" のように) lockfile の更新で足り、
 * 後戻りは `audit` が止める。
 *
 * 見るのは lockfile (解決後の版) ではなく、**入っているパッケージの package.json が宣言した
 * 範囲**。override が効いている間、lockfile には override 後の版しか残らないので、lockfile
 * からは「外したらどうなるか」が読めない。
 *
 * ## 読める鍵の形
 *
 *   name: "範囲"            どこから要求されても
 *   parent>name: "範囲"     parent からの要求だけ
 *
 * それ以外 (`name@1`、`a@2>b` など版で絞る形) は、この検査には読めない。**黙って通さず、
 * 落として名指しする** —— 読めない鍵を素通りさせる検査は、見ているつもりで見ていない。
 * 足したくなったら、ここを直すこと。
 *
 *   pnpm run check:overrides        # check から自動で走る。先に pnpm install が要る
 *
 * 見つかれば終了コード 1。効いていることを見たいなら、overrides に
 * `fastify: "^5.0.0"` を足して走らせ直すこと (root の package.json の範囲と交わるので、
 * 「もう要らない」で落ちる)。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKSPACE = "pnpm-workspace.yaml";
const STORE = join(ROOT, "node_modules/.pnpm");

/** npm のパッケージ名 (scope つきも)。 */
const NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;

/** YAML の値か鍵の引用符を外す。 */
const unquote = (text) => text.replace(/^(["'])(.*)\1$/, "$2");

/**
 * `overrides:` と `packages:` の節を、行で読む。
 *
 * YAML の parser は使わない —— この repo 群の検査器は workflow や compose をテキストとして
 * 読む (scripts/check-ci-parity.mjs と同じ)。読むのは 2 空白で字下げした 1 行ずつの形だけで、
 * それ以外の書き方が来たら読めなかった行として落とす。
 */
const readSection = (lines, head) => {
  const start = lines.findIndex((l) => l === `${head}:`);
  if (start < 0) return [];
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break; // 次の top-level の鍵
    if (/^\s*(#.*)?$/.test(lines[i])) continue; // 空行とコメント
    body.push({ text: lines[i], line: i + 1 });
  }
  return body;
};

const problems = [];
const lines = readFileSync(join(ROOT, WORKSPACE), "utf8").split("\n");

const overrides = [];
for (const { text, line } of readSection(lines, "overrides")) {
  const m = /^ {2}("[^"]+"|'[^']+'|[^\s:]+):\s+("[^"]*"|'[^']*'|\S+)\s*(?:#.*)?$/.exec(text);
  if (!m) {
    problems.push(`  ${WORKSPACE}:${String(line)} を読めない: ${text.trim()}`);
    continue;
  }
  const key = unquote(m[1]);
  const forced = unquote(m[2]);
  const parts = key.split(">");
  const name = parts.at(-1);
  const parent = parts.length === 2 ? parts[0] : null;
  if (parts.length > 2 || !NAME.test(name) || (parent !== null && !NAME.test(parent))) {
    problems.push(
      `  ${WORKSPACE}:${String(line)} の鍵 "${key}" は、この検査が読める形ではない ` +
        `(読めるのは name と parent>name)。scripts/check-overrides.mjs を直すこと`,
    );
    continue;
  }
  if (semver.validRange(forced) === null) {
    problems.push(
      `  ${WORKSPACE}:${String(line)} の "${key}" の値 "${forced}" は semver の範囲ではないので、` +
        `要・不要を判定できない`,
    );
    continue;
  }
  overrides.push({ key, name, parent, forced, line });
}

if (!existsSync(STORE)) {
  console.error(`${STORE} が無い。先に pnpm install を走らせること (宣言された範囲は、入っている`);
  console.error("パッケージの package.json から読む)。");
  process.exit(1);
}

/**
 * 入っている全パッケージと workspace 自身の manifest。同じ name@version は 1 度だけ。
 *
 * `own` は workspace 自身 (root と `packages:` の下) の印。devDependencies を数えるのは
 * こちらだけ —— 入れた依存の devDependencies は install されないので、要求元にならない。
 */
const manifests = () => {
  const found = new Map();
  const add = (file, own) => {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // package.json を持たない入れ物や、壊れたものは対象外
    }
    if (typeof pkg.name !== "string") return;
    found.set(`${pkg.name}@${String(pkg.version)}`, { pkg, own });
  };
  add(join(ROOT, "package.json"), true);
  for (const { text } of readSection(lines, "packages")) {
    const dir = unquote(text.replace(/^\s*-\s*/, "").trim());
    add(join(ROOT, dir, "package.json"), true);
  }
  for (const entry of readdirSync(STORE)) {
    const modules = join(STORE, entry, "node_modules");
    if (!existsSync(modules)) continue;
    for (const first of readdirSync(modules)) {
      if (first.startsWith(".")) continue;
      const dirs = first.startsWith("@")
        ? readdirSync(join(modules, first)).map((second) => join(first, second))
        : [first];
      for (const dir of dirs) add(join(modules, dir, "package.json"), false);
    }
  }
  return [...found.values()];
};

/**
 * peerDependencies は数えない。peer は親が入れた版を借りるだけで、自分では何も入れない
 * —— override の範囲と交わらない peer は「要る理由」ではなく、別の不整合。
 */
const FIELDS = ["dependencies", "optionalDependencies"];

const all = overrides.length > 0 ? manifests() : [];
const kept = [];
for (const override of overrides) {
  const users = [];
  for (const { pkg, own } of all) {
    if (override.parent !== null && pkg.name !== override.parent) continue;
    for (const field of own ? [...FIELDS, "devDependencies"] : FIELDS) {
      const range = pkg[field]?.[override.name];
      if (typeof range === "string") {
        users.push({ who: `${pkg.name}@${String(pkg.version)}`, range });
      }
    }
  }
  const unreadable = users.filter((u) => semver.validRange(u.range) === null);
  const stuck = users.filter(
    (u) => semver.validRange(u.range) !== null && !semver.intersects(u.range, override.forced),
  );
  const listed = users.map((u) => `${u.who} → "${u.range}"`).join("、");
  if (users.length === 0) {
    problems.push(
      `  ${override.key}: "${override.forced}" は、もう要らない —— ${override.name} を要求している` +
        `パッケージが 1 つも無い`,
    );
  } else if (stuck.length === 0 && unreadable.length === 0) {
    problems.push(
      `  ${override.key}: "${override.forced}" は、もう要らない —— 要求元の範囲は全部、` +
        `この範囲と交わる (${listed})。\n` +
        `      lockfile の更新で足りる。外して pnpm install し、audit が緑のままなことを見ること`,
    );
  } else {
    const reason = [...stuck, ...unreadable].map((u) => `${u.who} → "${u.range}"`).join("、");
    kept.push(`  ${override.key}: "${override.forced}" —— まだ要る (${reason})`);
  }
}

if (problems.length > 0) {
  console.error(`${WORKSPACE} の overrides に、直すものが在る:\n`);
  for (const p of problems) console.error(p);
  console.error(
    `\n── ${String(problems.length)} 件。役目を終えた override は、黙って版を縛り続ける。`,
  );
  process.exit(1);
}

for (const line of kept) console.log(line);
console.log(`✓ overrides: ${String(overrides.length)} 本とも、まだ要る`);
