/**
 * 試験のための使い捨ての CA と時刻印の局。**試験が組んだバイト列の hash に、本物の署名を付けるため。**
 *
 * 決まった hash に署名した fixture (`test/fixtures/signing/`) は、試験が組んだ `replay.json` には使えない。
 * 置き換えの文字列で試すと、いつも true を返す検め手でも全部の試験が通る。だからここで、wacz-signer と同じ形の
 * `signedData` を作る:
 *
 * - 署名は ECDSA P-256 で、hash の **文字列** (`sha256:<hex>`) に対する DER を base64 にした物
 * - 時刻印は RFC 3161 の TimeStampResp を base64 にした物で、署名の **base64 の文字列** を覆う。
 *   局の鎖 (葉と根) を時刻印の中に入れる (dev の sigstore の局の `--include-chain-in-response=true` と同じ)
 * - `domainCert`・`timestampCert` は葉が先頭の PEM の鎖
 *
 * 鍵は一時のフォルダにだけ在り、`dispose` で消える。openssl は PATH の物か `CAPTURE_LEDGER_OPENSSL_BIN`
 * (macOS の /usr/bin/openssl は LibreSSL で `ts -reply` の設定が違う)。
 */
import { execFile } from "node:child_process";
import { sign as cryptoSign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SignedData, TrustAnchors } from "../src/replay-bundle/verify-signed-data.js";

const run = promisify(execFile);

const fromEnv = process.env["CAPTURE_LEDGER_OPENSSL_BIN"];
/** 試験が使う openssl。 */
export const OPENSSL = fromEnv === undefined || fromEnv === "" ? "openssl" : fromEnv;

/** 署名の証明書が発行される domain。 */
export const TEST_DOMAIN = "sign.test";

export interface TestCa {
  /** この CA と局の根。検める側に渡す錨。 */
  anchors: TrustAnchors;
  /** hash に署名し、時刻印を押した `signedData` を作る (wacz-signer の `/sign` の答えと同じ 9 つの欄)。 */
  sign: (hash: string) => Promise<SignedData>;
  /** 署名の base64 の文字列に、この局の時刻印を押す (base64)。別の局の時刻印に差し替える反証のため。 */
  timestamp: (signature: string) => Promise<string>;
  /** この局の鎖 (葉と根の PEM)。`signedData.timestampCert` に入る物。 */
  tsaChain: string;
  dispose: () => Promise<void>;
}

const openssl = async (dir: string, argv: string[]): Promise<void> => {
  try {
    await run(OPENSSL, argv, { cwd: dir });
  } catch (error) {
    const failed = error as { stderr?: string };
    throw new Error(`${OPENSSL} ${argv.join(" ")} failed: ${failed.stderr ?? String(error)}`, {
      cause: error,
    });
  }
};

const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];

/**
 * 根と葉を 1 組作る。`ext` は葉の拡張 (署名なら subjectAltName、局なら timeStamping)。
 * 有効期間は 2 日 —— 時刻印の時点 (いま) が窓の中に在ればよい。
 */
const issue = async (dir: string, name: string, ext: string): Promise<void> => {
  await openssl(dir, [
    "req",
    "-x509",
    ...ec,
    "-keyout",
    `${name}-ca.key`,
    "-out",
    `${name}-ca.crt`,
    "-subj",
    `/CN=insecure-test-${name}-ca`,
    "-days",
    "2",
  ]);
  await openssl(dir, [
    "req",
    "-new",
    ...ec,
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=insecure-test-${name}`,
  ]);
  await writeFile(join(dir, `${name}.ext`), ext);
  await openssl(dir, [
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${name}-ca.crt`,
    "-CAkey",
    `${name}-ca.key`,
    "-CAcreateserial",
    "-out",
    `${name}.crt`,
    "-days",
    "2",
    "-extfile",
    `${name}.ext`,
  ]);
};

/** CA と局を作る。1 回に openssl を 6 度起こすので、試験のファイルごとに 1 度 (beforeAll) で作る。 */
export const createTestCa = async (): Promise<TestCa> => {
  const dir = await mkdtemp(join(tmpdir(), "cl-test-ca-"));
  await issue(
    dir,
    "signer",
    `subjectAltName=DNS:${TEST_DOMAIN}\nkeyUsage=critical,digitalSignature\n`,
  );
  await issue(
    dir,
    "tsa",
    "extendedKeyUsage=critical,timeStamping\nkeyUsage=critical,digitalSignature\n",
  );
  await writeFile(
    join(dir, "tsa.cnf"),
    [
      "[ tsa ]",
      "default_tsa = tsa_config1",
      "[ tsa_config1 ]",
      `dir = ${dir}`,
      "serial = $dir/serial",
      "crypto_device = builtin",
      "signer_cert = $dir/tsa.crt",
      // 局の根も時刻印に入れる (sigstore の局の --include-chain-in-response=true と同じ)
      "certs = $dir/tsa-ca.crt",
      "signer_key = $dir/tsa.key",
      "signer_digest = sha256",
      "default_policy = 1.2.3.4.1",
      "digests = sha256",
      "accuracy = secs:1",
      "ordering = yes",
      "tsa_name = yes",
      "ess_cert_id_chain = no",
      "ess_cert_id_alg = sha256",
      "",
    ].join("\n"),
  );
  await writeFile(join(dir, "serial"), "01\n");

  const read = (name: string): Promise<string> => readFile(join(dir, name), "utf8");
  const [signerCa, signerCrt, signerKey, tsaCa, tsaCrt] = await Promise.all([
    read("signer-ca.crt"),
    read("signer.crt"),
    read("signer.key"),
    read("tsa-ca.crt"),
    read("tsa.crt"),
  ]);

  // 局の通し番号のファイルを 1 度に 1 つの頼みだけが書くように、順に並べる
  let queue: Promise<unknown> = Promise.resolve();
  let count = 0;
  const timestamp = (signature: string): Promise<string> => {
    const next = queue.then(async () => {
      count += 1;
      const data = join(dir, `signature-${String(count)}.b64`);
      const query = join(dir, `query-${String(count)}.tsq`);
      const reply = join(dir, `reply-${String(count)}.tsr`);
      // 時刻印が覆うのは base64 の文字列そのもの (末尾の改行を付けない)
      await writeFile(data, signature, "utf8");
      await openssl(dir, ["ts", "-query", "-data", data, "-sha256", "-cert", "-out", query]);
      await openssl(dir, [
        "ts",
        "-reply",
        "-queryfile",
        query,
        "-config",
        join(dir, "tsa.cnf"),
        "-out",
        reply,
      ]);
      return (await readFile(reply)).toString("base64");
    });
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    anchors: { signing: signerCa, timestamp: tsaCa },
    timestamp,
    tsaChain: `${tsaCrt}${tsaCa}`,
    sign: async (hash) => {
      const signature = cryptoSign("sha256", Buffer.from(hash), signerKey).toString("base64");
      return {
        hash,
        created: new Date().toISOString(),
        software: "capture-ledger test CA",
        version: "0.1.0",
        signature,
        domain: TEST_DOMAIN,
        domainCert: `${signerCrt}${signerCa}`,
        timeSignature: await timestamp(signature),
        timestampCert: `${tsaCrt}${tsaCa}`,
      };
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
};
