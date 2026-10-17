import { describe, it, expect } from "vitest";
import { addHostTypes, listScripts, readHostTypes, readScript } from "../src/scripts/store.js";
import { recordingDb } from "./recording-db.js";

/**
 * 目録を読む芯 (`src/scripts/store.ts`) が、**実際に組む SQL** を見る。
 *
 * 代役は Kysely 本体に SQL を組ませて記録する (`recording-db.ts`)。版の絞り込みを書き忘れれば、
 * SQL の文字列にそれが出る。Postgres で本当に通るかは、CI の Postgres に当てる検査が見る。
 */
describe("目録の 1 版を読む", () => {
  it("id と版で絞り、source と渡す値まで 1 行だけ引く", async () => {
    const row = { id: "autoscroll", version: 1, source: "// a\n" };
    const { db, queries } = recordingDb([[row]]);

    const result = await readScript(db, "autoscroll", 1);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toBe(
      'select "id", "version", "phase", "sha256", "enabled", octet_length(source) as "bytes", ' +
        '"created_at", "source", "options" from "scripts" where "id" = $1 and "version" = $2',
    );
    expect(queries[0]?.parameters).toEqual(["autoscroll", 1]);
    expect(result).toEqual(row);
  });

  it("有効かどうかでは絞らない（無効な版も、過去のクロールが走らせた物）", async () => {
    const { db, queries } = recordingDb([[]]);

    const result = await readScript(db, "autofetch", 3);

    expect(queries[0]?.sql).not.toContain('enabled" =');
    expect(queries[0]?.sql).not.toContain("distinct on");
    expect(result).toBeUndefined();
  });

  it("バイト数は octet_length で数える（length は文字数で、日本語のコメントで小さく出る）", async () => {
    const { db, queries } = recordingDb([[]]);

    await readScript(db, "autoscroll", 1);

    expect(queries[0]?.sql).toContain('octet_length(source) as "bytes"');
  });
});

describe("目録を並べる", () => {
  it("id を渡せば、その id だけに絞る（版を全部なら distinct on を付けない）", async () => {
    const { db, queries } = recordingDb([[]]);

    await listScripts(db, { allVersions: true, id: "autoscroll" });

    expect(queries[0]?.sql).toBe(
      'select "id", "version", "phase", "sha256", "enabled", octet_length(source) as "bytes", ' +
        '"created_at" from "scripts" where "id" = $1 order by "id", "version" desc',
    );
    expect(queries[0]?.parameters).toEqual(["autoscroll"]);
  });

  it("id を渡さなければ絞らず、各 id の最新版だけ（いままでどおり）", async () => {
    const { db, queries } = recordingDb([[]]);

    await listScripts(db);

    expect(queries[0]?.sql).toBe(
      'select distinct on ("id") "id", "version", "phase", "sha256", "enabled", ' +
        'octet_length(source) as "bytes", "created_at" from "scripts" order by "id", "version" desc',
    );
  });
});

describe("受け皿の型を足す", () => {
  it("いちばん新しい版と中身が同じなら、版を増やさない（INSERT を出さない）", async () => {
    const { db, queries } = recordingDb([
      [{ version: 1, source: "declare var __bh: {};\n", sha256: "ab" }],
    ]);

    const result = await addHostTypes(db, "declare var __bh: {};\n");

    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual(["begin", "select", "commit"]);
    expect(queries[1]?.sql).toBe(
      'select "version", "source", "sha256" from "host_types" order by "version" desc limit $1',
    );
    expect(result).toEqual({ version: 1, sha256: "ab", reused: true });
  });

  it("中身が違えば、最新 + 1 の版で足す", async () => {
    const { db, queries } = recordingDb([
      [{ version: 1, source: "declare var __bh: {};\n", sha256: "ab" }],
      [{ version: 2, sha256: "cd" }],
    ]);

    const result = await addHostTypes(db, "declare var __bh: { opts: {} };\n");

    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual([
      "begin",
      "select",
      "insert",
      "commit",
    ]);
    expect(queries[2]?.sql).toBe(
      'insert into "host_types" ("version", "source") values ($1, $2) returning "version", "sha256"',
    );
    expect(queries[2]?.parameters).toEqual([2, "declare var __bh: { opts: {} };\n"]);
    expect(result).toEqual({ version: 2, sha256: "cd", reused: false });
  });

  it("1 度も取り込んでいなければ、v1 で足す", async () => {
    const { db, queries } = recordingDb([[], [{ version: 1, sha256: "ef" }]]);

    const result = await addHostTypes(db, "declare var __bh: {};\n");

    expect(queries[2]?.parameters).toEqual([1, "declare var __bh: {};\n"]);
    expect(result).toEqual({ version: 1, sha256: "ef", reused: false });
  });
});

describe("受け皿の型を読む", () => {
  it("いちばん新しい版を 1 つだけ、バイト数つきで引く", async () => {
    const { db, queries } = recordingDb([[]]);

    const result = await readHostTypes(db);

    expect(queries[0]?.sql).toBe(
      'select "version", "sha256", "created_at", "source", octet_length(source) as "bytes" ' +
        'from "host_types" order by "version" desc limit $1',
    );
    expect(queries[0]?.parameters).toEqual([1]);
    expect(result).toBeUndefined();
  });
});
