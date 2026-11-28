#!/usr/bin/env node
/**
 * robots.txt の例外の表 (`046`) と store を、本物の Postgres に当てる。
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
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build:tools && DATABASE_URL=postgres://… node dist/tools/robots-exemptions-smoke.js
 *
 * **向ける DB は使い捨てのものにすること。** 自分の組織 (`smoke-<pid>`) の行だけを足して、最後に消す。
 *
 * どれか 1 つでも期待と違えば、全部を並べてから終了コード 1。
 */
import { sql, type RawBuilder } from "kysely";

import { createKyselyClient } from "../db/kysely.js";
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
const UA = "BrowserHive/1.0 (web archiving; user-directed capture)";
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

  const listed = await listExemptions(db, [org]);
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
      insert into robots_exemptions (org_id, host, user_agent, reason, expires_at, ${columns})
      values (${org}, 'raw.test', ${UA}, 'smoke', now() + interval '1 day', ${values})
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
  const defaults = (await listExemptions(db, [org])).find((item) => item.host === "raw.test");
  check(
    "既定: path の型は /、当たるクロールは all、上限は 100 と 20",
    defaults?.pathPattern === "/" &&
      defaults.appliesTo === "all" &&
      defaults.dailyLimit === 100 &&
      defaults.linkLimit === 20,
    JSON.stringify(defaults),
  );
} finally {
  // 自分の組織の行だけを消す
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
