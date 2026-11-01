#!/usr/bin/env node
/**
 * スクリプトの CLI (`pnpm run scripts`) を、本物の Postgres に当てる。
 *
 * 試験は DB を立てない。`test/recording-db.ts` は Kysely が組んだ SQL を記録するが、その SQL が
 * Postgres で本当に通るか、版を本当に絞るか、`020` の表が本当に版を足すかは見られない。スクリプトを読む口
 * (`GET /api/scripts/:id/versions/:version` など) は CLI と同じ関数 (`readScript`・`listScripts` の id・
 * `addHostTypes`・`readHostTypes`) を呼ぶので、**それを Postgres で見るのは、ここだけ。**
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build && DATABASE_URL=postgres://… node scripts/scripts-smoke.mjs
 *
 * **向ける DB は使い捨てのものにすること。** 自分の id (`smoke-<pid>`) の行と、自分で足した受け皿の型
 * (中身に pid を書くので、ほかと重ならない) だけを足して最後に消し、ほかの行には触らないが、それでも書く。
 *
 * catalog は一時ディレクトリに書く。CI の check job は submodule を取らないので、
 * `.upstream/capture-scripts` は読めない。
 *
 * どれか 1 つでも期待と違えば、全部を並べてから終了コード 1。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = resolve(ROOT, "dist/scripts/cli.js");
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}
if (!existsSync(CLI)) {
  console.error("dist/scripts/cli.js が無い。先に pnpm run build");
  process.exit(1);
}

const id = `smoke-${String(process.pid)}`;
const imported = `${id}-import`;
// 札 (`021`) の CHECK を DB に直に当てる行。取り込みと CLI は同じ式で先に断るので、DB の守りはここでしか見えない
const sited = `${id}-site`;
// CLI で札を付けて足す 2 本 (起点で選ばれる物と、選ばれない物)
const onExample = `${id}-ex`;
const onOther = `${id}-other`;
// 宣言 (`024`) つきで取り込む 1 本。名前に `_` を含む宣言が読み返しても化けないことを見る
const withDecl = `${id}-params`;
// 中身の違う 2 本。古い版を読めたかを、中身で区別する
const A = `// ${id} の v1\nglobalThis.__bh.report("${id}", { v: 1 });\n`;
const B = `// ${id} の v2\nglobalThis.__bh.report("${id}", { v: 2 });\n`;
// pid を書くので、手元の DB に向けても、既に在る型と同じ中身にはならない
const TYPES = `// ${id}\ndeclare var __bh: { report(id: string, data: unknown): void };\n`;

const pool = new pg.Pool({ connectionString: databaseUrl });
const work = mkdtempSync(join(tmpdir(), "scripts-smoke-"));
/** 鍵の順に依らない比べ方。jsonb は object の鍵を並べ替えて持つ (短い鍵が先) ので、書いた順とは一致しない */
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
};

/** CLI を子プロセスで走らせる。接続先は旗で明示する (環境変数に頼らない)。 */
const cli = (args, input) => {
  const run = spawnSync(process.execPath, [CLI, ...args, "--database-url", databaseUrl], {
    encoding: "utf8",
    input: input ?? "",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};
/** 期待と違ったときに出す手がかり。CLI の予期しない誤りは標準出力に JSON で出るので、両方を見る。 */
const why = (run) =>
  `rc=${String(run.status)} ${(run.stderr.trim() || run.stdout.trim()).split("\n")[0].slice(0, 200)}`;
const write = (name, text) => {
  const path = join(work, name);
  writeFileSync(path, text);
  return path;
};

try {
  let run = cli(["add", id, "--file", write("a.ts", A)]);
  const first = run;
  run = cli(["add", id, "--file", write("b.ts", B)]);
  check(
    "中身の違う 2 本を足すと v1 と v2 になる",
    first.status === 0 && first.stdout.includes(`${id} v1`) && run.stdout.includes(`${id} v2`),
    `${why(first)} / ${why(run)}`,
  );

  // 021: 札を書かずに足した版の札は空。CHECK は形を見る
  const sitesOf = await pool.query("SELECT sites FROM scripts WHERE id = $1 AND version = 1", [id]);
  check(
    "021: 札を書かずに足した版の札は空",
    Array.isArray(sitesOf.rows[0]?.sites) && sitesOf.rows[0].sites.length === 0,
    JSON.stringify(sitesOf.rows),
  );
  let siteVersion = 0;
  /** 札だけを変えて 1 行足す。断られたら Postgres の誤りの code (23514 は CHECK) */
  const insertSites = (sites) =>
    pool
      .query(
        "INSERT INTO scripts (id, version, phase, source, sites) VALUES ($1, $2, 'behavior', 'x;', $3)",
        [sited, (siteVersion += 1), sites],
      )
      .then(
        () => "ok",
        (err) => String(err.code),
      );
  let said = await insertSites(["Google.com"]);
  check("021: 札の CHECK は大文字のホスト名を断る", said === "23514", said);
  said = await insertSites(["google.com:443"]);
  check("021: 札の CHECK はポートを断る", said === "23514", said);
  said = await insertSites(["xn--wgv71a.jp", "capture-fixtures.capture-ledger"]);
  check("021: 札の CHECK は punycode と開発のホスト名を通す", said === "ok", said);

  run = cli(["show", id, "--version", "1"]);
  check("show --version 1 は古い版の中身を出す", run.status === 0 && run.stdout === A, why(run));

  run = cli(["show", id]);
  check("show は版を省くと最新版の中身を出す", run.status === 0 && run.stdout === B, why(run));

  run = cli(["disable", id, "--version", "1"]);
  run = cli(["show", id, "--version", "1"]);
  check(
    "無効にした版も show --version で読める (有効かどうかは見ない)",
    run.status === 0 && run.stdout === A,
    why(run),
  );

  run = cli(["list", id, "--all", "--json"]);
  let versions = [];
  try {
    versions = JSON.parse(run.stdout);
  } catch {
    // 読めなければ空のまま
  }
  check(
    "list <id> --all --json は、その id の版だけを新しい順に、取り込んだ時刻つき・source なしで返す",
    run.status === 0 &&
      versions.map((v) => `${v.id}@${String(v.version)}`).join(",") === `${id}@2,${id}@1` &&
      versions.every((v) => typeof v.createdAt === "string" && !("source" in v)),
    `${why(run)} ${JSON.stringify(versions).slice(0, 200)}`,
  );

  run = cli(["list", id]);
  check(
    "list <id> は --all が無ければ最新版だけ",
    run.status === 0 && run.stdout.includes(`${id} v2`) && !run.stdout.includes(`${id} v1`),
    why(run),
  );

  run = cli(["show", id, "--version", "9"]);
  check(
    "無い版は終了コード 1 で、その版が無いと言う",
    run.status === 1 && run.stderr.includes(`${id} に v9 は無い`),
    why(run),
  );

  run = cli(["list", `${id}-nothing`]);
  check("名指しした id が無ければ、終了コード 1", run.status === 1, why(run));

  // import は catalog と同じ置き場所の types/host.d.ts も写す
  const dir = join(work, "capture-scripts");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "types"));
  writeFileSync(
    join(dir, "catalog.json"),
    JSON.stringify({
      profile: "capture-scripts/4",
      scripts: [
        {
          id: imported,
          phase: "behavior",
          file: "scripts/x.ts",
          summary: "smoke",
          sites: ["site.test"],
        },
      ],
    }),
  );
  writeFileSync(join(dir, "scripts", "x.ts"), A);
  writeFileSync(join(dir, "types", "host.d.ts"), TYPES);

  run = cli(["import", dir]);
  check(
    "import は受け皿の型も足す (✓ host.d.ts)",
    run.status === 0 &&
      run.stdout.includes(`✓ ${imported} v1`) &&
      /✓ host\.d\.ts v\d+/.test(run.stdout),
    why(run),
  );

  run = cli(["types"]);
  check("types は取り込んだ型をそのまま出す", run.status === 0 && run.stdout === TYPES, why(run));

  run = cli(["import", dir]);
  check(
    "もう 1 度 import しても、中身が同じなら型の版は増えない (= host.d.ts)",
    run.status === 0 && /= host\.d\.ts v\d+/.test(run.stdout),
    why(run),
  );

  const { rows } = await pool.query("SELECT count(*)::int AS n FROM host_types WHERE source = $1", [
    TYPES,
  ]);
  check("型の行は 1 つだけ", rows[0].n === 1, `行=${String(rows[0].n)}`);

  const importedSites = await pool.query("SELECT sites FROM scripts WHERE id = $1", [imported]);
  check(
    "import は catalog の札を版に入れる",
    JSON.stringify(importedSites.rows.map((row) => row.sites)) === JSON.stringify([["site.test"]]),
    JSON.stringify(importedSites.rows),
  );

  // default: false の id は、取り込むと全版が無効になる (古い版を既定に昇格させない)
  const offDir = join(work, "off-scripts");
  mkdirSync(join(offDir, "scripts"), { recursive: true });
  writeFileSync(
    join(offDir, "catalog.json"),
    JSON.stringify({
      profile: "capture-scripts/4",
      scripts: [
        {
          id: imported,
          phase: "behavior",
          file: "scripts/x.ts",
          summary: "smoke",
          sites: ["site.test"],
          default: false,
        },
      ],
    }),
  );
  writeFileSync(join(offDir, "scripts", "x.ts"), A);
  run = cli(["import", offDir]);
  check(
    "import は default: false を言う",
    run.status === 0 && run.stdout.includes("既定に入らない"),
    why(run),
  );
  const off = await pool.query("SELECT bool_or(enabled) AS any FROM scripts WHERE id = $1", [
    imported,
  ]);
  check("default: false の id は全版が無効", off.rows[0].any === false, JSON.stringify(off.rows));
  run = cli(["list", "--seed", "https://site.test/", "--json"]);
  check(
    "default: false の id は、起点に合っても既定に入らない",
    run.status === 0 && !run.stdout.includes(imported),
    why(run),
  );
  // default を省いた catalog を取り込み直すと、取り込んだ版が有効に戻る (カタログが正)
  run = cli(["import", dir]);
  const on = await pool.query("SELECT bool_or(enabled) AS any FROM scripts WHERE id = $1", [
    imported,
  ]);
  check(
    "default を省いた import で、取り込んだ版が有効に戻る",
    run.status === 0 && on.rows[0].any === true,
    JSON.stringify(on.rows),
  );

  // 札の形が悪い catalog は、1 本も足さずに断る
  const badDir = join(work, "bad-scripts");
  mkdirSync(join(badDir, "scripts"), { recursive: true });
  writeFileSync(
    join(badDir, "catalog.json"),
    JSON.stringify({
      profile: "capture-scripts/4",
      scripts: [
        {
          id: `${id}-bad`,
          phase: "behavior",
          file: "scripts/x.ts",
          summary: "smoke",
          sites: ["Site.test"],
        },
      ],
    }),
  );
  writeFileSync(join(badDir, "scripts", "x.ts"), A);
  run = cli(["import", badDir]);
  check(
    "import は札の形が悪い catalog を断る (大文字のホスト名)",
    run.status === 1 && run.stderr.includes("Site.test"),
    why(run),
  );

  // 024: 宣言 (params) は catalog から版に入り、名前の `_` は Kysely で読み返しても化けない
  const withParams = join(work, "params-scripts");
  mkdirSync(join(withParams, "scripts"), { recursive: true });
  const declared = [
    { name: "query", kind: "variable", required: false, summary: "検索語" },
    { name: "api_token", kind: "secret", required: true, summary: "鍵" },
  ];
  writeFileSync(
    join(withParams, "catalog.json"),
    JSON.stringify({
      profile: "capture-scripts/4",
      scripts: [
        {
          id: withDecl,
          phase: "behavior",
          file: "scripts/x.ts",
          summary: "smoke",
          params: declared,
        },
      ],
    }),
  );
  writeFileSync(join(withParams, "scripts", "x.ts"), A);
  run = cli(["import", withParams]);
  check(
    "024: import は宣言を版に入れ、読む値を言う",
    run.status === 0 && run.stdout.includes("値:query,api_token(秘)!"),
    why(run),
  );
  const paramsOf = await pool.query("SELECT params FROM scripts WHERE id = $1", [withDecl]);
  check(
    "024: 宣言は jsonb にそのまま入る (required を埋めた形。鍵の順は jsonb が並べ替える)",
    canonical(paramsOf.rows[0]?.params) === canonical(declared),
    JSON.stringify(paramsOf.rows),
  );
  run = cli(["list", withDecl, "--all", "--json"]);
  let listed = [];
  try {
    listed = JSON.parse(run.stdout);
  } catch {
    // 読めなければ空のまま
  }
  check(
    "024: Kysely で読み返しても宣言の名前の _ は化けない (api_token のまま。列名の plugin は jsonb の中を写さない)",
    run.status === 0 && canonical(listed[0]?.params) === canonical(declared),
    `${why(run)} ${JSON.stringify(listed).slice(0, 300)}`,
  );
  // 同じ宣言を取り込み直しても版は増えず、宣言を変えると版が増える
  run = cli(["import", withParams]);
  check(
    "024: 同じ宣言の import は版を増やさない",
    run.status === 0 && run.stdout.includes(`= ${withDecl} v1`),
    why(run),
  );
  writeFileSync(
    join(withParams, "catalog.json"),
    JSON.stringify({
      profile: "capture-scripts/4",
      scripts: [
        {
          id: withDecl,
          phase: "behavior",
          file: "scripts/x.ts",
          summary: "smoke",
          params: [declared[0]],
        },
      ],
    }),
  );
  run = cli(["import", withParams]);
  check(
    "024: 宣言を変えた import は版を足す",
    run.status === 0 && run.stdout.includes(`✓ ${withDecl} v2`),
    why(run),
  );

  // 壊れた宣言の catalog は 1 本も足さずに断る。/3 の catalog (宣言を知らない形) も断る
  const badParams = join(work, "bad-params");
  mkdirSync(join(badParams, "scripts"), { recursive: true });
  writeFileSync(
    join(badParams, "catalog.json"),
    JSON.stringify({
      profile: "capture-scripts/4",
      scripts: [
        {
          id: `${id}-badp`,
          phase: "behavior",
          file: "scripts/x.ts",
          summary: "smoke",
          params: [{ name: "q", kind: "token", summary: "x" }],
        },
      ],
    }),
  );
  writeFileSync(join(badParams, "scripts", "x.ts"), A);
  run = cli(["import", badParams]);
  check(
    "024: import は kind の違う宣言の catalog を断る",
    run.status === 1 && run.stderr.includes("kind は variable か secret"),
    why(run),
  );
  const oldProfile = join(work, "old-profile");
  mkdirSync(join(oldProfile, "scripts"), { recursive: true });
  writeFileSync(
    join(oldProfile, "catalog.json"),
    JSON.stringify({
      profile: "capture-scripts/3",
      scripts: [{ id: `${id}-old`, phase: "behavior", file: "scripts/x.ts", summary: "smoke" }],
    }),
  );
  writeFileSync(join(oldProfile, "scripts", "x.ts"), A);
  run = cli(["import", oldProfile]);
  check(
    "024: import は /3 の catalog を断る (宣言を知らない形)",
    run.status === 1 && run.stderr.includes("capture-scripts/4 ではない"),
    why(run),
  );

  // 024: CHECK を DB に直に当てる。params は配列、crawls の variables と secrets は object
  said = await pool
    .query(
      "INSERT INTO scripts (id, version, phase, source, params) VALUES ($1, 1, 'behavior', 'x;', '{}'::jsonb)",
      [`${id}-pcheck`],
    )
    .then(
      () => "ok",
      (err) => String(err.code),
    );
  check("024: scripts.params の CHECK は配列でない物を断る", said === "23514", said);
  /** クロールの行を、値の列だけ変えて 1 行足す。断られたら Postgres の誤りの code */
  const insertCrawl = (column, value) =>
    pool
      .query(
        `INSERT INTO crawls (id, seeds, rules, max_depth, max_pages, per_host_delay_ms, host_parallelism, ` +
          `org_id, requested_by, state, ${column}) ` +
          `VALUES (gen_random_uuid(), ARRAY['https://smoke.invalid/'], '[]'::jsonb, 0, 1, 0, 1, $1, $1, 'failed', $2::jsonb)`,
        [id, value],
      )
      .then(
        () => "ok",
        (err) => String(err.code),
      );
  said = await insertCrawl("variables", "[]");
  check("024: crawls.variables の CHECK は object でない物を断る", said === "23514", said);
  said = await insertCrawl("secrets", '"x"');
  check("024: crawls.secrets の CHECK は object でない物を断る", said === "23514", said);
  said = await insertCrawl("variables", '{"query":"個人情報"}');
  check(
    "024: crawls.variables は object なら通り、secrets は既定の {} で埋まる",
    said === "ok",
    said,
  );
  const crawlValues = await pool.query(
    "SELECT variables, secrets FROM crawls WHERE org_id = $1 ORDER BY started_at DESC LIMIT 1",
    [id],
  );
  check(
    "024: 値は書いた形のまま読める",
    JSON.stringify(crawlValues.rows[0]) ===
      JSON.stringify({ variables: { query: "個人情報" }, secrets: {} }),
    JSON.stringify(crawlValues.rows),
  );

  run = cli([
    "add",
    onExample,
    "--file",
    write("ex.ts", A),
    "--site",
    "site.test",
    "--site",
    "www.site.test",
  ]);
  check(
    "add --site は札つきの版を足す (何度でも書ける)",
    run.status === 0 && run.stdout.includes("札:site.test,www.site.test"),
    why(run),
  );
  run = cli(["add", onOther, "--file", write("other.ts", B), "--site", "other.test"]);
  run = cli(["add", `${id}-bad`, "--file", write("bad.ts", A), "--site", "site.test:8080"]);
  check("add --site はポートつきの札を断る", run.status === 1, why(run));

  run = cli(["list", "--seed", "http://site.test:8080/a", "--json"]);
  let chosen = [];
  try {
    chosen = JSON.parse(run.stdout).map((script) => script.id);
  } catch {
    // 読めなければ空のまま
  }
  check(
    "list --seed は札の無い物と、起点に合う物を選ぶ (ポートは見ない)",
    run.status === 0 &&
      chosen.includes(id) &&
      chosen.includes(onExample) &&
      !chosen.includes(onOther),
    `${why(run)} ${JSON.stringify(chosen).slice(0, 200)}`,
  );

  run = cli(["list", "--seed", "https://other.test/", "--json"]);
  try {
    chosen = JSON.parse(run.stdout).map((script) => script.id);
  } catch {
    chosen = [];
  }
  check(
    "list --seed は別の起点なら、その起点に合う物に入れ替わる",
    run.status === 0 && chosen.includes(onOther) && !chosen.includes(onExample),
    `${why(run)} ${JSON.stringify(chosen).slice(0, 200)}`,
  );

  run = cli(["rm", id, imported]);
  check("rm で消せる", run.status === 0, why(run));
} finally {
  await pool.query("DELETE FROM scripts WHERE id IN ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
    id,
    imported,
    sited,
    onExample,
    onOther,
    withDecl,
    `${id}-badp`,
    `${id}-old`,
    `${id}-pcheck`,
  ]);
  // 024 の CHECK を当てたクロールの行 (通った 1 行だけ残る。org_id に自分の id を書いてある)
  await pool.query("DELETE FROM crawls WHERE org_id = $1", [id]);
  await pool.query("DELETE FROM host_types WHERE source = $1", [TYPES]);
  await pool.end();
  rmSync(work, { recursive: true, force: true });
}

for (const { name, ok, detail } of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` —— ${detail}`}`);
}
const failed = results.filter((result) => !result.ok).length;
if (failed > 0) {
  console.error(`\n${String(failed)} 件が期待と違う (${String(results.length)} 件中)`);
  process.exit(1);
}
console.log(
  `✓ scripts smoke: ${String(results.length)} 件とも期待どおり (id ${id} の行と、足した型は消した)`,
);
