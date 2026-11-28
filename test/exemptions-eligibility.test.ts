import { ConsistencyPreference } from "@openfga/sdk";
import { describe, expect, it } from "vitest";

import { exemptionEligibility, type CrawlStart } from "../src/exemptions/eligibility.js";

/**
 * robots.txt の例外の資格 (`src/exemptions/eligibility.ts`)。**fga は代役なので、ここが見るのは経路** ——
 * 何を・どの組織について訊き、答えをどう読むか。`can_submit` の式そのものは `fga/model.fga.yaml` の assertion が見る
 * (`tasks/lessons.md` の「認可の検査は、呼び出し元の申告で満たせてはならない」)。
 */
const fakeFga = (allowed: (object: string) => boolean) => {
  const asked: { request: unknown; options: unknown }[] = [];
  const fga = {
    check: (request: { object: string }, options: unknown) => {
      asked.push({ request, options });
      return Promise.resolve({ allowed: allowed(request.object) });
    },
  } as unknown as Parameters<typeof exemptionEligibility>[0];
  return { fga, asked };
};

const PERSON: CrawlStart = { kind: "request", machine: false, identityMode: "jwt" };
const MACHINE: CrawlStart = { kind: "request", machine: true, identityMode: "jwt" };
const SCHEDULE: CrawlStart = { kind: "schedule" };
const alice = { subject: "alice-sub", orgId: "acme" };

describe("robots.txt の例外の資格", () => {
  it("人が POST /api/crawls で始め、クロールの組織で始めてよければ human", async () => {
    const { fga } = fakeFga(() => true);
    await expect(exemptionEligibility(fga, alice, PERSON)).resolves.toBe("human");
  });

  it("機械の主体は machine", async () => {
    const { fga } = fakeFga(() => true);
    await expect(exemptionEligibility(fga, alice, MACHINE)).resolves.toBe("machine");
  });

  it("定期の回は machine（人にはならない）", async () => {
    const { fga } = fakeFga(() => true);
    await expect(exemptionEligibility(fga, alice, SCHEDULE)).resolves.toBe("machine");
  });

  /**
   * review-2 の穴。名乗りが [A, B] で許しは B だけの主体のクロールは A の物になる (`requesterOf`)。`maySubmit` は B の
   * 許しで通すが、A の例外を当ててはいけない。
   */
  it("クロールの組織で許しが無ければ none —— 名乗りが [A, B] で許しは B だけの主体の、A のクロール", async () => {
    const { fga, asked } = fakeFga((object) => object === "organization:b");
    const who = { subject: "carol-sub", orgId: "a" };
    await expect(exemptionEligibility(fga, who, PERSON)).resolves.toBe("none");
    await expect(exemptionEligibility(fga, who, MACHINE)).resolves.toBe("none");
    await expect(exemptionEligibility(fga, who, SCHEDULE)).resolves.toBe("none");
    // 訊いたのは A だけ。B の許しは見に行かない
    expect(asked.map(({ request }) => (request as { object: string }).object)).toEqual([
      "organization:a",
      "organization:a",
      "organization:a",
    ]);
  });

  it("訊くのはクロールの組織 1 つの can_submit で、contextual tuple を送らない", async () => {
    const { fga, asked } = fakeFga(() => true);
    await exemptionEligibility(fga, alice, PERSON);
    expect(asked).toEqual([
      {
        // 鍵はこの 3 つだけ (`contextualTuples` が無い)
        request: { user: "user:alice-sub", relation: "can_submit", object: "organization:acme" },
        options: { consistency: ConsistencyPreference.HigherConsistency },
      },
    ]);
  });

  it("ヘッダで名乗る経路は none で、訊きもしない（主体が申告なので、訊いても検査にならない）", async () => {
    const { fga, asked } = fakeFga(() => true);
    for (const identityMode of ["header", "deny"] as const) {
      await expect(
        exemptionEligibility(fga, alice, { kind: "request", machine: false, identityMode }),
      ).resolves.toBe("none");
      await expect(
        exemptionEligibility(fga, alice, { kind: "request", machine: true, identityMode }),
      ).resolves.toBe("none");
    }
    expect(asked).toEqual([]);
  });

  it("組織を持たない主体のクロールは none で、訊かない", async () => {
    const { fga, asked } = fakeFga(() => true);
    await expect(
      exemptionEligibility(fga, { subject: "alice-sub", orgId: "" }, PERSON),
    ).resolves.toBe("none");
    expect(asked).toEqual([]);
  });

  it("allowed が true でない答え（欠け）は none", async () => {
    const fga = { check: () => Promise.resolve({}) } as unknown as Parameters<
      typeof exemptionEligibility
    >[0];
    await expect(exemptionEligibility(fga, alice, PERSON)).resolves.toBe("none");
  });
});
