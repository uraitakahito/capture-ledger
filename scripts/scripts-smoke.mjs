#!/usr/bin/env node
/**
 * 目録の CLI (`pnpm run scripts`) を、本物の Postgres に当てる。
 *
 * 試験は DB を立てない。`test/recording-db.ts` は Kysely が組んだ SQL を記録するが、その SQL が
 * Postgres で本当に通るか、版を本当に絞るか、`020` の表が本当に版を足すかは見られない。目録を読む口
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
// 中身の違う 2 本。古い版を読めたかを、中身で区別する
const A = `// ${id} の v1\nglobalThis.__bh.report("${id}", { v: 1 });\n`;
const B = `// ${id} の v2\nglobalThis.__bh.report("${id}", { v: 2 });\n`;
// pid を書くので、手元の DB に向けても、既に在る型と同じ中身にはならない
const TYPES = `// ${id}\ndeclare var __bh: { report(id: string, data: unknown): void };\n`;

const pool = new pg.Pool({ connectionString: databaseUrl });
const work = mkdtempSync(join(tmpdir(), "scripts-smoke-"));
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
      profile: "capture-scripts/1",
      scripts: [{ id: imported, phase: "behavior", file: "scripts/x.ts", summary: "smoke" }],
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

  run = cli(["rm", id, imported]);
  check("rm で消せる", run.status === 0, why(run));
} finally {
  await pool.query("DELETE FROM scripts WHERE id IN ($1, $2)", [id, imported]);
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
