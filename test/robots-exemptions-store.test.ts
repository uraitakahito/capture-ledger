import { describe, expect, it } from "vitest";

import {
  createExemption,
  exemptionState,
  getExemption,
  listExemptions,
  revokeExemption,
  type ExemptionRow,
  type NewExemption,
} from "../src/exemptions/store.js";
import { recordingDb } from "./recording-db.js";

/**
 * robots.txt の例外の store の SQL の形。**Kysely が実際に組んだ SQL を照らす。** 錠が本当に並べるか・CHECK・
 * 読み返した形は `src/tools/robots-exemptions-smoke.ts` が本物の Postgres で見る。
 */
const NOW = new Date("2026-11-28T03:00:00.000Z");
const EXPIRES = new Date("2026-12-28T03:00:00.000Z");
const UA = "BrowserHive/1.0 (web archiving; user-directed capture)";

const exemption = (overrides: Partial<NewExemption> = {}): NewExemption => ({
  orgId: "acme",
  host: "site.test",
  pathPattern: "/",
  scope: "seeds",
  appliesTo: "all",
  userAgent: UA,
  reason: "証拠として残す",
  dailyLimit: 100,
  linkLimit: 20,
  expiresAt: EXPIRES,
  createdBy: "alice-sub",
  ...overrides,
});

describe("exemptionState", () => {
  it("期限の前は active、期限ちょうどから expired", () => {
    expect(exemptionState({ expiresAt: EXPIRES, revokedAt: null }, NOW)).toBe("active");
    expect(exemptionState({ expiresAt: EXPIRES, revokedAt: null }, EXPIRES)).toBe("expired");
  });

  it("取り消した行は、期限が過ぎても revoked", () => {
    const later = new Date(EXPIRES.getTime() + 1);
    expect(exemptionState({ expiresAt: EXPIRES, revokedAt: NOW }, NOW)).toBe("revoked");
    expect(exemptionState({ expiresAt: EXPIRES, revokedAt: NOW }, later)).toBe("revoked");
  });
});

describe("robots.txt の例外の store", () => {
  it("一覧は渡した組織の行だけを、新しい順に (状態では絞らない)", async () => {
    const { db, queries } = recordingDb([[]]);
    await listExemptions(db, ["acme", "contoso"]);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('from "robots_exemptions"');
    expect(sql).toContain('where "org_id" in ($1, $2)');
    expect(sql).toContain('order by "created_at" desc, "id" desc');
    expect(sql).not.toContain("revoked_at");
    expect(sql).not.toContain("expires_at");
    expect(parameters).toEqual(["acme", "contoso"]);
  });

  it("組織が無ければ、一覧は SQL を出さない", async () => {
    const { db, queries } = recordingDb();
    await expect(listExemptions(db, [])).resolves.toEqual([]);
    expect(queries).toEqual([]);
  });

  it("1 行は番号で引く", async () => {
    const { db, queries } = recordingDb([[]]);
    await expect(getExemption(db, "7")).resolves.toBeUndefined();
    expect(queries[0]!.sql).toContain('where "id" = $1');
    expect(queries[0]!.parameters).toEqual(["7"]);
  });

  it("登録は、組織とホストの錠を取ってから効いている行を見て、同じトランザクションで足す", async () => {
    const row = { id: "1" } as ExemptionRow;
    const { db, queries } = recordingDb([[], [], [row]]);
    const answer = await createExemption(db, exemption({ createdByName: "alice" }), NOW);
    expect(answer).toEqual({ kind: "created", row });

    expect(queries.map(({ sql }) => sql.split(" ")[0])).toEqual([
      "begin",
      "select",
      "select",
      "insert",
      "commit",
    ]);
    // 行に頼らない錠 (行が 1 つも無い時にも、同時の 2 本を並べる)
    expect(queries[1]!.sql).toBe("select pg_advisory_xact_lock(hashtext($1), hashtext($2))");
    expect(queries[1]!.parameters).toEqual(["acme", "site.test"]);
    // 効いている行: 取り消していなくて、期限の前
    expect(queries[2]!.sql).toContain(
      'where "org_id" = $1 and "host" = $2 and "revoked_at" is null and "expires_at" > $3',
    );
    expect(queries[2]!.parameters).toEqual(["acme", "site.test", NOW]);
    expect(queries[3]!.sql).toContain('insert into "robots_exemptions"');
    expect(queries[3]!.sql).toContain("returning *");
    expect(queries[3]!.parameters).toEqual([
      "acme",
      "site.test",
      "/",
      "seeds",
      "all",
      UA,
      "証拠として残す",
      100,
      20,
      "alice-sub",
      "alice",
      NOW.toISOString(),
      EXPIRES.toISOString(),
    ]);
  });

  it("同じ path の型で効いている行が在れば、足さずに断る", async () => {
    const { db, queries } = recordingDb([[], [{ id: "4", pathPattern: "/", userAgent: UA }]]);
    await expect(createExemption(db, exemption(), NOW)).resolves.toEqual({
      kind: "overlap",
      id: "4",
    });
    expect(queries.some(({ sql }) => sql.startsWith("insert"))).toBe(false);
  });

  it("効いている行の名乗りが違えば、足さずに断る", async () => {
    const { db, queries } = recordingDb([
      [],
      [{ id: "4", pathPattern: "/status/", userAgent: "BrowserHive/2.0" }],
    ]);
    await expect(createExemption(db, exemption(), NOW)).resolves.toEqual({
      kind: "user-agent-mismatch",
      userAgent: "BrowserHive/2.0",
    });
    expect(queries.some(({ sql }) => sql.startsWith("insert"))).toBe(false);
  });

  it("別の path の型で、名乗りが同じなら足す", async () => {
    const row = { id: "5" } as ExemptionRow;
    const { db } = recordingDb([[], [{ id: "4", pathPattern: "/status/", userAgent: UA }], [row]]);
    await expect(createExemption(db, exemption(), NOW)).resolves.toEqual({ kind: "created", row });
  });

  it("名前が分からなければ、名前の欄は NULL", async () => {
    const { db, queries } = recordingDb([[], [], [{ id: "1" }]]);
    await createExemption(db, exemption(), NOW);
    expect(queries[3]!.parameters[10]).toBeNull();
  });

  it("取り消しは、効いている行だけに当て、時刻と主体を立てる (行は消さない)", async () => {
    const row = { id: "7" } as ExemptionRow;
    const { db, queries } = recordingDb([[row]]);
    const answer = await revokeExemption(db, "7", { subject: "alice-sub", name: "alice" }, NOW);
    expect(answer).toEqual({ kind: "revoked", row });
    expect(queries).toHaveLength(1);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('update "robots_exemptions"');
    expect(sql).toContain('"revoked_at" = $1, "revoked_by" = $2, "revoked_by_name" = $3');
    expect(sql).toContain('where "id" = $4 and "revoked_at" is null and "expires_at" > $5');
    expect(parameters).toEqual([NOW.toISOString(), "alice-sub", "alice", "7", NOW]);
  });

  it("当たらなかった取り消しは、訳を読み直して区別する", async () => {
    const revoke = async (current: readonly object[]) => {
      const { db } = recordingDb([[], current]);
      return revokeExemption(db, "7", { subject: "alice-sub" }, NOW);
    };
    await expect(revoke([])).resolves.toEqual({ kind: "not-found" });
    await expect(revoke([{ id: "7", revokedAt: NOW, expiresAt: EXPIRES }])).resolves.toEqual({
      kind: "already-revoked",
    });
    await expect(revoke([{ id: "7", revokedAt: null, expiresAt: NOW }])).resolves.toEqual({
      kind: "expired",
    });
  });
});
