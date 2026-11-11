/**
 * 派生の層 (`026`・`034`) を読み書きする store。エンドポイントは直に SQL を書かず、これを deps で受ける —— capture-ledger には DB の試験が
 * 無く、route の試験の偽の DB は集計を真似できないので、SQL はここに閉じ込める (形は `test/derivations-store.test.ts`
 * が recording の DB で照らす)。
 */
import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";

import type { Database } from "../db/database.js";

export interface NewDerivation {
  /** `fix` は直す係 (CAPTURE-49)、`change` は前回からの変化の要約 (CAPTURE-167)。`034` の CHECK と同じ。 */
  kind: "fix" | "change";
  orgId: string;
  crawlId: string;
  /** 何のアーカイブについての物か (`034`)。 */
  archiveId?: string;
  target: Record<string, unknown>;
  inputSha256: string;
  model: string;
  promptVersion: string;
  effort: string;
  rounds: number;
  output: Record<string, unknown>;
  usage: Record<string, unknown>;
  usd: number;
  createdBy: string;
}

export interface DerivationStore {
  /** 組織がこの月 (DB の時計の月) に使った額 (USD)。 */
  spentThisMonth(orgId: string): Promise<number>;
  record(row: NewDerivation): Promise<void>;
}

export const derivationStoreOf = (db: Kysely<Database>): DerivationStore => ({
  async spentThisMonth(orgId) {
    const row = await db
      .selectFrom("derivations")
      .select(sql<string>`coalesce(sum(usd), 0)`.as("spent"))
      .where("orgId", "=", orgId)
      .where("createdAt", ">=", sql<Date>`date_trunc('month', now())`)
      .executeTakeFirst();
    // numeric は node-pg が文字列で返す
    return Number(row?.spent ?? 0);
  },
  async record(row) {
    await db
      .insertInto("derivations")
      .values({
        id: randomUUID(),
        kind: row.kind,
        orgId: row.orgId,
        crawlId: row.crawlId,
        ...(row.archiveId !== undefined && { archiveId: row.archiveId }),
        target: JSON.stringify(row.target),
        inputSha256: row.inputSha256,
        model: row.model,
        promptVersion: row.promptVersion,
        effort: row.effort,
        rounds: row.rounds,
        output: JSON.stringify(row.output),
        usage: JSON.stringify(row.usage),
        usd: row.usd.toFixed(6),
        createdBy: row.createdBy,
      })
      .execute();
  },
});
