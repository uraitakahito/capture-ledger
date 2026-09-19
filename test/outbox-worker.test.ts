import type { OpenFgaClient } from "@openfga/sdk";
import { describe, expect, it, vi } from "vitest";
import { drainOutbox } from "../src/fga/outbox-worker.js";
import { recordingDb } from "./recording-db.js";

/**
 * OpenFGA に届かないときは、最初の 1 行で掃き出しを止める。
 *
 * 見ているのは「届かない」と「届いたが断られた」の違いだけ —— 前者で残りの行を試しても
 * 同じ誤りが並ぶだけなので止め、後者は 1 行の失敗で batch を落とさない (既存の約束) ので
 * 最後まで試す。この 2 つを同じ行の並びで比べる。
 */
const rows = [
  {
    id: 1,
    payload: { writes: [{ user: "user:a", relation: "owner", object: "archive:1" }] },
    attempts: 0,
  },
  {
    id: 2,
    payload: { writes: [{ user: "user:b", relation: "owner", object: "archive:2" }] },
    attempts: 0,
  },
];

const failingFga = (message: string) => {
  const write = vi.fn(() => Promise.reject(new Error(message)));
  return { fga: { write } as unknown as OpenFgaClient, write };
};

const updates = (queries: { sql: string }[]) =>
  queries.filter((query) => query.sql.startsWith('update "fga_outbox"'));

describe("drainOutbox", () => {
  it("届かなければ最初の 1 行で止め、その文を返す", async () => {
    const { db, queries } = recordingDb([rows]);
    const refused = "FGA Error: connect ECONNREFUSED ::1:8090; connect ECONNREFUSED 127.0.0.1:8090";
    const { fga, write } = failingFga(refused);

    const result = await drainOutbox(db, fga);

    expect(result).toEqual({ delivered: 0, failed: 1, unreachable: refused });
    expect(write).toHaveBeenCalledTimes(1);
    // 試した 1 行だけ attempts を増やし、止めた後ろの行には触らない。
    expect(updates(queries)).toHaveLength(1);
    expect(queries.at(-1)?.sql).toBe("commit");
  });

  it("届いたが断られたなら、残りの行も試す（1 行の失敗で batch を落とさない）", async () => {
    const { db, queries } = recordingDb([rows]);
    const { fga, write } = failingFga("FGA API Internal Error: post write : boom");

    const result = await drainOutbox(db, fga);

    expect(result).toEqual({ delivered: 0, failed: 2 });
    expect(write).toHaveBeenCalledTimes(2);
    expect(updates(queries)).toHaveLength(2);
  });
});
