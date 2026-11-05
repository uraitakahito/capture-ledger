/**
 * 合本の署名の設定 (`src/config/signer.ts`)。**4 つで 1 組** —— 一部だけ・WACZ の署名を求めるのに無い・錨が読めない・
 * openssl が `ts -attime` を持たない、はどれも起動で止める。API と作り直しの道具が同じこれを呼ぶ。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signerFromEnv } from "../src/config/signer.js";
import { OPENSSL } from "./signing-ca.js";

const FIXTURES = join(import.meta.dirname, "fixtures/signing");
const SIGNING_ANCHOR = join(FIXTURES, "insecure-dev-ca.crt");
const TIMESTAMP_ANCHOR = join(FIXTURES, "insecure-dev-tsa-ca.crt");

const FOUR = {
  CAPTURE_LEDGER_SIGNER_URL: "http://127.0.0.1:18091/sign",
  CAPTURE_LEDGER_SIGNER_TOKEN: "dev-token",
  CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR: SIGNING_ANCHOR,
  CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR: TIMESTAMP_ANCHOR,
};
type Name = keyof typeof FOUR;
const NAMES = Object.keys(FOUR) as Name[];

/** 署名の設定に関わる変数を全部消してから、渡した物だけを置く。 */
const env = (values: Partial<Record<string, string>>): void => {
  for (const name of [
    ...NAMES,
    "CAPTURE_LEDGER_SIGNER_TIMEOUT_MS",
    "CAPTURE_LEDGER_OPENSSL_BIN",
    "CAPTURE_LEDGER_CAPTURE_SIGNING",
  ]) {
    vi.stubEnv(name, undefined);
  }
  // 試験が使う openssl (PATH の物か CAPTURE_LEDGER_OPENSSL_BIN)。起動の確かめは本物に当てる
  vi.stubEnv("CAPTURE_LEDGER_OPENSSL_BIN", OPENSSL);
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("合本の署名の設定", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cl-signer-config-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("4 つとも無ければ署名しない（undefined）", async () => {
    env({});
    await expect(signerFromEnv()).resolves.toBeUndefined();
  });

  // 既定の openssl (PATH の物) を使えない機械 (CAPTURE_LEDGER_OPENSSL_BIN で別の物を渡す) では飛ばす
  it.skipIf(OPENSSL !== "openssl")(
    "4 つが揃えば、錨を読み、待ち時間と openssl の既定を入れて返す",
    async () => {
      env(FOUR);
      vi.stubEnv("CAPTURE_LEDGER_OPENSSL_BIN", undefined);
      await expect(signerFromEnv()).resolves.toEqual({
        url: FOUR.CAPTURE_LEDGER_SIGNER_URL,
        token: "dev-token",
        anchors: {
          signing: readFileSync(SIGNING_ANCHOR, "utf8"),
          timestamp: readFileSync(TIMESTAMP_ANCHOR, "utf8"),
        },
        timeoutMs: 10_000,
        opensslBin: "openssl",
      });
    },
  );

  it("待ち時間と openssl は設定で変えられる", async () => {
    env({ ...FOUR, CAPTURE_LEDGER_SIGNER_TIMEOUT_MS: "2500" });
    await expect(signerFromEnv()).resolves.toMatchObject({ timeoutMs: 2500, opensslBin: OPENSSL });
  });

  it.each(NAMES)("%s だけが欠ければ、その名前を言って止める", async (missing) => {
    env(
      Object.fromEntries(
        NAMES.filter((name) => name !== missing).map((name) => [name, FOUR[name]]),
      ),
    );
    await expect(signerFromEnv()).rejects.toThrow(`missing: ${missing} `);
  });

  it("宛先だけ（錨が無い）でも止める —— 返ってきた署名を置く前に検められない", async () => {
    env({ CAPTURE_LEDGER_SIGNER_URL: FOUR.CAPTURE_LEDGER_SIGNER_URL });
    await expect(signerFromEnv()).rejects.toThrow(
      "missing: CAPTURE_LEDGER_SIGNER_TOKEN, CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR, " +
        "CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR",
    );
  });

  it("WACZ に署名を求める配備（CAPTURE_LEDGER_CAPTURE_SIGNING=1）で 4 つとも無ければ止める", async () => {
    env({ CAPTURE_LEDGER_CAPTURE_SIGNING: "1" });
    await expect(signerFromEnv()).rejects.toThrow(
      /CAPTURE_LEDGER_CAPTURE_SIGNING=1 .* CAPTURE_LEDGER_SIGNER_URL/s,
    );
  });

  it("CAPTURE_LEDGER_CAPTURE_SIGNING=1 でも、4 つが揃えば起動する", async () => {
    env({ ...FOUR, CAPTURE_LEDGER_CAPTURE_SIGNING: "1" });
    await expect(signerFromEnv()).resolves.toMatchObject({ url: FOUR.CAPTURE_LEDGER_SIGNER_URL });
  });

  it("錨のファイルが読めなければ、名前と path を言って止める", async () => {
    const path = join(dir, "no-such.crt");
    env({ ...FOUR, CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR: path });
    await expect(signerFromEnv()).rejects.toThrow(
      `CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR=${path} cannot be read`,
    );
  });

  it("錨のファイルに証明書が入っていなければ止める", async () => {
    const path = join(dir, "not-a-cert.pem");
    await writeFile(path, "not a certificate\n");
    env({ ...FOUR, CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR: path });
    await expect(signerFromEnv()).rejects.toThrow(
      `CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR=${path} holds no PEM certificate`,
    );
  });

  it("待ち時間が正の整数でなければ止める", async () => {
    env({ ...FOUR, CAPTURE_LEDGER_SIGNER_TIMEOUT_MS: "soon" });
    await expect(signerFromEnv()).rejects.toThrow(/CAPTURE_LEDGER_SIGNER_TIMEOUT_MS .*"soon"/);
  });

  it("openssl が ts -attime を持たなければ止める（LibreSSL の形）", async () => {
    const libre = join(dir, "openssl-libressl");
    await writeFile(libre, "#!/bin/sh\necho 'usage: ts -reply -in file -text' >&2\nexit 1\n");
    await chmod(libre, 0o755);
    env({ ...FOUR, CAPTURE_LEDGER_OPENSSL_BIN: libre });
    await expect(signerFromEnv()).rejects.toThrow(/has no `ts -attime`/);
  });
});
