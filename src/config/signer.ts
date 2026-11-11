/**
 * 合本に署名する設定を、env から読んで確かめる。**API と作り直しの道具が起動で読む** (`api/server.ts`・
 * `replay-bundle/rebuild-cli.ts`)。クライアントそのものは `replay-bundle/sign.ts`。
 *
 * ## 4 つで 1 組
 *
 * - `CAPTURE_LEDGER_SIGNER_URL` —— wacz-signer の `/sign`
 * - `CAPTURE_LEDGER_SIGNER_TOKEN` —— その Bearer (wacz-signer は `/sign` だけをトークンで守る)
 * - `CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR` —— 署名の鎖を照らす根 (PEM のファイル)
 * - `CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR` —— 時刻印の局の鎖を照らす根 (PEM のファイル)
 *
 * 揃えば、終わったクロールの合本に署名する。どれも無ければ署名しない。**一部だけなら起動で止める** ——
 * 宛先だけで錨が無いと、返ってきた署名を自分で検められない (BrowserHive は錨の無い段を skipped にして通すが、
 * capture-ledger は通さない)。錨だけで宛先が無いのは、署名するつもりの設定が黙って効かない形。受け取り先の 2 つ
 * (`api/server.ts`) と同じ考え。
 *
 * **`CAPTURE_LEDGER_CAPTURE_SIGNING=1` なのに無ければ止める。** WACZ に署名を求める配備は、取り込みを証拠に使う
 * 配備。そこで合本の署名が欠けると、どの WACZ がそのクロールの全部で、クロールがどう終わったかを、第三者が
 * 確かめる物が無い。
 *
 * ほかに `CAPTURE_LEDGER_SIGNER_TIMEOUT_MS` (署名を待つ時間。wacz-signer は TSA との往復を `/sign` の中で待つ) と、
 * `CAPTURE_LEDGER_OPENSSL_BIN` (時刻印を検める openssl。起動で `ts -attime` を持つかを確かめる)。錨は起動で読み、
 * 読めない・証明書が入っていないなら止める —— 合本のたびに「鎖が届かない」と言われても、直す先が分からない。
 */
import { readFileSync } from "node:fs";
import { optional } from "./env.js";
import {
  assertOpensslUsable,
  DEFAULT_OPENSSL_BIN,
  splitPemChain,
  type TrustAnchors,
} from "../replay-bundle/verify-signed-data.js";

/** 署名を待つ既定の時間。TSA との往復を含む。 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SignerConfig {
  /** wacz-signer の `/sign`。 */
  url: string;
  token: string;
  /** 読んだ錨 (PEM の中身)。 */
  anchors: TrustAnchors;
  /** 署名を待つ時間。返ってきた署名を検める openssl の 1 回の上限にも使う。 */
  timeoutMs: number;
  opensslBin: string;
}

/**
 * 錨のファイルを読む。読めない・証明書が 1 つも入っていないなら投げる (`name` は設定の名前か旗。誤りの文に出す)。
 * 合本を確かめる道具 (`replay-bundle/verify-cli.ts`) も使う。
 */
export const readAnchor = (name: string, path: string): string => {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `${name}=${path} cannot be read (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  let certificates: number;
  try {
    certificates = splitPemChain(pem).length;
  } catch {
    certificates = 0;
  }
  if (certificates === 0) {
    throw new Error(`${name}=${path} holds no PEM certificate`);
  }
  return pem;
};

/**
 * 設定を読む。どれも無ければ `undefined` (署名しない配備)。一部だけ・`CAPTURE_SIGNING=1` で無い・錨が読めない・
 * openssl が `ts -attime` を持たない、のどれでも投げる (起動で止める)。
 */
export const signerFromEnv = async (): Promise<SignerConfig | undefined> => {
  const url = optional("CAPTURE_LEDGER_SIGNER_URL", "");
  const token = optional("CAPTURE_LEDGER_SIGNER_TOKEN", "");
  const trustAnchor = optional("CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR", "");
  const timestampAnchor = optional("CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR", "");
  const given: [string, string][] = [
    ["CAPTURE_LEDGER_SIGNER_URL", url],
    ["CAPTURE_LEDGER_SIGNER_TOKEN", token],
    ["CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR", trustAnchor],
    ["CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR", timestampAnchor],
  ];
  const missing = given.filter(([, value]) => value === "").map(([name]) => name);

  if (missing.length === given.length) {
    if (optional("CAPTURE_LEDGER_CAPTURE_SIGNING", "") === "1") {
      throw new Error(
        "CAPTURE_LEDGER_CAPTURE_SIGNING=1 asks for signed WACZs, so the replay bundles of finished " +
          "crawls must be signed too: set CAPTURE_LEDGER_SIGNER_URL, CAPTURE_LEDGER_SIGNER_TOKEN, " +
          "CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR and CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR",
      );
    }
    return undefined;
  }
  if (missing.length > 0) {
    throw new Error(
      "the replay bundle signer takes 4 settings together; missing: " +
        `${missing.join(", ")} (without the anchors a signature cannot be checked before it is ` +
        "stored, and without the URL the anchors sign nothing)",
    );
  }

  const rawTimeout = optional("CAPTURE_LEDGER_SIGNER_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS));
  const timeoutMs = Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `CAPTURE_LEDGER_SIGNER_TIMEOUT_MS must be a positive number of milliseconds, not "${rawTimeout}"`,
    );
  }
  const opensslBin = optional("CAPTURE_LEDGER_OPENSSL_BIN", DEFAULT_OPENSSL_BIN);
  const anchors: TrustAnchors = {
    signing: readAnchor("CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR", trustAnchor),
    timestamp: readAnchor("CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR", timestampAnchor),
  };
  // 時刻印を検める openssl が `ts -attime` を持つか。持たなければ、どの合本も署名なしで書かれる
  await assertOpensslUsable(opensslBin, timeoutMs);
  return { url, token, anchors, timeoutMs, opensslBin };
};
