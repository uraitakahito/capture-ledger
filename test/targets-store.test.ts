import { describe, it, expect } from "vitest";
import { addTargets, listTargets, removeTargets, setEnabled } from "../src/targets/store.js";
import { recordingDb } from "./recording-db.js";

/**
 * 撮る対象の芯 (`src/targets/store.ts`) が、**実際に組む SQL** を見る。
 *
 * 代役は Kysely 本体に SQL を組ませて記録する (`recording-db.ts`)。だから、組織の絞り込みを
 * 書き忘れれば SQL の文字列にそれが出る。制約が本当に効くかは、ここでは見られない
 * (CI の Postgres に当てる検査が見る)。
 */
describe("撮る対象を足す", () => {
  it("既存の行を組織で絞って引き、無いものだけを組織つきで足す", async () => {
    const { db, queries } = recordingDb([[], [{ id: "6", url: "https://example.com/" }]]);

    const result = await addTargets(db, { orgId: "acme", urls: ["https://example.com/"] });

    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual([
      "begin",
      "select",
      "insert",
      "commit",
    ]);
    expect(queries[1]?.sql).toBe(
      'select "id", "url", "enabled" from "capture_targets" where "org_id" = $1 and "url" in ($2)',
    );
    expect(queries[1]?.parameters).toEqual(["acme", "https://example.com/"]);
    expect(queries[2]?.sql).toBe(
      'insert into "capture_targets" ("url", "org_id", "labels") values ($1, $2, $3) returning "id", "url"',
    );
    expect(queries[2]?.parameters).toEqual(["https://example.com/", "acme", []]);
    expect(result).toEqual({
      kind: "ok",
      added: [{ id: "6", url: "https://example.com/" }],
      reenabled: [],
      unchanged: [],
    });
  });

  it("読めない URL が 1 本でもあれば、SQL を 1 本も出さずに名指しで返す", async () => {
    const { db, queries } = recordingDb();

    const result = await addTargets(db, {
      orgId: "acme",
      urls: ["https://example.com/", "example.org", "ftp://example.org/x"],
    });

    expect(result).toEqual({ kind: "unreadable", urls: ["example.org", "ftp://example.org/x"] });
    expect(queries).toEqual([]);
  });

  it("フラグメントを落とした形で保存し、正規化して同じになる URL は 1 本に畳む", async () => {
    const { db, queries } = recordingDb([[], [{ id: "7", url: "https://example.com/" }]]);

    await addTargets(db, {
      orgId: "acme",
      urls: ["https://example.com/#top", "https://example.com/"],
    });

    expect(queries[1]?.parameters).toEqual(["acme", "https://example.com/"]);
    expect(queries[2]?.parameters).toEqual(["https://example.com/", "acme", []]);
  });

  it("札を渡せば、足す行に付ける", async () => {
    const { db, queries } = recordingDb([[], [{ id: "8", url: "https://example.org/" }]]);

    await addTargets(db, { orgId: "acme", urls: ["https://example.org/"], labels: ["demo"] });

    expect(queries[2]?.parameters).toEqual(["https://example.org/", "acme", ["demo"]]);
  });

  it("無効だった行は有効に戻し、有効な行には触らず、足すものが無ければ INSERT しない", async () => {
    const { db, queries } = recordingDb([
      [
        { id: "1", url: "https://www.apple.com/", enabled: true },
        { id: "3", url: "https://www.cloudflare.com/", enabled: false },
      ],
    ]);

    const result = await addTargets(db, {
      orgId: "acme",
      urls: ["https://www.apple.com/", "https://www.cloudflare.com/"],
    });

    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual([
      "begin",
      "select",
      "update",
      "commit",
    ]);
    expect(queries[2]?.sql).toBe(
      'update "capture_targets" set "enabled" = $1, "updated_at" = now() where "id" in ($2)',
    );
    expect(queries[2]?.parameters).toEqual([true, "3"]);
    expect(result).toEqual({
      kind: "ok",
      added: [],
      reenabled: [{ id: "3", url: "https://www.cloudflare.com/" }],
      unchanged: [{ id: "1", url: "https://www.apple.com/" }],
    });
  });
});

describe("撮る対象を見る・外す・消す", () => {
  it("一覧は、組織を渡せばその組織で絞り、組織ごとに id の順で並べる", async () => {
    const { db, queries } = recordingDb();

    await listTargets(db, { orgId: "acme" });
    await listTargets(db, {});

    expect(queries[0]?.sql).toBe(
      'select "id", "org_id", "url", "labels", "enabled" from "capture_targets" where "org_id" = $1 order by "org_id" asc, "id" asc',
    );
    expect(queries[0]?.parameters).toEqual(["acme"]);
    expect(queries[1]?.sql).not.toContain("where");
  });

  it("見つからない id が 1 つでもあれば、何も変えずに名指しで返す", async () => {
    const { db, queries } = recordingDb([
      [{ id: "6", url: "https://example.com/", enabled: true }],
    ]);

    const result = await setEnabled(db, { ids: ["6", "99"], enabled: false });

    expect(result).toEqual({ kind: "missing", ids: ["99"] });
    expect(queries.map((q) => q.sql.split(" ")[0])).toEqual(["begin", "select", "commit"]);
  });

  it("無効にするのは、いま有効な行だけ", async () => {
    const { db, queries } = recordingDb([
      [
        { id: "6", url: "https://example.com/", enabled: true },
        { id: "7", url: "https://example.org/", enabled: false },
      ],
    ]);

    const result = await setEnabled(db, { ids: ["6", "7"], enabled: false });

    expect(queries[2]?.sql).toBe(
      'update "capture_targets" set "enabled" = $1, "updated_at" = now() where "id" in ($2)',
    );
    expect(queries[2]?.parameters).toEqual([false, "6"]);
    expect(result).toEqual({
      kind: "ok",
      changed: [{ id: "6", url: "https://example.com/" }],
      unchanged: [{ id: "7", url: "https://example.org/" }],
    });
  });

  it("消すときも、見つからない id が 1 つでもあれば何も消さない", async () => {
    const { db, queries } = recordingDb([[{ id: "6", url: "https://example.com/" }]]);

    const result = await removeTargets(db, { ids: ["6", "99"] });

    expect(result).toEqual({ kind: "missing", ids: ["99"] });
    expect(queries.some((q) => q.sql.startsWith("delete"))).toBe(false);
  });

  it("見つかった行だけを消す", async () => {
    const { db, queries } = recordingDb([[{ id: "6", url: "https://example.com/" }]]);

    const result = await removeTargets(db, { ids: ["6"] });

    expect(queries[2]?.sql).toBe('delete from "capture_targets" where "id" in ($1)');
    expect(queries[2]?.parameters).toEqual(["6"]);
    expect(result).toEqual({ kind: "ok", removed: [{ id: "6", url: "https://example.com/" }] });
  });
});
