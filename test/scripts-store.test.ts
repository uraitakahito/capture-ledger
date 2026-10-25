import { describe, it, expect } from "vitest";
import {
  addHostTypes,
  addScript,
  enabledLatest,
  listScripts,
  offsiteScripts,
  onSeed,
  readHostTypes,
  readScript,
  resolveScripts,
  sitesRefusal,
} from "../src/scripts/store.js";
import { recordingDb } from "./recording-db.js";

/**
 * スクリプトを読む芯 (`src/scripts/store.ts`) が、**実際に組む SQL** を見る。
 *
 * 代役は Kysely 本体に SQL を組ませて記録する (`recording-db.ts`)。版の絞り込みを書き忘れれば、
 * SQL の文字列にそれが出る。Postgres で本当に通るかは、CI の `scripts/scripts-smoke.mjs` が見る。
 */
describe("スクリプトの 1 版を読む", () => {
  it("id と版で絞り、source と渡す値まで 1 行だけ引く", async () => {
    const row = { id: "autoscroll", version: 1, source: "// a\n" };
    const { db, queries } = recordingDb([[row]]);

    const result = await readScript(db, "autoscroll", 1);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toBe(
      'select "id", "version", "phase", "sha256", "sites", "enabled", octet_length(source) as "bytes", ' +
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

describe("スクリプトを並べる", () => {
  it("id を渡せば、その id だけに絞る（版を全部なら distinct on を付けない）", async () => {
    const { db, queries } = recordingDb([[]]);

    await listScripts(db, { allVersions: true, id: "autoscroll" });

    expect(queries[0]?.sql).toBe(
      'select "id", "version", "phase", "sha256", "sites", "enabled", octet_length(source) as "bytes", ' +
        '"created_at" from "scripts" where "id" = $1 order by "id", "version" desc',
    );
    expect(queries[0]?.parameters).toEqual(["autoscroll"]);
  });

  it("id を渡さなければ絞らず、各 id の最新版だけ（いままでどおり）", async () => {
    const { db, queries } = recordingDb([[]]);

    await listScripts(db);

    expect(queries[0]?.sql).toBe(
      'select distinct on ("id") "id", "version", "phase", "sha256", "sites", "enabled", ' +
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

describe("札の形（021 の CHECK と capture-scripts の check と同じ式）", () => {
  it("小文字のホスト名・punycode・開発のホスト名は通す", () => {
    expect(
      sitesRefusal(["www.google.com", "xn--wgv71a.jp", "capture-fixtures.capture-ledger"]),
    ).toBeUndefined();
  });

  it("大文字・ポート・scheme・空・先頭の - は断り、断った札を名指す", () => {
    for (const bad of ["Google.com", "google.com:443", "https://google.com", "", "-bad.com"]) {
      expect(sitesRefusal(["www.google.com", bad])).toContain(`: ${bad}`);
    }
  });

  it("同じホスト名を 2 度は断る", () => {
    expect(sitesRefusal(["www.google.com", "www.google.com"])).toBe("札に同じホスト名が 2 度ある");
  });
});

describe("起点で選べるか", () => {
  it("札が無ければどの起点でも、札があれば起点のホスト名が 1 つ合えば", () => {
    expect(onSeed([], [])).toBe(true);
    expect(onSeed(["www.google.com"], ["example.com", "www.google.com"])).toBe(true);
    expect(onSeed(["www.google.com"], ["google.com"])).toBe(false); // www の有無は別のホスト
    expect(onSeed(["www.google.com"], [])).toBe(false);
  });

  it("名指しで入れたサイト用のスクリプトのうち、起点に合わない物を札つきで返す（その場の JS は札を持たない）", () => {
    const script = {
      version: 1,
      phase: "behavior" as const,
      source: "x",
      sha256: "h",
      options: {},
    };
    expect(
      offsiteScripts(
        [
          { ...script, id: "autoscroll", sites: [] },
          { ...script, id: "google-results", sites: ["www.google.com"] },
          { ...script, id: "inline-pad" },
          { ...script, id: "example-title", sites: ["example.com"] },
        ],
        ["example.com"],
      ),
    ).toEqual([{ id: "google-results", sites: ["www.google.com"] }]);
  });
});

describe("走らせるものを決める（scripts を省いた頼み）", () => {
  const row = (id: string, version: number, sites: string[]) => ({
    id,
    version,
    phase: "behavior",
    source: `// ${id} v${String(version)}`,
    sha256: "h",
    options: {},
    sites,
  });

  it("有効な各 id の最新版を引き、札で絞るのは引いた後（SQL に札の条件を書かない）", async () => {
    const { db, queries } = recordingDb([[]]);

    await resolveScripts(db, undefined, ["example.com"]);

    expect(queries[0]?.sql).toBe(
      'select distinct on ("id") "id", "version", "phase", "source", "sha256", "options", "sites" ' +
        'from "scripts" where "enabled" = $1 order by "id", "version" desc',
    );
  });

  it("札の無い物と、起点に合う物だけを残す（合わない最新版の代わりに古い版を出さない）", async () => {
    // DB が返すのは各 id の最新版だけ。google-results は v2 だけが来る（v1 に札が無くても出てこない）
    const { db } = recordingDb([
      [
        row("autofetch", 1, []),
        row("example-title", 3, ["example.com"]),
        row("google-results", 2, ["www.google.com"]),
      ],
    ]);

    const result = await resolveScripts(db, undefined, ["example.com"]);

    expect(
      result.kind === "ok" && result.scripts.map((s) => `${s.id}@${String(s.version)}`),
    ).toEqual(["autofetch@1", "example-title@3"]);
  });

  it("起点が無ければ、札の無い物だけ", async () => {
    const { db } = recordingDb([
      [row("autofetch", 1, []), row("example-title", 1, ["example.com"])],
    ]);

    const result = await resolveScripts(db);

    expect(result.kind === "ok" && result.scripts.map((s) => s.id)).toEqual(["autofetch"]);
  });

  it("写しに札を入れる（クロールの詳しい所が返す）", async () => {
    const { db } = recordingDb([[row("example-title", 1, ["example.com"])]]);

    const result = await resolveScripts(db, undefined, ["example.com"]);

    expect(result.kind === "ok" && result.scripts[0]?.sites).toEqual(["example.com"]);
  });
});

describe("有効な各 id の最新版（GET /api/scripts）", () => {
  it("札つきで、サイト用のスクリプトも入れる（source は引かない）", async () => {
    const { db, queries } = recordingDb([[]]);

    await enabledLatest(db);

    expect(queries[0]?.sql).toBe(
      'select distinct on ("id") "id", "version", "phase", "sha256", "sites" from "scripts" ' +
        'where "enabled" = $1 order by "id", "version" desc',
    );
  });
});

describe("札を足す（options と同じ扱い）", () => {
  const latest = { version: 1, source: "x;", sha256: "h", options: {}, sites: ["example.com"] };

  it("札を渡さなければ、中身が同じなら版を増やさない（意見が無い）", async () => {
    const { db, queries } = recordingDb([[latest]]);

    const result = await addScript(db, { id: "example-title", phase: "behavior", source: "x;" });

    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual(["begin", "select", "commit"]);
    expect(result.reused).toBe(true);
  });

  it("違う札を渡せば、中身が同じでも版を足す", async () => {
    const { db, queries } = recordingDb([[latest], [{ version: 2, sha256: "h" }]]);

    const result = await addScript(db, {
      id: "example-title",
      phase: "behavior",
      source: "x;",
      sites: ["www.example.com"],
    });

    expect(queries[2]?.sql).toContain('insert into "scripts"');
    expect(queries[2]?.parameters).toContainEqual(["www.example.com"]);
    expect(result.version).toBe(2);
  });

  it("同じ札を渡せば、版を増やさない", async () => {
    const { db, queries } = recordingDb([[latest]]);

    await addScript(db, {
      id: "example-title",
      phase: "behavior",
      source: "x;",
      sites: ["example.com"],
    });

    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual(["begin", "select", "commit"]);
  });
});
