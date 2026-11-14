#!/usr/bin/env node
/**
 * 節目のスクリーンショットの在り処の表 (`archive_screenshots`・`041`) を、本物の Postgres に当てる。
 *
 * 試験は DB を立てない (`test/recording-db.ts` は Kysely が組んだ SQL を記録するだけ)。次のことは、ここでしか見られない。
 *
 *   - 3 つの形 (位置・理由・問題) の CHECK が、混ぜた行を断ること
 *   - 印 (`archives.screenshots_recorded_at`) を立てる UPDATE が、2 度目と、検めていない WACZ で当たらないこと
 *   - 確かめの SQL (`verifyStageScreenshots` の join) が通り、bigint の位置が数で読めること
 *   - アーカイブを消したときの cascade
 *
 * CI の check job が、migration を当てた後に走らせる (`.github/workflows/ci.yaml`)。手元でも走る:
 *
 *   pnpm run build:tools && DATABASE_URL=postgres://… node dist/tools/screenshots-smoke.js
 *
 * 向ける DB は使い捨ての物にすること。鍵が `smoke-<pid>/` で始まるアーカイブだけを足して、最後に消す。どれか 1 つでも
 * 期待と違えば、全部を並べてから終了コード 1。
 */
import { randomUUID } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import { sql } from "kysely";

import {
  recordStageScreenshots,
  verifyStageScreenshots,
} from "../archive/stage-screenshots-store.js";
import { createKyselyClient } from "../db/kysely.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL が無い。使い捨ての DB を指して走らせること");
  process.exit(1);
}

const db = createKyselyClient(databaseUrl);
const prefix = `smoke-${String(process.pid)}/`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
};

/** アーカイブを 1 本足す。`inspected` なら検め済み (CHECK の 3 列も入れる)。 */
const insertArchive = async (name: string, inspected: boolean): Promise<string> => {
  const row = await sql<{ id: string }>`
    insert into archives (task_id, bucket, object_key, source_url, captured_at,
                          wacz_sha256, wacz_bytes, index_empty, inspected_at)
    values (${randomUUID()}, 'smoke', ${`${prefix}${name}.wacz`}, 'http://site.test/', now(),
            ${inspected ? "0".repeat(64) : null}, ${inspected ? 1000 : null}, ${inspected ? false : null},
            ${inspected ? sql`now()` : null})
    returning id`.execute(db);
  return row.rows[0]!.id;
};

/** 断られるはずの INSERT を投げ、CHECK で断られたかを返す。 */
const rejected = async (query: Promise<unknown>): Promise<string> => {
  try {
    await query;
    return "通った";
  } catch (err) {
    return (err as { constraint?: string }).constraint ?? String(err);
  }
};

try {
  const inspected = await insertArchive("inspected", true);
  const fresh = await insertArchive("fresh", false);
  const at = new Date().toISOString();

  const rows = [
    {
      stage: "after-load",
      kind: "located" as const,
      waczOffset: 5_000_000_000,
      waczLength: 4096,
      bytes: 4000,
      recordId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    },
    { stage: "after-behaviors", kind: "skipped" as const, skipped: "withheld" },
  ];
  const first = await recordStageScreenshots(db, inspected, rows, at);
  const second = await recordStageScreenshots(db, inspected, rows, at);
  const count = await sql<{ n: number }>`
    select count(*)::int as n from archive_screenshots where archive_id = ${inspected}`.execute(db);
  check(
    "1 度目は書き、2 度目は印に当たらず何も足さない",
    first && !second && count.rows[0]?.n === 2,
    `${String(first)} ${String(second)} ${String(count.rows[0]?.n)}`,
  );

  check("検めていない WACZ には印を立てない", !(await recordStageScreenshots(db, fresh, rows, at)));

  const mixed = await rejected(
    sql`insert into archive_screenshots (archive_id, stage, skipped, wacz_offset, wacz_length, bytes, record_id)
        values (${inspected}, 'x1', 'secret', 1, 1, 1, 'r')`.execute(db),
  );
  check("理由と位置を混ぜた行は CHECK で断る", mixed === "archive_screenshots_shape_check", mixed);
  const partial = await rejected(
    sql`insert into archive_screenshots (archive_id, stage, wacz_offset, wacz_length, bytes)
        values (${inspected}, 'x2', 1, 1, 1)`.execute(db),
  );
  check(
    "record_id の無い位置の行は CHECK で断る",
    partial === "archive_screenshots_shape_check",
    partial,
  );

  // 保管庫は無い物として答える (確かめの SQL と、bigint の位置を数で読むことだけを見る)
  const asked: string[] = [];
  const noStore = {
    send: (command: { input: { Range?: string } }) => {
      asked.push(command.input.Range ?? "");
      return Promise.reject(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
    },
  } as unknown as S3Client;
  const verified = await verifyStageScreenshots({ db, s3: noStore });
  const mine = asked.filter(
    (range) => range === `bytes=5000000000-${String(5_000_000_000 + 4096 - 1)}`,
  );
  check(
    "確かめの SQL が通り、4 GiB を超える位置も数で読める",
    verified.located >= 1 && mine.length === 1,
    `${JSON.stringify(verified)} ${JSON.stringify(asked.slice(0, 3))}`,
  );

  await sql`delete from archives where id = ${inspected}`.execute(db);
  const left = await sql<{ n: number }>`
    select count(*)::int as n from archive_screenshots where archive_id = ${inspected}`.execute(db);
  check("アーカイブを消すと、在り処の行も消える", left.rows[0]?.n === 0, String(left.rows[0]?.n));
} finally {
  await sql`delete from archives where bucket = 'smoke' and object_key like ${`${prefix}%`}`.execute(
    db,
  );
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
  `✓ screenshots smoke: ${String(results.length)} 件とも期待どおり (鍵 ${prefix} の行は消した)`,
);
