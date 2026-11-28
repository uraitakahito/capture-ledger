import { describe, expect, it } from "vitest";

import { exemptionsForLevel, type LevelOf } from "../src/exemptions/dispatch.js";
import { recordingDb } from "./recording-db.js";

/**
 * 段ごとに robots.txt の例外を引く所 (`src/exemptions/dispatch.ts`)。**Kysely が実際に組んだ SQL を照らす。**
 * SQL が Postgres で通るか・数え方が本当に合うかは、`src/tools/robots-exemptions-smoke.ts` が本物の DB で見る。
 *
 * 組んだ引数は、capture-scheduler の `plan_level` が形を検査する (通らない行は黙って当たらない) ので、型まで見る。
 */
const NOW = new Date("2026-11-28T03:00:00.000Z");
const CRAWL = "d272d256-e528-4581-bb4e-8d9477d78196";
const UA = "BrowserHive/1.0 (+https://site.test/bot)";

const level = (overrides: Partial<LevelOf> = {}): LevelOf => ({
  crawlId: CRAWL,
  orgId: "acme",
  eligibility: "human",
  depth: 0,
  hosts: ["site.test"],
  now: NOW,
  ...overrides,
});

/** DB が返す行 (node-pg の形: bigserial は字、timestamptz は Date、`::int` は数)。 */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "7",
  host: "site.test",
  pathPattern: "/exempt/",
  scope: "links",
  userAgent: UA,
  reason: "証拠として残す",
  dailyLimit: 100,
  linkLimit: 20,
  createdBy: "alice-sub",
  createdByName: "alice",
  // 東京の時刻で入った行でも、申告は UTC で書く
  createdAt: new Date("2026-11-20T09:00:00.000+09:00"),
  expiresAt: new Date("2026-12-28T03:00:00.000Z"),
  usedLast24h: 0,
  usedLinks: 0,
  ...overrides,
});

const draw = async (overrides: Partial<LevelOf> = {}, rows: readonly object[] = []) => {
  const { db, queries } = recordingDb([rows]);
  const exemptions = await exemptionsForLevel(db, level(overrides));
  return { exemptions, queries };
};

describe("段に効く robots.txt の例外を引く", () => {
  it("資格が none のクロールは、DB を引かずに空", async () => {
    const { exemptions, queries } = await draw({ eligibility: "none" }, [row()]);
    expect(exemptions).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("知らない資格の字（欄の無い古い行）も、DB を引かずに空", async () => {
    const { exemptions, queries } = await draw(
      { eligibility: undefined as unknown as LevelOf["eligibility"] },
      [row()],
    );
    expect(exemptions).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("frontier にホストが無ければ、DB を引かない", async () => {
    const { exemptions, queries } = await draw({ hosts: [] });
    expect(exemptions).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("クロールの組織・段のホスト・効いている行（取り消していない・期限の前）だけを、番号の順に引く", async () => {
    const { queries } = await draw({ hosts: ["site.test", "b.test:8080", "site.test"] });
    expect(queries).toHaveLength(1);
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain('from "robots_exemptions"');
    // 別の組織の行を引かない
    expect(sql).toContain('where "org_id" = $4');
    // 同じホストは 1 度だけ渡す
    expect(sql).toContain('and "host" in ($5, $6)');
    // 取り消した行と、期限の過ぎた行を引かない。期限は渡した時計で測る
    expect(sql).toContain('and "revoked_at" is null and "expires_at" > $7');
    expect(sql).toMatch(/order by "id"$/);
    expect(parameters.slice(3)).toEqual(["acme", "site.test", "b.test:8080", NOW]);
  });

  it("深さ 0 は seeds の行も links の行も引く（範囲で絞らない）", async () => {
    const { queries } = await draw({ depth: 0 });
    expect(queries[0]!.sql).not.toContain('"scope" =');
  });

  it("深さ 1 から先は links の行だけを引く", async () => {
    for (const depth of [1, 2]) {
      const { queries } = await draw({ depth });
      expect(queries[0]!.sql).toContain('and "scope" = $7');
      expect(queries[0]!.parameters[6]).toBe("links");
    }
  });

  it("human は全ての行、machine は applies_to = 'all' の行だけを引く", async () => {
    const human = await draw({ eligibility: "human" });
    expect(human.queries[0]!.sql).not.toContain("applies_to");
    const machine = await draw({ eligibility: "machine" });
    expect(machine.queries[0]!.sql).toContain('and "applies_to" = $7');
    expect(machine.queries[0]!.parameters[6]).toBe("all");
    // 深さ 1 の machine は、範囲と資格の両方で絞る
    const deep = await draw({ eligibility: "machine", depth: 1 });
    expect(deep.queries[0]!.sql).toContain('and "scope" = $7 and "applies_to" = $8');
    expect(deep.queries[0]!.parameters.slice(6)).toEqual(["links", "all"]);
  });

  it("行ごとに、24 時間で外した頁と、このクロールの深さ 1 から先で外した頁を crawl_pages から数える", async () => {
    const { queries } = await draw();
    const { sql, parameters } = queries[0]!;
    expect(sql).toContain(
      '(select count(*)::int as "n" from "crawl_pages" ' +
        'where "crawl_pages"."robots_exemption_id" = "robots_exemptions"."id" ' +
        'and "crawl_pages"."finished_at" >= $1) as "used_last24h"',
    );
    expect(sql).toContain(
      '(select count(*)::int as "n" from "crawl_pages" ' +
        'where "crawl_pages"."robots_exemption_id" = "robots_exemptions"."id" ' +
        'and "crawl_pages"."crawl_id" = $2 and "crawl_pages"."depth" >= $3) as "used_links"',
    );
    // 数える式は結末 (state) を見ない —— 外して撮りに行き、撮れなかった頁も数える
    expect(sql).not.toContain('"state"');
    expect(parameters.slice(0, 3)).toEqual([new Date("2026-11-27T03:00:00.000Z"), CRAWL, 1]);
  });
});

describe("残りの枚数", () => {
  const remainingOf = async (overrides: Partial<LevelOf>, values: Record<string, unknown>) =>
    (await draw(overrides, [row(values)])).exemptions[0]?.remaining;

  it("深さ 0 は、24 時間の上限から 24 時間で外した数を引く（リンクの上限は見ない）", async () => {
    await expect(
      remainingOf({ depth: 0 }, { dailyLimit: 100, usedLast24h: 30, linkLimit: 20, usedLinks: 20 }),
    ).resolves.toBe(70);
  });

  it("深さ 1 から先は、このクロールのリンクの上限の残りとの小さい方", async () => {
    await expect(
      remainingOf({ depth: 1 }, { dailyLimit: 100, usedLast24h: 30, linkLimit: 20, usedLinks: 5 }),
    ).resolves.toBe(15);
    await expect(
      remainingOf({ depth: 2 }, { dailyLimit: 100, usedLast24h: 95, linkLimit: 20, usedLinks: 5 }),
    ).resolves.toBe(5);
  });

  it("尽きた行も渡し、残りは 0 で下止めする（超えていても負にしない）", async () => {
    await expect(remainingOf({ depth: 0 }, { dailyLimit: 3, usedLast24h: 5 })).resolves.toBe(0);
    await expect(
      remainingOf({ depth: 1 }, { dailyLimit: 100, linkLimit: 2, usedLinks: 4 }),
    ).resolves.toBe(0);
  });
});

describe("flow へ渡す形", () => {
  it("行の番号・ホスト・path の型・範囲・名乗り・残りと、WACZ に書く申告", async () => {
    const { exemptions } = await draw({ depth: 1 }, [row({ usedLast24h: 1, usedLinks: 1 })]);
    expect(exemptions).toEqual([
      {
        id: "7",
        host: "site.test",
        pathPattern: "/exempt/",
        scope: "links",
        userAgent: UA,
        remaining: 19,
        declaration: {
          exemptionId: "7",
          reason: "証拠として残す",
          pathPattern: "/exempt/",
          scope: "links",
          grantedBy: "alice",
          grantedAt: "2026-11-20T00:00:00.000Z",
          expiresAt: "2026-12-28T03:00:00.000Z",
        },
      },
    ]);
  });

  /** `plan_level` の検査 (`exemptionProblem`) に通らない行は、黙って当たらない。型で外れないことを見る。 */
  it("id は数字だけの字、remaining は数の型の 0 以上の整数、申告は 7 つとも字で、時刻は Z で終わる ISO", async () => {
    const { exemptions } = await draw({ depth: 1 }, [row(), row({ id: "12", usedLinks: 99 })]);
    expect(exemptions).toHaveLength(2);
    for (const exemption of exemptions) {
      expect(typeof exemption.id).toBe("string");
      expect(exemption.id).toMatch(/^[0-9]+$/);
      expect(typeof exemption.remaining).toBe("number");
      expect(Number.isInteger(exemption.remaining)).toBe(true);
      expect(exemption.remaining).toBeGreaterThanOrEqual(0);
      expect(Object.keys(exemption.declaration).sort()).toEqual([
        "exemptionId",
        "expiresAt",
        "grantedAt",
        "grantedBy",
        "pathPattern",
        "reason",
        "scope",
      ]);
      for (const value of Object.values(exemption.declaration)) expect(typeof value).toBe("string");
      const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(exemption.declaration.grantedAt).toMatch(iso);
      expect(exemption.declaration.expiresAt).toMatch(iso);
      expect(exemption.declaration.exemptionId).toBe(exemption.id);
    }
    // JSON にしても (段の行の args・webhook の本文) 型は変わらない
    const sent = JSON.parse(JSON.stringify(exemptions)) as typeof exemptions;
    expect(typeof sent[0]?.remaining).toBe("number");
    expect(typeof sent[0]?.id).toBe("string");
  });

  it("登録した人の名が無ければ（null・空）、申告の grantedBy は主体の ID", async () => {
    const { exemptions } = await draw({}, [
      row({ createdByName: null }),
      row({ id: "8", createdByName: "" }),
    ]);
    expect(exemptions.map((exemption) => exemption.declaration.grantedBy)).toEqual([
      "alice-sub",
      "alice-sub",
    ]);
  });
});
