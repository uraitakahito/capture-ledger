#!/usr/bin/env node
/**
 * 撮る対象の CLI (`pnpm run targets`) を、本物の Postgres に当てる。
 *
 * 試験は DB を立てない。`test/recording-db.ts` は Kysely が組んだ SQL を記録するが、その SQL が
 * Postgres で本当に通るか、`015` の制約 (組織の既定値なし・URL の CHECK・組織ごとのユニーク) が
 * 本当に効くかは見られない。**それを見るのは、ここだけ。**
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build && DATABASE_URL=postgres://… node scripts/targets-smoke.mjs
 *
 * **向ける DB は使い捨てのものにすること。** 自分の組織 (`smoke-<pid>`) の行だけを足して最後に
 * 消し、ほかの行には触らないが、それでも書く。
 *
 * どれか 1 つでも期待と違えば、全部を並べてから終了コード 1。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = resolve(ROOT, "dist/targets/cli.js");
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}
if (!existsSync(CLI)) {
  console.error("dist/targets/cli.js が無い。先に pnpm run build");
  process.exit(1);
}

const org = `smoke-${String(process.pid)}`;
const otherOrg = `${org}-b`;
const pool = new pg.Pool({ connectionString: databaseUrl });
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
const count = async (where, params = []) => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM capture_targets WHERE ${where}`,
    params,
  );
  return Number(rows[0].n);
};
const ours = () => count("org_id IN ($1, $2)", [org, otherOrg]);
const idOf = async (url) => {
  const { rows } = await pool.query(
    "SELECT id FROM capture_targets WHERE org_id = $1 AND url = $2",
    [org, url],
  );
  return rows[0]?.id;
};
/** 生の INSERT が断られるか。トランザクションの中で走らせ、通ってしまっても必ず戻す。 */
const rejects = async (sql, params, expected) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql, params);
    return { ok: false, detail: "通ってしまった" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: message.includes(expected), detail: message };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
};

try {
  let run = cli(["add", "https://example.com/", "https://example.org/docs", "--org", org]);
  check("2 件足せる", run.status === 0 && (await ours()) === 2, why(run));

  run = cli(["add", "https://example.com/", "--org", org]);
  check(
    "すでに在る URL は足さない",
    run.status === 0 && run.stdout.includes("すでに在る") && (await ours()) === 2,
    why(run),
  );

  run = cli(["add", "https://example.net/", "example.org", "--org", org]);
  check(
    "読めない URL が混ざれば、1 件も足さずに名指しする",
    run.status === 1 && run.stderr.includes("example.org") && (await ours()) === 2,
    why(run),
  );

  run = cli(["add", "https://example.com/", "--org", otherOrg]);
  check(
    "同じ URL を別の組織の対象にできる (ユニークは組織ごと)",
    run.status === 0 && (await count("org_id = $1", [otherOrg])) === 1,
    why(run),
  );

  run = cli(["add", "-", "--org", org], "# 手元の一覧\r\nhttps://example.edu/\r\n\r\n");
  check("標準入力から足せる", run.status === 0 && (await ours()) === 4, why(run));

  const id = await idOf("https://example.com/");
  run = cli(["disable", String(id)]);
  const disabled = await count("id = $1 AND NOT enabled", [id]);
  run = cli(["add", "https://example.com/", "--org", org]);
  check(
    "無効にした行を add すると、有効に戻る",
    disabled === 1 &&
      run.stdout.includes("有効に戻した") &&
      (await count("id = $1 AND enabled", [id])) === 1,
    why(run),
  );

  run = cli(["list", "--org", org, "--json"]);
  let listed = -1;
  try {
    listed = JSON.parse(run.stdout).length;
  } catch {
    // 読めなければ -1 のまま
  }
  check(
    "list --json は、その組織の行を JSON で返す",
    run.status === 0 && listed === 3,
    `件数=${String(listed)}`,
  );

  const before = await count("true");
  run = cli(["add", "https://example.info/"]);
  check("--org なしでは足さない", run.status === 1 && (await count("true")) === before, why(run));

  run = cli(["rm", String(id), "999999999"]);
  check(
    "見つからない id が混ざる rm は、何も消さない",
    run.status === 1 && (await count("id = $1", [id])) === 1,
    why(run),
  );

  run = cli(["rm", String(id)]);
  check("rm で消せる", run.status === 0 && (await count("id = $1", [id])) === 0, why(run));

  // `015` の制約。CLI を通さない生の INSERT でも守られていること。
  let raw = await rejects(
    "INSERT INTO capture_targets (url) VALUES ('https://example.com/raw')",
    [],
    'null value in column "org_id"',
  );
  check("組織を書かない生の INSERT は断られる (既定値が無い)", raw.ok, raw.detail);
  raw = await rejects(
    "INSERT INTO capture_targets (url, org_id) VALUES ('example.org', $1)",
    [org],
    "capture_targets_url_http_check",
  );
  check("scheme 無しの生の INSERT は断られる (CHECK)", raw.ok, raw.detail);
} finally {
  await pool.query("DELETE FROM capture_targets WHERE org_id IN ($1, $2)", [org, otherOrg]);
  await pool.end();
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
  `✓ targets smoke: ${String(results.length)} 件とも期待どおり (組織 ${org} の行は消した)`,
);
