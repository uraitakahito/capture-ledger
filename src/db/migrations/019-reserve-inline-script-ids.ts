/**
 * 019-reserve-inline-script-ids
 *
 * `inline-` で始まる id を目録に入れない。
 *
 * ## なぜ要るのか
 *
 * `POST /api/crawls` の `scripts` には、目録の名指しのほかに、その場で書いた JS（`inline`）を
 * 置ける。台帳はそれを目録に入れず、クロールの行の写しにだけ `inline-<name>` の id で固定する
 * （`scripts/store.ts` の `inlineScript`）。アーカイブに残るのは id と JS だけなので、**id の頭で
 * 「目録の物か、その場の物か」を分ける**。目録にも同じ頭の id があると、その区別が崩れる。
 *
 * CLI（`add`・`import`）は DB に届く前に読める文で断る（`catalogIdRefusal`）。これは、それを
 * 通り抜けた書き込み（生の SQL など）に対する最後の守り。
 *
 * 017 の列の CHECK（`id <> '' AND id = btrim(id)`、名前は Postgres が付ける）とは別の名前にする。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`ALTER TABLE scripts
    ADD CONSTRAINT scripts_id_not_inline CHECK (id NOT LIKE 'inline-%')`.execute(db);
};

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`ALTER TABLE scripts DROP CONSTRAINT scripts_id_not_inline`.execute(db);
};
