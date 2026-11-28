#!/usr/bin/env node
/**
 * robots.txt の例外の表 (`046`) と store と、クロールが行を引く所 (`047`) を、本物の Postgres に当てる。
 *
 * 試験は DB を立てない。`test/recording-db.ts` は Kysely が組んだ SQL を記録するが、次のことは見られない。
 * **それを見るのは、ここだけ。**
 *
 *   - **同時の登録は 1 本だけ通る** (同じ組織・ホスト・path の型で効いている行は 1 つ、名乗りは 1 つ)。行が 1 つも
 *     無い所から並べて撃つので、`exemptions/store.ts` の advisory lock を外すと、みな「重なりは無い」と見て通り、
 *     ここが赤くなる
 *   - 別のホストの登録は、互いを待たせても断らない
 *   - 取り消した行と期限の過ぎた行は、次の登録を塞がない
 *   - 同時の取り消しは 1 本だけ当たる
 *   - CHECK (範囲・当たるクロール・枚数の下限・取り消しの時刻と主体の組) と既定
 *   - bigserial と timestamptz が、読み返して store の型どおりの形であること
 *   - `047` の列と部分 index・`crawls.exemption_eligibility` の CHECK と既定・`crawl_pages.robots_exemption_id` の参照
 *   - 段ごとに引く SQL (`exemptions/dispatch.ts`) と一覧の「24 時間で外した枚数」が通り、数え方が合うこと
 *     (24 時間の内だけ・このクロールの深さ 1 から先だけ・0 で下止め)
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build:tools && DATABASE_URL=postgres://… node dist/tools/robots-exemptions-smoke.js
 *
 * **向ける DB は使い捨てのものにすること。** 自分の組織 (`smoke-<pid>`) の行だけを足して、最後に消す。
 *
 * どれか 1 つでも期待と違えば、全部を並べてから終了コード 1。
 */
import { randomUUID } from "node:crypto";

import { sql, type RawBuilder } from "kysely";

import { createKyselyClient } from "../db/kysely.js";
import { exemptionsForLevel } from "../exemptions/dispatch.js";
import {
  createExemption,
  exemptionState,
  getExemption,
  listExemptions,
  revokeExemption,
  type CreateExemptionResult,
  type NewExemption,
} from "../exemptions/store.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

const db = createKyselyClient(databaseUrl);
const org = `smoke-${String(process.pid)}`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

const DAY = 86_400_000;
const UA = "BrowserHive/1.0 (+https://site.test/bot)";
/** 同時に撃つ本数。pg の pool の既定 (10 本) に収め、どれも自分の接続で走らせる。 */
const PARALLEL = 8;

const exemption = (overrides: Partial<NewExemption> = {}): NewExemption => ({
  orgId: org,
  host: "site.test",
  pathPattern: "/",
  scope: "seeds",
  appliesTo: "all",
  userAgent: UA,
  reason: "smoke",
  dailyLimit: 100,
  linkLimit: 20,
  expiresAt: new Date(Date.now() + 30 * DAY),
  createdBy: org,
  ...overrides,
});

const kinds = (answers: readonly CreateExemptionResult[]) =>
  answers
    .map((answer) => answer.kind)
    .sort()
    .join(",");
const count = (answers: readonly CreateExemptionResult[], kind: CreateExemptionResult["kind"]) =>
  answers.filter((answer) => answer.kind === kind).length;

/** CHECK に落ちる (23514) か。 */
const refusedByCheck = async (insert: Promise<unknown>): Promise<string> => {
  try {
    await insert;
    return "通った";
  } catch (err) {
    return String((err as { code?: string }).code);
  }
};

try {
  const now = new Date();

  // ── 同時の登録 ─────────────────────────────────────────
  // 行が 1 つも無い所から、同じ組織・ホスト・path の型を並べて撃つ
  const same = await Promise.all(
    Array.from({ length: PARALLEL }, () => createExemption(db, exemption(), now)),
  );
  check(
    "同じ組織・ホスト・path の型の同時の登録は、1 本だけ通る",
    count(same, "created") === 1 && count(same, "overlap") === PARALLEL - 1,
    kinds(same),
  );

  // 行が 1 つも無いホストに、path の型も名乗りも違う登録を並べて撃つ。名乗りは 1 つなので、通るのは 1 本
  const agents = await Promise.all(
    Array.from({ length: PARALLEL }, (_, index) =>
      createExemption(
        db,
        exemption({
          host: "agents.test",
          pathPattern: `/p${String(index)}/`,
          userAgent: `BrowserHive/1.${String(index)}`,
        }),
        now,
      ),
    ),
  );
  check(
    "同じ組織・ホストで名乗りの違う同時の登録は、1 本だけ通る",
    count(agents, "created") === 1 && count(agents, "user-agent-mismatch") === PARALLEL - 1,
    kinds(agents),
  );

  // 別のホストは別の組。hash がぶつかって待つことはあっても、断らない
  const hosts = await Promise.all(
    Array.from({ length: PARALLEL }, (_, index) =>
      createExemption(db, exemption({ host: `h${String(index)}.test` }), now),
    ),
  );
  check("別のホストの同時の登録は、みな通る", count(hosts, "created") === PARALLEL, kinds(hosts));

  const paths = await createExemption(db, exemption({ pathPattern: "/status/" }), now);
  check("同じ名乗りで path の型が違えば通る", paths.kind === "created", paths.kind);

  const otherOrg = await createExemption(db, exemption({ orgId: `${org}-b` }), now);
  check("別の組織の同じホストと path の型は通る", otherOrg.kind === "created", otherOrg.kind);

  // ── 読み返した形 ───────────────────────────────────────
  const first = same.find((answer) => answer.kind === "created");
  if (first?.kind !== "created") throw new Error("最初の 1 行を足せなかった");
  const row = first.row;
  check("番号は字で返る (bigserial)", typeof row.id === "string" && /^[1-9][0-9]*$/.test(row.id));
  check(
    "時刻は Date で返り、登録の時刻は渡した時計の物",
    row.createdAt instanceof Date &&
      row.expiresAt instanceof Date &&
      row.createdAt.toISOString() === now.toISOString(),
    String(row.createdAt),
  );
  check(
    "取り消しの欄は NULL で始まる",
    row.revokedAt === null && row.revokedBy === null && row.revokedByName === null,
  );
  check("登録した行は active", exemptionState(row, now) === "active");
  const again = await getExemption(db, row.id);
  check("番号で引くと同じ行", again?.id === row.id && again.host === "site.test");

  const listed = await listExemptions(db, [org], now);
  check(
    "一覧は自分の組織の行だけ",
    listed.length === 2 + PARALLEL + 1 && listed.every((item) => item.orgId === org),
    String(listed.length),
  );
  check(
    "一覧は新しい順 (同じ時刻なら番号の大きい順)",
    listed.every((item, index) => index === 0 || BigInt(listed[index - 1]!.id) > BigInt(item.id)),
    listed.map((item) => item.id).join(","),
  );

  // ── 取り消し ───────────────────────────────────────────
  const revokes = await Promise.all(
    Array.from({ length: PARALLEL }, () => revokeExemption(db, row.id, { subject: org }, now)),
  );
  const revokeKinds = revokes
    .map((answer) => answer.kind)
    .sort()
    .join(",");
  check(
    "同時の取り消しは 1 本だけ当たり、残りは「もう取り消した」",
    revokes.filter((answer) => answer.kind === "revoked").length === 1 &&
      revokes.filter((answer) => answer.kind === "already-revoked").length === PARALLEL - 1,
    revokeKinds,
  );
  const revoked = await getExemption(db, row.id);
  check(
    "取り消した行は残り、時刻と主体を持つ",
    revoked?.revokedAt?.toISOString() === now.toISOString() && revoked.revokedBy === org,
  );
  const missing = await revokeExemption(db, "999999999999999999", { subject: org }, now);
  check("無い行の取り消しは not-found", missing.kind === "not-found", missing.kind);

  const afterRevoke = await createExemption(db, exemption(), now);
  check("取り消した行は、次の登録を塞がない", afterRevoke.kind === "created", afterRevoke.kind);

  // ── 期限 ───────────────────────────────────────────────
  // 31 日後の時計で見ると、上の行 (30 日後が期限) は切れている
  const later = new Date(now.getTime() + 31 * DAY);
  const afterExpiry = await createExemption(
    db,
    exemption({ expiresAt: new Date(later.getTime() + DAY) }),
    later,
  );
  check("期限の過ぎた行は、次の登録を塞がない", afterExpiry.kind === "created", afterExpiry.kind);
  if (afterRevoke.kind === "created") {
    const expired = await revokeExemption(db, afterRevoke.row.id, { subject: org }, later);
    check("期限の過ぎた行の取り消しは expired", expired.kind === "expired", expired.kind);
  }

  // ── CHECK と既定 ───────────────────────────────────────
  const raw = (columns: RawBuilder<unknown>, values: RawBuilder<unknown>) =>
    sql`
      insert into robots_exemptions (org_id, host, user_agent, reason, created_by, expires_at, ${columns})
      values (${org}, 'raw.test', ${UA}, 'smoke', 'smoke', now() + interval '1 day', ${values})
    `.execute(db);
  for (const [name, columns, values] of [
    ["scope は seeds か links", sql`scope`, sql`'all'`],
    ["applies_to は all か human", sql`scope, applies_to`, sql`'seeds', 'machine'`],
    ["daily_limit は 1 以上", sql`scope, daily_limit`, sql`'seeds', 0`],
    ["link_limit は 1 以上", sql`scope, link_limit`, sql`'seeds', 0`],
    ["取り消した時刻だけの行は書けない", sql`scope, revoked_at`, sql`'seeds', now()`],
    ["取り消した主体だけの行は書けない", sql`scope, revoked_by`, sql`'seeds', 'x'`],
  ] as const) {
    const code = await refusedByCheck(raw(columns, values));
    check(`CHECK: ${name}`, code === "23514", code);
  }
  await raw(sql`scope`, sql`'links'`);
  const defaults = (await listExemptions(db, [org], now)).find((item) => item.host === "raw.test");
  check(
    "既定: path の型は /、当たるクロールは all、上限は 100 と 20",
    defaults?.pathPattern === "/" &&
      defaults.appliesTo === "all" &&
      defaults.dailyLimit === 100 &&
      defaults.linkLimit === 20,
    JSON.stringify(defaults),
  );

  // ── `047`: 列と index ───────────────────────────────────
  const columns = await sql<{
    name: string;
    type: string;
    nullable: string;
    fallback: string | null;
  }>`
    select table_name || '.' || column_name as name, data_type as type, is_nullable as nullable,
           column_default as fallback
      from information_schema.columns
     where table_schema = current_schema()
       and (table_name, column_name) in (('crawls', 'exemption_eligibility'), ('crawl_pages', 'robots_exemption_id'))
     order by 1`.execute(db);
  const [exemptionColumn, eligibilityColumn] = columns.rows;
  check(
    "crawl_pages.robots_exemption_id は bigint で、NULL を許す",
    exemptionColumn?.name === "crawl_pages.robots_exemption_id" &&
      exemptionColumn.type === "bigint" &&
      exemptionColumn.nullable === "YES",
    JSON.stringify(columns.rows),
  );
  check(
    "crawls.exemption_eligibility は text・NOT NULL で、既定は none",
    eligibilityColumn?.name === "crawls.exemption_eligibility" &&
      eligibilityColumn.type === "text" &&
      eligibilityColumn.nullable === "NO" &&
      (eligibilityColumn.fallback ?? "").includes("'none'"),
    JSON.stringify(columns.rows),
  );
  const index = await sql<{ indexdef: string }>`
    select indexdef from pg_indexes
     where schemaname = current_schema() and indexname = 'crawl_pages_robots_exemption_idx'`.execute(
    db,
  );
  const indexdef = index.rows[0]?.indexdef ?? "";
  check(
    "枚数を数える index は (robots_exemption_id, finished_at) の部分 index",
    indexdef.includes("(robots_exemption_id, finished_at)") &&
      indexdef.includes("WHERE (robots_exemption_id IS NOT NULL)"),
    indexdef,
  );

  // ── `047`: 資格の CHECK と既定 ──────────────────────────
  // 締めたクロールだけを足す (走行中は全体で 1 本)。**NOT NULL の列はみな入れる**
  const crawlA = randomUUID();
  const crawlB = randomUUID();
  const insertCrawl = (id: string, extra: RawBuilder<unknown>, values: RawBuilder<unknown>) =>
    sql`
      insert into crawls (id, seeds, rules, max_depth, max_pages, per_host_delay_ms, host_parallelism, org_id,
        requested_by, state, started_at, finished_at${extra})
      values (${id}, ${["https://count.test/"]}, '[]', 1, 30, 2000, 4, ${org}, 'smoke', 'succeeded',
        '2020-01-01T00:00:00Z', '2020-01-01T00:05:00Z'${values})`.execute(db);
  const badEligibility = await refusedByCheck(
    insertCrawl(randomUUID(), sql`, exemption_eligibility`, sql`, 'robot'`),
  );
  check(
    "CHECK: exemption_eligibility は none・machine・human",
    badEligibility === "23514",
    badEligibility,
  );
  await insertCrawl(crawlA, sql``, sql``);
  await insertCrawl(crawlB, sql`, exemption_eligibility`, sql`, 'human'`);
  const eligibilities = await sql<{ id: string; eligibility: string }>`
    select id, exemption_eligibility as eligibility from crawls where id in (${crawlA}, ${crawlB})`.execute(
    db,
  );
  const eligibilityOf = (id: string) =>
    eligibilities.rows.find((one) => one.id === id)?.eligibility;
  check(
    "資格を書かないクロールは none、書けば残る",
    eligibilityOf(crawlA) === "none" && eligibilityOf(crawlB) === "human",
    JSON.stringify(eligibilities.rows),
  );

  // ── `047`: 外した頁と、枚数 ─────────────────────────────
  const counted = await createExemption(
    db,
    exemption({ host: "count.test", scope: "links", dailyLimit: 5, linkLimit: 2 }),
    now,
  );
  if (counted.kind !== "created") throw new Error("枚数を数える行を足せなかった");
  const countedId = counted.row.id;
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const insertPage = (
    crawlId: string,
    path: string,
    depth: number,
    finishedAt: string,
    exemptionId: string | null,
  ) =>
    sql`
      insert into crawl_pages (crawl_id, url, depth, host, state, finished_at, robots_exemption_id)
      values (${crawlId}, ${`https://count.test${path}`}, ${depth}, 'count.test', 'captured', ${finishedAt},
        ${exemptionId})`.execute(db);
  // クロール A: 起点 (1 時間前)・リンク (1 時間前)・リンク (25 時間前)。クロール B: リンク (2 時間前)。外していない頁が 1 枚
  await insertPage(crawlA, "/", 0, hoursAgo(1), countedId);
  await insertPage(crawlA, "/a", 1, hoursAgo(1), countedId);
  await insertPage(crawlA, "/old", 1, hoursAgo(25), countedId);
  await insertPage(crawlA, "/plain", 1, hoursAgo(1), null);
  await insertPage(crawlB, "/b", 1, hoursAgo(2), countedId);

  const draw = (crawlId: string, depth: number, hosts: string[] = ["count.test"]) =>
    exemptionsForLevel(db, { crawlId, orgId: org, eligibility: "human", depth, hosts, now });
  const atSeeds = await draw(crawlA, 0);
  check(
    "深さ 0 の残りは、24 時間の上限から 24 時間の内に外した頁を引いた数 (5 − 3)",
    atSeeds.length === 1 &&
      atSeeds[0]?.id === countedId &&
      // 型まで見る (flow は、数の型でない remaining・字でない id の行を黙って当てない)
      typeof atSeeds[0].id === "string" &&
      typeof atSeeds[0].remaining === "number" &&
      atSeeds[0].remaining === 2,
    JSON.stringify(atSeeds),
  );
  const atLinksA = await draw(crawlA, 1);
  check(
    "深さ 1 の残りは、このクロールのリンクの上限とも比べる (24 時間より前の頁も数える。2 − 2 = 0)",
    atLinksA[0]?.remaining === 0,
    JSON.stringify(atLinksA),
  );
  const atLinksB = await draw(crawlB, 1);
  check(
    "リンクの上限は、クロールごとに数える (別のクロールでは 2 − 1 = 1)",
    atLinksB[0]?.remaining === 1,
    JSON.stringify(atLinksB),
  );
  const declaration = atSeeds[0]?.declaration;
  check(
    "申告の時刻は Z で終わる ISO で、登録した人は名が無ければ主体の ID",
    declaration?.grantedAt === now.toISOString() &&
      declaration.expiresAt === counted.row.expiresAt.toISOString() &&
      declaration.grantedBy === org &&
      declaration.exemptionId === countedId,
    JSON.stringify(declaration),
  );
  const elsewhere = await draw(crawlA, 0, ["other.test"]);
  check("frontier に無いホストの行は引かない", elsewhere.length === 0, JSON.stringify(elsewhere));
  const usedListed = (await listExemptions(db, [org], now)).find((item) => item.id === countedId);
  check(
    "一覧の「24 時間で外した枚数」は、同じ数え方 (3)",
    usedListed?.usedLast24h === 3,
    String(usedListed?.usedLast24h),
  );

  const insertRefused = await refusedByCheck(
    insertPage(crawlA, "/ghost", 1, hoursAgo(1), "999999999999999999"),
  );
  check("参照: 無い行の番号は、頁に書けない", insertRefused === "23503", insertRefused);
  const deleteRefused = await refusedByCheck(
    sql`delete from robots_exemptions where id = ${countedId}`.execute(db),
  );
  check("参照: 頁が指す行は、消せない", deleteRefused === "23503", deleteRefused);
} finally {
  // 自分の組織の物だけを消す。頁 (クロールと一緒に消える) が行を指すので、クロールが先
  await sql`delete from crawls where org_id = ${org}`.execute(db);
  await sql`delete from robots_exemptions where org_id in (${org}, ${`${org}-b`})`.execute(db);
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
  `✓ robots exemptions smoke: ${String(results.length)} 件とも期待どおり (組織 ${org} の行は消した)`,
);
