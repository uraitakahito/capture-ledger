/**
 * API が起動したときに言うこと。
 *
 * 要になるのは、2026-09-20 00:12:55 にユーザーが起こした API と同じ形 —— webhook の 2 行だけが
 * 効き、`CAPTURE_LEDGER_API_HOST=0.0.0.0` と `CAPTURE_LEDGER_OIDC_ISSUER` が効いていなかった。
 * そのときの起動ログは、2 行が揃った API と同じ 3 行だった。いまは、足りない 2 行を warn で
 * 名指しし、最後の行が `blocked` になる。
 */
import { describe, expect, it } from "vitest";

import { startupNotes, type Note, type StartupFacts } from "../src/api/startup-notes.js";

/** 9/20 にユーザーが起こした API: 開発用ヘッダ・127.0.0.1・webhook あり。 */
const USER_0920: StartupFacts = {
  host: "127.0.0.1",
  port: 7070,
  identity: { mode: "header" },
  devIdentity: true,
  crawls: true,
  sink: false,
  search: false,
};

/** capture-scheduler の `windmill:bootstrap` が出す 4 行を貼った API。`.env.example` の DEV_IDENTITY=1 も残っている。 */
const FOUR_LINES: StartupFacts = {
  ...USER_0920,
  host: "0.0.0.0",
  identity: { mode: "jwt", issuer: "http://127.0.0.1:9099" },
};

const warnings = (facts: StartupFacts): string[] =>
  startupNotes(facts)
    .filter((note) => note.level === "warn")
    .map((note) => note.msg);

const lastLine = (facts: StartupFacts): Note | undefined => startupNotes(facts).at(-1);

describe("startupNotes", () => {
  it("9/20 に踏んだ形（ヘッダ・127.0.0.1・webhook あり）は、届かない・401 を名指しし、最後の行は blocked", () => {
    const warned = warnings(USER_0920);
    expect(warned).toContainEqual(
      expect.stringMatching(
        /^Containers cannot reach this API: it listens on 127\.0\.0\.1.*CAPTURE_LEDGER_API_HOST=0\.0\.0\.0$/,
      ),
    );
    expect(warned).toContainEqual(
      expect.stringMatching(
        /^Crawl level reports will be refused \(401\).*CAPTURE_LEDGER_OIDC_ISSUER$/,
      ),
    );
    expect(lastLine(USER_0920)?.msg).toBe(
      "Archive API listening on 127.0.0.1:7070 — identity: dev header; crawl level reports: blocked",
    );
  });

  it("4 行を貼った形（JWT・0.0.0.0・webhook あり）は warn を出さず、最後の行は ready", () => {
    expect(warnings(FOUR_LINES)).toEqual([]);
    expect(lastLine(FOUR_LINES)?.msg).toBe(
      "Archive API listening on 0.0.0.0:7070 — identity: JWT (http://127.0.0.1:9099); crawl level reports: ready",
    );
  });

  it("JWT と DEV_IDENTITY=1 が両方なら、ヘッダの警告は出さず、無視されると info で言う", () => {
    const notes = startupNotes(FOUR_LINES);
    expect(notes.map((note) => note.msg).join("\n")).not.toMatch(/callers are trusted/);
    expect(notes).toContainEqual({
      level: "info",
      msg: "CAPTURE_LEDGER_DEV_IDENTITY=1 is ignored — CAPTURE_LEDGER_OIDC_ISSUER takes precedence",
    });
  });

  it("ヘッダの設定なら、ヘッダを信じるという警告を出す", () => {
    expect(warnings(USER_0920)).toContainEqual(expect.stringMatching(/callers are trusted/));
  });

  it("webhook が無ければ段の報告は off で、127.0.0.1 でも届かないとは言わない", () => {
    const picker: StartupFacts = { ...USER_0920, crawls: false };
    expect(warnings(picker)).toEqual([expect.stringMatching(/callers are trusted/)]);
    expect(lastLine(picker)?.msg).toMatch(/crawl level reports: off$/);
  });

  it("受け口だけでも、127.0.0.1 ならコンテナから届かないと言う", () => {
    const sinkOnly: StartupFacts = { ...FOUR_LINES, host: "127.0.0.1", crawls: false, sink: true };
    expect(warnings(sinkOnly)).toEqual([
      "Containers cannot reach this API: it listens on 127.0.0.1, and artifact uploads (sink) " +
        "come from containers. Set CAPTURE_LEDGER_API_HOST=0.0.0.0",
    ]);
  });

  it("名乗りの設定が無ければ、全員 401 だと言う", () => {
    const nobody: StartupFacts = { ...FOUR_LINES, identity: { mode: "deny" }, devIdentity: false };
    expect(warnings(nobody)).toContainEqual(expect.stringMatching(/^No identity is configured/));
    expect(lastLine(nobody)?.msg).toMatch(/identity: none; crawl level reports: blocked$/);
  });

  it("ヘッダを信じる API を 0.0.0.0 で待たせると、誰にでもなれると言う（OIDC の行だけを外した形）", () => {
    const headerOnLan: StartupFacts = { ...FOUR_LINES, identity: { mode: "header" } };
    expect(warnings(headerOnLan)).toContainEqual(
      "The dev header is trusted on 0.0.0.0:7070 — anyone who can reach this port can act as any user. " +
        "Set CAPTURE_LEDGER_API_HOST=127.0.0.1, or keep CAPTURE_LEDGER_OIDC_ISSUER (the picker takes a token)",
    );
  });

  it.each(["localhost", "::1"])("%s も、コンテナから届かないアドレスと見る", (host) => {
    expect(warnings({ ...FOUR_LINES, host })).toContainEqual(
      expect.stringMatching(/^Containers cannot reach this API/),
    );
  });

  it("最後の行は、待ち受け・名乗り方・段の報告を欄にも持つ", () => {
    expect(lastLine(FOUR_LINES)?.fields).toEqual({
      host: "0.0.0.0",
      port: 7070,
      identity: "jwt",
      issuer: "http://127.0.0.1:9099",
      crawls: true,
      sink: false,
      search: false,
      crawlLevelReports: "ready",
    });
  });
});
