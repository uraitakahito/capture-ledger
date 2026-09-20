/**
 * 値の出どころを言う 1 行。
 *
 * 要になるのは **重なり**。`.env` と `.env.local` は node に順番で渡してあり、後の
 * ほうが勝つ。勝ち負けを黙ると「`.env` を直したのに値が変わらない」という形で
 * 時間が溶けるので、重なった名前は起動時に名指しする。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { envFilesNote, readEnvFiles, type EnvFileFacts } from "../src/config/env-files.js";

const dirs: string[] = [];

/** その場に `.env` などを置いた使い捨ての cwd。 */
const withFiles = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "capture-ledger-env-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

describe("readEnvFiles", () => {
  it("宣言されている名前だけを拾い、コメント行は数えない", () => {
    const dir = withFiles({
      ".env": "# LOG_LEVEL=debug\nDATABASE_URL=postgres://x\n\nexport REPLAY_ORIGIN=http://x\n",
    });
    const [dotEnv, local] = readEnvFiles(dir);
    expect(dotEnv).toEqual<EnvFileFacts>({
      file: ".env",
      exists: true,
      names: ["DATABASE_URL", "REPLAY_ORIGIN"],
    });
    expect(local?.exists).toBe(false);
  });

  it("値は返さない —— 出どころの説明に値は要らず、ログに出れば鍵がログに出る", () => {
    const dir = withFiles({ ".env": "CAPTURE_LEDGER_S3_SECRET_ACCESS_KEY=hunter2\n" });
    expect(JSON.stringify(readEnvFiles(dir))).not.toContain("hunter2");
  });
});

describe("envFilesNote", () => {
  const facts = (file: string, names: string[]): EnvFileFacts => ({ file, exists: true, names });

  it("重なった名前は、勝つファイルの名で名指しする", () => {
    const note = envFilesNote([
      facts(".env", ["DATABASE_URL", "CAPTURE_LEDGER_FGA_STORE_ID"]),
      facts(".env.local", ["CAPTURE_LEDGER_FGA_STORE_ID", "CAPTURE_LEDGER_FGA_MODEL_ID"]),
    ]);
    expect(note).toBe(
      "config: .env (2 names), .env.local (2 names) — " +
        ".env.local wins for CAPTURE_LEDGER_FGA_STORE_ID (a value set in the shell beats the files)",
    );
  });

  it("重なりが無ければ勝ち負けを言わない —— 言うことが無いときは黙る", () => {
    const note = envFilesNote([
      facts(".env", ["DATABASE_URL"]),
      facts(".env.local", ["CAPTURE_LEDGER_FGA_STORE_ID"]),
    ]);
    expect(note).toBe("config: .env (1 name), .env.local (1 name)");
  });

  it("無いファイルは並べない", () => {
    const note = envFilesNote([
      facts(".env", ["DATABASE_URL"]),
      { file: ".env.local", exists: false, names: [] },
    ]);
    expect(note).toBe("config: .env (1 name)");
  });

  it("1 枚も無ければ、値はすべて端末から来ると言う", () => {
    const note = envFilesNote([
      { file: ".env", exists: false, names: [] },
      { file: ".env.local", exists: false, names: [] },
    ]);
    expect(note).toContain("no env file was read");
  });
});
