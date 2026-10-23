import { describe, it, expect } from "vitest";
import type { OpenFgaClient } from "@openfga/sdk";
import { isUniqueViolation, maySubmit } from "../src/api/authorization.js";

/**
 * route が共有する認可の道具。
 *
 * この 2 つは `runs` と `crawls` の両方が使うので、**片方の route の試験だけでは
 * 守れない**。壊したときにどちらも赤くなることは反証で確かめたが、それとは別に
 * ここで境目を直接押さえる。
 */

describe("unique 違反の見分け", () => {
  const violation = (code: string, constraint: string): Error =>
    Object.assign(new Error("duplicate key"), { code, constraint });

  it("recognises the constraint it was asked about", () => {
    expect(
      isUniqueViolation(violation("23505", "runs_single_active_idx"), "runs_single_active"),
    ).toBe(true);
  });

  it("refuses a unique violation from a different constraint", () => {
    // **これが肝。** `crawl_pages` の `(crawl_id, url_hash)` も、
    // `capture_submissions` の `task_id` も 23505 を投げる。名前を見ないと、
    // 重複 URL を 1 件入れただけで「走行中の 2 本目」として 409 を返すことになる。
    const err = violation("23505", "crawl_pages_crawl_id_url_hash_key");
    expect(isUniqueViolation(err, "runs_single_active")).toBe(false);
    expect(isUniqueViolation(err, "crawls_single_active")).toBe(false);
  });

  it("refuses a different SQLSTATE even with a matching name", () => {
    // 23503 は外部キー違反。名前が似ていても、これは「走行中」ではない。
    expect(
      isUniqueViolation(violation("23503", "runs_single_active_idx"), "runs_single_active"),
    ).toBe(false);
  });

  it("refuses an error that carries no constraint", () => {
    expect(isUniqueViolation(Object.assign(new Error("x"), { code: "23505" }), "runs")).toBe(false);
  });

  it("refuses things that are not errors at all", () => {
    for (const value of [null, undefined, "23505", 23505]) {
      expect(isUniqueViolation(value, "runs_single_active")).toBe(false);
    }
  });
});

describe("取り込みを始めてよいか", () => {
  const fga = (allowed: boolean | boolean[]): OpenFgaClient => {
    const answers = Array.isArray(allowed) ? [...allowed] : null;
    return {
      check: () => Promise.resolve({ allowed: answers === null ? allowed : answers.shift() }),
    } as unknown as OpenFgaClient;
  };

  it("refuses a caller who belongs to nothing, without consulting fga", async () => {
    // 押さえているのは **fga に訊きに行かないこと**。「false を返すこと」のほうは
    // 早期 return を消しても成り立つ (`Promise.all([])` が `[]` を返すため) ので、
    // その 1 行の有無はどんな試験でも区別できない —— `authorization.ts` に明記した。
    //
    // 一方この試験は、既定の組織を補うような書き換えが入れば赤くなる。
    const touched = {
      check: () => Promise.reject(new Error("fga に触れた")),
    } as unknown as OpenFgaClient;
    await expect(maySubmit(touched, { subject: "alice", organizations: [] })).resolves.toBe(false);
  });

  it("allows when any one organization allows it", async () => {
    // 1 つ許されていれば始められる。**その 1 つの許可で他の組織の対象も投げられる**ので、
    // 付与は組織を跨いで信頼できる相手にだけ。
    await expect(
      maySubmit(fga([false, true]), { subject: "alice", organizations: ["a", "b"] }),
    ).resolves.toBe(true);
  });

  it("refuses when none allow it", async () => {
    await expect(
      maySubmit(fga(false), { subject: "alice", organizations: ["a", "b"] }),
    ).resolves.toBe(false);
  });
});
