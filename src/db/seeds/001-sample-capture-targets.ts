/**
 * 001-sample-capture-targets
 *
 * ローカルの開発と本番構成の smoke test が使うサンプルの URL。
 *
 * 冪等性は `kysely_seed` の記録が与える —— 一度当たったファイルを migrator が
 * 飛ばす —— ので、SQL の seed に在った `ON CONFLICT (url_hash) DO NOTHING` は
 * もう要らない。
 *
 * `down` は `RESTART IDENTITY` 付きで truncate する。BIGSERIAL の `id` の
 * カウンタが巻き戻るので、往復のテストにおいて、作りたての `CREATE TABLE` と
 * 区別が付かない状態に戻る。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../database.js";

export const up = async (db: Kysely<Database>): Promise<void> => {
  await db
    .insertInto("captureTargets")
    .values([
      // `orgId` は列の既定 ("default") に任せない。対象一覧からクロールを始める経路
      // (`POST /api/crawls` の `fromTargets`) は `data/url-source.ts` の
      // `loadTargets` を通り、そこが **呼んだ人の組織で絞る** —— 別の組織の対象を
      // 混ぜると、クロールが持つ 1 つの `org_id` では帰属が言えなくなるから。
      //
      // docs が案内する開発用の主体は `X-Capture-ledger-Organizations: acme` なので、
      // 既定の "default" のままだと 1 件も一致せず
      // `no enabled capture targets for this organization` で 400 になる。
      // seed が在るのに空、という一番読めない出方をする。
      { url: "https://www.apple.com/", labels: ["Apple"], orgId: "acme" },
      { url: "https://www.microsoft.com/", labels: ["Microsoft"], orgId: "acme" },
      { url: "https://www.cloudflare.com/", labels: ["Cloudflare"], orgId: "acme" },
      { url: "https://www.ana.co.jp/group/", labels: ["9202", "ANAHoldings"], orgId: "acme" },
      { url: "https://www.datadoghq.com/", labels: ["Datadog"], orgId: "acme" },
    ])
    .execute();
};

export const down = async (db: Kysely<Database>): Promise<void> => {
  await sql`TRUNCATE TABLE capture_targets RESTART IDENTITY`.execute(db);
};
