import { describe, expect, it } from "vitest";

import { derivationStoreOf } from "../src/derivations/store.js";
import { recordingDb } from "./recording-db.js";

/**
 * 派生の層の SQL の形。**集計は route の試験の偽の DB では真似できない**ので、Kysely が実際に組んだ
 * SQL をここで照らす (Postgres で通るかは、CI の migration の up・down・up と、実機で見る)。
 */
describe("派生の層の store", () => {
  it("月の使った額は、組織と DB の時計の月で usd を足す", async () => {
    const { db, queries } = recordingDb([[{ spent: "1.250000" }]]);
    expect(await derivationStoreOf(db).spentThisMonth("acme")).toBe(1.25);
    expect(queries).toHaveLength(1);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain("coalesce(sum(usd), 0)");
    expect(sql).toContain('from "derivations"');
    expect(sql).toContain('"org_id" = $1');
    expect(sql).toContain(`"created_at" >= date_trunc('month', now())`);
    expect(parameters).toEqual(["acme"]);
  });

  it("まだ 1 行も無ければ 0", async () => {
    const { db } = recordingDb([[]]);
    expect(await derivationStoreOf(db).spentThisMonth("acme")).toBe(0);
  });

  it("残す行は jsonb を文字列にし、usd を小数 6 桁で書く", async () => {
    const { db, queries } = recordingDb([[]]);
    await derivationStoreOf(db).record({
      kind: "fix",
      orgId: "acme",
      crawlId: "d272d256-e528-4581-bb4e-8d9477d78196",
      target: { crawlId: "d272d256-e528-4581-bb4e-8d9477d78196", inline: "close-banner" },
      inputSha256: "a".repeat(64),
      model: "claude-opus-5-5",
      promptVersion: "fix/1",
      effort: "medium",
      rounds: 1,
      output: { kind: "fixed" },
      usage: { input_tokens: 3100 },
      usd: 0.0304,
      createdBy: "alice",
    });
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('insert into "derivations"');
    expect(sql).toContain('"input_sha256"');
    expect(sql).toContain('"prompt_version"');
    expect(parameters).toContain('{"kind":"fixed"}');
    expect(parameters).toContain('{"input_tokens":3100}');
    expect(parameters).toContain("0.030400");
  });
});
