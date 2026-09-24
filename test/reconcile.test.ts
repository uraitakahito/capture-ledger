import { beforeEach, describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Kysely } from "kysely";
import type { Database } from "../src/db/database.js";

/**
 * reconcile は、報告が書き留めた鍵だけを読む。
 *
 * **何を問うたか**を正面から見る。この repo には DB を立てる試験の土台が無いので、
 * Kysely の問い合わせは形だけを真似て、`where` に渡した条件を記録する。答えは偽物の行。
 * S3 と台帳への書き込みも偽物で、見るのは「どの鍵を読み、結果をどう数えたか」。
 */
vi.mock("../src/archive/s3.js", () => ({ getJsonObject: vi.fn() }));
vi.mock("../src/archive/admit.js", () => ({ admitArchive: vi.fn() }));
// `readManifest` の本物は契約に照らして投げる。飛ばした分岐と投げた分岐を区別するため偽物にする。
vi.mock("../src/archive/manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/archive/manifest.js")>()),
  readManifest: vi.fn((raw: unknown) => raw),
}));

const { getJsonObject } = await import("../src/archive/s3.js");
const { admitArchive } = await import("../src/archive/admit.js");
const { readManifest } = await import("../src/archive/manifest.js");
const { reconcile } = await import("../src/archive/reconcile.js");

const TASK = "550e8400-e29b-41d4-a716-446655440000";
const S3 = {} as S3Client;

/** Kysely の問い合わせの形だけを真似る。`where` の引数を順に記録し、`execute` で `rows` を返す。 */
const fakeDb = (rows: unknown[]): { db: Kysely<Database>; wheres: unknown[][] } => {
  const wheres: unknown[][] = [];
  const query = {
    leftJoin: () => query,
    select: () => query,
    $narrowType: () => query,
    where: (...args: unknown[]) => {
      wheres.push(args);
      return query;
    },
    execute: () => Promise.resolve(rows),
  };
  return { db: { selectFrom: () => query } as unknown as Kysely<Database>, wheres };
};

const row = (manifestKey: string) => ({
  taskId: TASK,
  manifestKey,
  orgId: "acme",
  submittedBy: "alice",
});

beforeEach(() => {
  vi.mocked(getJsonObject).mockReset();
  vi.mocked(admitArchive).mockReset();
  vi.mocked(readManifest).mockReset();
  vi.mocked(readManifest).mockImplementation((raw: unknown) => raw as never);
});

describe("reconcile は記録された鍵だけを読む", () => {
  /**
   * **鍵は組み直さない。** 見本は BrowserHive の命名規則では作れず、一覧を URL 符号化から
   * 戻す読み方でも化ける綴り (空白と `+`) にしてある。
   */
  it("報告された鍵を、そのまま読んで台帳に入れる", async () => {
    const { db } = fakeDb([row("elsewhere/x y+z.result.json")]);
    vi.mocked(getJsonObject).mockResolvedValue({ taskId: TASK });
    vi.mocked(admitArchive).mockResolvedValue({ archiveId: "a1" });

    const result = await reconcile(db, S3, "b");

    expect(vi.mocked(getJsonObject).mock.calls[0]?.[2]).toBe("elsewhere/x y+z.result.json");
    expect(vi.mocked(admitArchive).mock.calls[0]?.slice(2)).toEqual(["acme", "alice"]);
    expect(result).toEqual({ pending: 1, registered: 1, skipped: 0, missing: 0 });
  });

  // 一覧を挟まないので「消えた」とは言えない。報告された場所に無い、と数える。
  it("場所に無ければ missing に数え、台帳には触らない", async () => {
    const { db } = fakeDb([row("nothing-here.result.json")]);
    vi.mocked(getJsonObject).mockResolvedValue(undefined);

    const result = await reconcile(db, S3, "b");

    expect(admitArchive).not.toHaveBeenCalled();
    expect(result).toEqual({ pending: 1, registered: 0, skipped: 0, missing: 1 });
  });

  /**
   * 契約の形でない manifest (v11 以前の protobuf JSON など)。`readManifest` が投げるが、
   * 1 件で回し全体を止めない —— 次の行は読めるので、飛ばして数え、残りを続ける。
   */
  it("読めない manifest は skipped に数え、台帳には触らず、次の行へ進む", async () => {
    const { db } = fakeDb([row("v11.result.json"), row("v12.result.json")]);
    vi.mocked(getJsonObject).mockResolvedValue({ taskId: TASK });
    vi.mocked(readManifest)
      .mockImplementationOnce(() => {
        throw new Error("manifest is not a BrowserHive CaptureResultReport: data/status …");
      })
      .mockImplementationOnce((raw: unknown) => raw as never);
    vi.mocked(admitArchive).mockResolvedValue({ archiveId: "a1" });

    const result = await reconcile(db, S3, "b");

    expect(admitArchive).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ pending: 2, registered: 1, skipped: 1, missing: 0 });
  });

  // 成果物の無い manifest (cancelled など)。manifest は在るので missing ではない。
  it("台帳が受け付けなかったものは skipped", async () => {
    const { db } = fakeDb([row("cancelled.result.json")]);
    vi.mocked(getJsonObject).mockResolvedValue({ taskId: TASK });
    vi.mocked(admitArchive).mockResolvedValue({ reason: "no-archive" });

    expect(await reconcile(db, S3, "b")).toEqual({
      pending: 1,
      registered: 0,
      skipped: 1,
      missing: 0,
    });
  });

  /**
   * manifest を書けなかった取り込みには鍵が無い。**問い合わせの段階で外す** ——
   * `$narrowType` は型を言い張るだけなので、この条件を消しても typecheck は緑のまま。
   */
  it("鍵の無い行と、台帳に在る行は問わない", async () => {
    const { db, wheres } = fakeDb([]);

    await reconcile(db, S3, "b");

    expect(wheres).toContainEqual(["s.manifestKey", "is not", null]);
    expect(wheres).toContainEqual(["a.taskId", "is", null]);
  });

  it("since を渡せば、それより後に報告された行だけを問う", async () => {
    const { db, wheres } = fakeDb([]);
    const since = new Date("2026-09-13T00:00:00Z");

    await reconcile(db, S3, "b", since);

    expect(wheres).toContainEqual(["s.submittedAt", ">=", since]);
  });

  // 既定は全部。**渡さなければ時刻の条件が付かない**ことを見ないと、いつも絞る実装が緑で通る。
  it("since を渡さなければ時刻で絞らない", async () => {
    const { db, wheres } = fakeDb([]);

    await reconcile(db, S3, "b");

    expect(wheres.some((w) => w[0] === "s.submittedAt")).toBe(false);
  });
});
