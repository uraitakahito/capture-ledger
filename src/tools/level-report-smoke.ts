#!/usr/bin/env node
/**
 * 段の報告の「ページを閉じる」と「帰属を書く」が 1 つのトランザクションであることを、本物の Postgres と本物の
 * route (`registerCrawlRoutes`) に当てる (t-e5bz)。
 *
 * 試験 (`test/routes-crawl-levels.test.ts`) は SQL を組むだけで流さないので、begin と commit の並びまでしか見られない。
 * **Postgres が本当に両方を戻すか**と、同じ段の鍵で報告し直すと通るかを見るのは、ここだけ。
 *
 *   1. 帰属の INSERT が落ちる (自分の組織の行だけで例外を投げる trigger を一時に張る) → 500。ページは閉じておらず
 *      task_id も無い・帰属の行も無い (両方とも残らない)・段の期限は手放されている
 *   2. trigger を外し、同じ鍵で同じ報告をもう 1 度 → 200。ページは閉じ、帰属の行が在る
 *   3. もう 1 度 → 最初の答えが返り、帰属の行は増えない
 *
 * 1 つ目が通らない (ページだけ閉じて task_id が残る) なら、2 つの書き込みが別々に戻っている。
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build:tools && DATABASE_URL=postgres://… node dist/tools/level-report-smoke.js
 *
 * 向ける DB は使い捨ての物にすること。走行中のクロールは 1 本しか置けない (`crawls_single_active_idx`) ので、
 * 走っているクロールの在る DB では最初の INSERT で止まる。自分の組織 (`smoke-<pid>`) の、クロール 1 本とその
 * ページ・段・帰属だけを足して、最後に消す (trigger と関数も)。どれか 1 つでも期待と違えば、全部を並べてから
 * 終了コード 1。
 */
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { sql } from "kysely";

import { registerCrawlRoutes, type CrawlRouteDeps } from "../api/crawls.js";
import { parseCaptureFormats } from "../config/capture-formats.js";
import { createKyselyClient } from "../db/kysely.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

const db = createKyselyClient(databaseUrl);
const org = `smoke-${String(process.pid)}`;
const crawlId = randomUUID();
const levelKey = randomUUID();
const taskId = randomUUID();
const seed = "https://site.test/hub";
// 識別子に使うので pid だけを足す (数字)
const fn = sql.raw(`level_report_smoke_fail_${String(process.pid)}`);
const trigger = sql.raw(`level_report_smoke_fail_${String(process.pid)}`);

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
registerCrawlRoutes(app, {
  db,
  fga: { check: () => Promise.resolve({ allowed: true }) },
  resolveIdentity: () => Promise.resolve({ subject: "smoke", organizations: [org] }),
  dispatch: () => Promise.resolve(undefined),
  // 深さ 0 で終わるクロールなので次の段は無い。締めた後の合本も書かない
  levels: { bundleAfterClose: () => Promise.resolve(), dispatchLevel: () => undefined },
  // 報告は manifest を書けなかったと言うので、保管庫は読まない
  s3: {},
  bucket: "smoke",
  capture: parseCaptureFormats("wacz", false),
  writeReplayBundle: () => Promise.resolve(undefined),
} as unknown as CrawlRouteDeps);
await app.ready();

const report = () =>
  app.inject({
    method: "POST",
    url: `/api/crawls/${crawlId}/pages`,
    headers: { "idempotency-key": levelKey },
    payload: {
      depth: 0,
      compiled: { typescript: "6.0.3", hostTypes: "v0.2.0", scripts: [] },
      results: [
        {
          url: seed,
          status: "captured",
          taskId,
          manifestError: "level-report-smoke: no manifest",
        },
      ],
    },
  });

const page = async () =>
  (
    await sql<{ state: string; taskId: string | null }>`
      select state, task_id from crawl_pages where crawl_id = ${crawlId} and url = ${seed}`.execute(
      db,
    )
  ).rows[0];
const submissions = async () =>
  (
    await sql<{ n: number }>`
      select count(*)::int as n from capture_submissions where task_id = ${taskId}`.execute(db)
  ).rows[0]?.n;

try {
  await sql`
    insert into crawls (id, seeds, rules, max_depth, max_pages, per_host_delay_ms, host_parallelism, org_id,
      requested_by, state, started_at)
    values (${crawlId}, ${[seed]}, '[{"follow":"same-origin"}]', 0, 1, 0, 1, ${org}, 'smoke',
      'running', now())`.execute(db);
  await sql`
    insert into crawl_pages (crawl_id, url, depth, host, state)
    values (${crawlId}, ${seed}, 0, 'site.test', 'pending')`.execute(db);
  await sql`
    insert into crawl_levels (crawl_id, depth, job_id, state, args)
    values (${crawlId}, 0, ${levelKey}, 'accepted', '{}')`.execute(db);

  // ── 1. 帰属の INSERT を落とす ───────────────────────────────────────────
  await sql`
    create function ${fn}() returns trigger language plpgsql as $$
    begin
      -- ページの行がもう閉じて見える時だけ落とす。同じトランザクションの中で先に閉じていれば見え、その後の
      -- rollback でページが pending に戻る。帰属を先に別の文で書く形 (ページを閉じる前) では投げないので、場面 1 は赤くなる
      if new.org_id = ${sql.lit(org)}
         and exists (select 1 from crawl_pages where task_id = new.task_id and state <> 'pending') then
        raise exception 'level-report-smoke: the attribution insert fails';
      end if;
      return new;
    end $$`.execute(db);
  try {
    await sql`
      create trigger ${trigger} before insert on capture_submissions
      for each row execute function ${fn}()`.execute(db);
    const failed = await report();
    check("帰属を書けなければ 500", failed.statusCode === 500, String(failed.statusCode));
  } finally {
    await sql`drop trigger if exists ${trigger} on capture_submissions`.execute(db);
  }
  const afterFail = await page();
  check(
    "ページは閉じておらず、task_id も残らない (帰属と一緒に戻った)",
    afterFail?.state === "pending" && afterFail.taskId === null,
    JSON.stringify(afterFail),
  );
  check("帰属の行も無い", (await submissions()) === 0);
  // 期限は route が Node の時計で書き、ここは Postgres の時計で比べる。2 つがずれても (Apple Container の VM の
  // 時計など) 読み違えないよう、手放した (今) と 2 分の期限を見分けられる幅 (1 分) で見る
  const lease = (
    await sql<{ state: string; released: boolean }>`
      select state, lease_until < now() + interval '1 minute' as released from crawl_levels
       where crawl_id = ${crawlId} and depth = 0`.execute(db)
  ).rows[0];
  check(
    "段は報告中のまま、期限は手放されている (再試行が 2 分を待たずに取り直せる)",
    lease?.state === "reporting" && lease.released,
    JSON.stringify(lease),
  );

  // ── 2. 同じ鍵で報告し直す ────────────────────────────────────────────
  const retried = await report();
  check(
    "同じ鍵の再試行は 200",
    retried.statusCode === 200,
    `${String(retried.statusCode)} ${retried.body}`,
  );
  const afterRetry = await page();
  check(
    "再試行でページが閉じ、task_id が書かれる",
    afterRetry?.state === "captured" && afterRetry.taskId === taskId,
    JSON.stringify(afterRetry),
  );
  const attributed = (
    await sql<{ orgId: string; submittedBy: string; manifestError: string | null }>`
      select org_id, submitted_by, manifest_error from capture_submissions where task_id = ${taskId}`.execute(
      db,
    )
  ).rows[0];
  check(
    "再試行で帰属の行が書かれる (組織・依頼者はクロールの行から)",
    attributed?.orgId === org && attributed.submittedBy === "smoke",
    JSON.stringify(attributed),
  );

  // ── 3. もう 1 度 ─────────────────────────────────────────────────────
  const again = await report();
  check(
    "3 回目は最初の答えを返す",
    again.statusCode === 200 && again.body === retried.body,
    `${String(again.statusCode)} ${again.body}`,
  );
  check("帰属の行は増えない", (await submissions()) === 1);
} finally {
  await app.close();
  await sql`drop trigger if exists ${trigger} on capture_submissions`.execute(db);
  await sql`drop function if exists ${fn}()`.execute(db);
  await sql`delete from capture_submissions where org_id = ${org}`.execute(db);
  await sql`delete from crawls where org_id = ${org}`.execute(db);
  await db.destroy();
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
  `✓ level report smoke: ${String(results.length)} 件とも期待どおり (組織 ${org} の行は消した)`,
);
