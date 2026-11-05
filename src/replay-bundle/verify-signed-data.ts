/**
 * `signedData` が、こちらが計ったバイト列の hash に対する、この配備が信頼する署名かを検める。
 *
 * ## 出所
 *
 * BrowserHive の src/storage/wacz/verify-signed-data.ts を写した物 (capture-ledger の .upstream/browserhive、
 * v25.1.0・1ce3713 から)。4 つの段 (署名・鎖・domain・時刻印)、鎖の有効期間を時刻印の時点で見ること、
 * openssl の起こし方と失敗の分け方は、元のまま。**変えたのは 3 つで、どれも「走らなかった段を合格に数えない」ため**:
 *
 * 1. **錨は 2 つとも要る。** 元は錨が無ければ段を `skipped` にして通す (WACZ の署名を、錨を持たない配備でも
 *    付けるため)。台帳は 2 つが揃わなければ起動しない (`config/signer.ts`) ので、型でも省けなくした
 * 2. **時刻印 (`timeSignature`) が無ければ落とす。** 元は `skipped`。無ければ、署名の時点を言える物も、
 *    鎖の有効期間を見る時点も無い
 * 3. **応答の `hash` の欄が、こちらの hash と同じかも見る。** 元はこちらの hash で署名を検めるだけで、欄は見ない。
 *    欄が違えば、第三者の検め (`wacz-signer verify`) は欄の hash で署名を検めるので通らない —— 置いた物が、
 *    自分では確かめられない形になる
 *
 * `ok` は 4 つの段が全部 `ok` のときだけ。元の `readTrustAnchors` (読めない錨を無い物として扱う) は写していない ——
 * 台帳は起動で読み、読めなければ止まる。
 *
 * もう 1 つ、**時刻印を openssl が拒んだ理由を分けて言う** (`timestampReason`)。元はどの拒みも「時刻印がこの署名を
 * 覆っていない」と言うので、時刻印の根を取り違えた設定 (署名の CA を渡した) が、合本の罪に見える。結末 (`failed`)
 * は変えない —— 変えるのは説明だけ。
 *
 * ## 元の注 (要点)
 *
 * 署名サービスが 200 を返したことは、それが何に署名したかについて何も言わない。署名を「在る」と記録するには、
 * 4 つが成り立つ必要がある:
 *
 *   1. 署名が *こちらの* hash に対して、葉の鍵で検められる
 *   2. 葉が、この配備の信頼する根まで繋がる
 *   3. 証明書が、応答の名乗る domain に対して発行されている
 *   4. 時刻印が *この* 署名を覆っている
 *
 * うち 3 つは `node:crypto` で、プロセスの中・一時ファイル無し。RFC 3161 だけは Node が API を持たないので、
 * openssl を起こす。**起こすのは 2 回**: 時刻印が主張する時刻 (`genTime`) を読むのに 1 回、時刻印そのものを
 * 検めるのに 1 回 —— `-attime` に渡す値を先に知る必要があるので、1 回にはまとめられない。外と接するのは
 * `runOpenssl` の 1 か所だけ。得た時刻は鎖の有効期間の判定にも使う。
 *
 * **有効期間を「今」で見ない理由。** 署名用の証明書は意図して短命なので、誰かが検める頃には失効している。
 * 答えるべきは「署名した時点で有効だったか」で、時刻印はその瞬間を固定するために在る。
 *
 * **「検めに落ちた」と「検められなかった」を混ぜない。** openssl が居ない配備で「時刻印が署名を覆っていない」と
 * 言うのは、環境の障害を合本の罪として言うことになる。どちらも `ok: false` に倒す (fail-closed) が、`reason` は
 * 別の言葉で言う。実行時にそこへ来ないための検査が `assertOpensslUsable`。
 *
 * ここでは何も throw しない —— `assertOpensslUsable` を除く (起動で 1 回だけ呼ぶ物で、throw が仕事)。
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { X509Certificate, verify as cryptoVerify } from "node:crypto";
import { Buffer } from "node:buffer";
import { err, ok, type Result } from "../types/result.js";

const execFileAsync = promisify(execFile);

/**
 * wacz-auth 0.1.0 の `signedData` のうち、検めに要る範囲。
 *
 * 意図して完全な形にしていない: `created`・`software`・`version` は記録されるが、ここでは何も検めていない。
 * 検めていない欄を型に書くと、コードがしていること以上を主張することになる。
 */
export interface SignedData {
  hash: string;
  signature: string;
  domain: string;
  /** PEM の鎖。葉が先頭。 */
  domainCert: string;
  /** base64 の RFC 3161 の応答 (TimeStampResp)。覆う対象は `signature` の base64 の *文字列*。 */
  timeSignature?: string;
  /** 時刻印の局の PEM の鎖。葉が先頭。 */
  timestampCert?: string;
  [key: string]: unknown;
}

/**
 * `ok` は走って合格、`failed` は走って不合格、`skipped` は走っていない (手前の段が落ちた)。
 * 元と違い、`skipped` のまま `ok: true` になることは無い。
 */
export type CheckOutcome = "ok" | "failed" | "skipped";

export interface VerificationChecks {
  signature: CheckOutcome;
  chain: CheckOutcome;
  domain: CheckOutcome;
  timestamp: CheckOutcome;
}

export interface VerificationResult {
  /** 4 つの段が全部 `ok` のときだけ true。 */
  ok: boolean;
  checks: VerificationChecks;
  /** `ok` が false のときに入る。最初に落ちた段を、その段の言葉で名指しする。 */
  reason?: string;
}

/** この配備が信頼する根 (PEM)。**2 つとも要る** (元は省けた)。 */
export interface TrustAnchors {
  /** `domainCert` の鎖を照らす。 */
  signing: string;
  /** 時刻印の局の鎖を照らす (`openssl ts -verify -CAfile`)。 */
  timestamp: string;
}

export interface VerifyInput {
  signedData: SignedData;
  /** こちらが計った hash (`sha256:<hex>`)。応答がこだました物ではない。 */
  hash: string;
  anchors: TrustAnchors;
  /** ここが起こす子プロセス 1 つあたりの上限。 */
  timeoutMs?: number;
  /**
   * openssl の実行ファイル。既定は `PATH` に任せる素の名前。
   *
   * 名指しできるのは、`PATH` がこのプロセスの外で決まるから —— macOS の `/usr/bin/openssl` は LibreSSL で
   * `ts -attime` を持たず、シェルの設定を読まない環境 (launchd・cron・最小構成の CI) ではそちらが先に見つかる。
   */
  opensslBin?: string;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

const DEFAULT_TIMEOUT_MS = 5_000;

/** `opensslBin` が無いときに使う名前。解決は `PATH` に任せる。 */
export const DEFAULT_OPENSSL_BIN = "openssl";

/** PEM の鎖を証明書に分ける。証明書として読めない塊があれば投げる。 */
export const splitPemChain = (pem: string): X509Certificate[] =>
  (pem.match(PEM_BLOCK) ?? []).map((block) => new X509Certificate(block));

/**
 * その証明書が `at` の時点で有効期間の内側に在るか。
 *
 * `checkIssued` も `verify` も時刻を持たない —— 前者は名前を、後者は署名を見るだけ。元にこれが足されるまで、
 * 失効した証明書で署名した物が `chain: ok` を得ていた。
 */
const validAt = (cert: X509Certificate, at: Date): boolean =>
  cert.validFromDate <= at && at <= cert.validToDate;

/**
 * 葉 → … → 錨が発行した (あるいは錨そのものである) 証明書へと辿る。
 *
 * 各段を両面から見る: `checkIssued` が名前を、`verify` が署名を。名前だけでは、正しい発行者を名乗るだけの物を
 * 受け入れてしまう。`at` が在れば、**経路に使った証明書すべて** (葉・中間・一致した錨) がその時点で有効期間の
 * 内側にあることも求める。`undefined` なら期間を見ない (時刻を裏づける物が無いのに「いつ有効だったか」を
 * 答えない)。
 */
const chainReaches = (
  chain: X509Certificate[],
  anchors: X509Certificate[],
  at: Date | undefined,
): boolean => {
  const issuedBy = (cert: X509Certificate, issuer: X509Certificate): boolean => {
    try {
      return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
    } catch {
      return false;
    }
  };
  const inWindow = (cert: X509Certificate): boolean => at === undefined || validAt(cert, at);

  for (let i = 0; i < chain.length; i += 1) {
    const cert = chain[i];
    if (cert === undefined) return false;
    // 期間の外に在る証明書は、経路の途中であっても経路を成り立たせない
    if (!inWindow(cert)) return false;
    if (anchors.some((anchor) => issuedBy(cert, anchor) && inWindow(anchor))) return true;
    const next = chain[i + 1];
    // 繋がらない鎖はどこにも届かない。失敗を錨ではなく鎖の側に留める
    if (next !== undefined && !issuedBy(cert, next)) return false;
  }
  return false;
};

/**
 * openssl が答えられなかったときの、その理由。`rejected` だけが合本についての主張で、他の 2 つはこちらの
 * 環境についての主張。
 */
export type OpensslFailure = "unavailable" | "timeout" | "rejected";

/** 失敗の種類と、そのとき openssl が言ったこと。 */
interface OpensslRejection {
  kind: OpensslFailure;
  output: string;
}

/**
 * openssl を起こす唯一の場所。
 *
 * **失敗を 3 つに分ける。** `execFile` の例外は形で見分けられる (元で実測): spawn そのものが落ちると `code` に
 * 文字列 (`ENOENT`・`EACCES`)、時間切れでは `killed` が立ち、**非ゼロの終了のときだけ `code` が数**になる。
 * 数だけが「openssl は動いて、そのうえで拒んだ」を意味する。
 *
 * 出力は 2 つの流れを繋いで返す。**openssl は `-help` も診断も stderr に書く** ので、stdout だけを読むと、
 * 答えが返っていても空を読む。
 */
const runOpenssl = async (
  bin: string,
  argv: string[],
  timeoutMs: number,
): Promise<Result<string, OpensslRejection>> => {
  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, { timeout: timeoutMs });
    return ok(`${stdout}${stderr}`);
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
    if (failed.killed === true) return err({ kind: "timeout", output });
    return err({ kind: typeof failed.code === "string" ? "unavailable" : "rejected", output });
  }
};

/**
 * 時刻印が「作られた」と主張する瞬間 (epoch からの秒)。読めなければ `undefined` —— 呼ぶ側は `-attime` 無しで
 * 検める (2 つのうち厳しいほうで、どのみち落ちる)。
 */
const genTimeOf = async (
  bin: string,
  tokenPath: string,
  timeoutMs: number,
): Promise<number | undefined> => {
  const printed = await runOpenssl(bin, ["ts", "-reply", "-in", tokenPath, "-text"], timeoutMs);
  if (!printed.ok) return undefined;
  const stamp = /^Time stamp: (.+)$/m.exec(printed.value)?.[1];
  if (stamp === undefined) return undefined;
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? undefined : Math.floor(parsed.getTime() / 1000);
};

/**
 * 鎖の判定に使ってよい時刻。取れなければ `undefined` (有効期間を見ない)。
 *
 * 時刻印の錨は必ず在る (元は無ければ取り出さなかった) ので、偽の時刻印で失効した証明書を蘇らせても、下の時刻印の
 * 段が `failed` にし、`ok: false` に至る。鎖が先に走っても穴にならない。
 */
const anchorTime = async (
  bin: string,
  timeSignature: string,
  timeoutMs: number,
): Promise<number | undefined> => {
  const dir = await mkdtemp(join(tmpdir(), "cl-at-"));
  try {
    const token = join(dir, "token.tsr");
    await writeFile(token, Buffer.from(timeSignature, "base64"));
    return await genTimeOf(bin, token, timeoutMs);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * `openssl ts -verify`。Node にできない唯一のこと。
 *
 * 時刻印が覆うのは署名の base64 の *文字列* で、バイト列ではない —— wacz-signer の形で、py-wacz の形でもある。
 * 取り違えると、正しい時刻印が偽造に見える。
 *
 * 検めは「今」ではなく時刻印が主張する時点として行う。時刻印の局の証明書が後で失効しても、有効だった間に
 * 押した物まで無効にはならない。**根は設定の錨だけ** —— 時刻印の中に入っている証明書を根に使わない
 * (`-CAfile` が錨。時刻印の中の証明書は、途中の証明書としてしか使われない)。
 *
 * これがしないのは、`genTime` が真であることの立証。漏れた鍵は、自分の有効期間の内に遡った時刻印をなお作れる。
 * RFC 3161 に残る制約で、塞ぐには独立した時刻源が要る。
 *
 * 拒まれたときは openssl の言ったこと (`output`) も返す。理由を分けて言うのに使う (`timestampReason`)。
 */
const verifyTimestamp = async (
  bin: string,
  signedData: SignedData & { timeSignature: string },
  timestampAnchor: string,
  timeoutMs: number,
  at: number | undefined,
): Promise<Result<void, OpensslRejection>> => {
  const dir = await mkdtemp(join(tmpdir(), "cl-ts-"));
  try {
    const token = join(dir, "token.tsr");
    const data = join(dir, "signature.b64");
    const root = join(dir, "root.pem");
    await Promise.all([
      writeFile(token, Buffer.from(signedData.timeSignature, "base64")),
      writeFile(data, signedData.signature, "utf-8"),
      writeFile(root, timestampAnchor, "utf-8"),
    ]);
    const argv = ["ts", "-verify", "-data", data, "-in", token, "-CAfile", root];
    if (at !== undefined) argv.push("-attime", String(at));
    const verified = await runOpenssl(bin, argv, timeoutMs);
    return verified.ok ? ok() : err(verified.error);
  } catch {
    // 一時ファイルを置けなかった。openssl には辿り着いていないので、拒まれたのではない
    return err({ kind: "unavailable", output: "" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** openssl の時刻印の誤りの、理由の所 (`…:time stamp routines:<関数>:<理由>:<源>…`)。 */
const TS_ERROR_REASON = /time stamp routines:[^:\n]*:([^:\n]+)/;

/** 証明書の検めの誤りの、詳しい所 (`…:Verify error:<理由>`)。 */
const VERIFY_ERROR_DETAIL = /Verify error:([^\n]+)/;

/**
 * 時刻印の段が落ちたときに、その種類を言葉にする。
 *
 * openssl が動いて拒んだ (`rejected`) ときは、**拒んだ理由で 2 つに分ける**。分け方は openssl の誤りの文字列で、
 * OpenSSL 1.1・3・4 で同じ (ts_err.c の理由の名前):
 *
 * - `message imprint mismatch` —— 時刻印は、この署名の文字列に押された物ではない (別の署名の時刻印)
 * - `certificate verify error` —— 時刻印の局の鎖が、時刻印の錨で検められない (錨の取り違え・自作の局・その時点で
 *   局の証明書が切れていた)。どれかは openssl の `Verify error:` の言葉で添える
 *
 * どちらでもなければ両方を言い、openssl の理由が読めれば添える。分けるのは説明だけで、どの文でも段は `failed`。
 * 根の取り違えを「署名を覆っていない」と言うと、読み手は設定ではなく合本を疑う。
 */
const timestampReason = (failure: OpensslRejection): string => {
  switch (failure.kind) {
    case "rejected": {
      const reason = TS_ERROR_REASON.exec(failure.output)?.[1]?.trim();
      if (reason === "message imprint mismatch") return "timestamp does not cover this signature";
      if (reason === "certificate verify error") {
        const detail = VERIFY_ERROR_DETAIL.exec(failure.output)?.[1]?.trim();
        return (
          "timestamp's TSA chain does not verify against the timestamp anchor" +
          (detail === undefined || detail === "" ? "" : ` (openssl: ${detail})`)
        );
      }
      return (
        "timestamp does not verify against the timestamp anchor (the TSA chain does not reach " +
        "it, or the token does not cover this signature)" +
        (reason === undefined || reason === "" ? "" : ` — openssl: ${reason}`)
      );
    }
    case "timeout":
      return "timestamp could not be checked: openssl timed out";
    case "unavailable":
      return "timestamp could not be checked: openssl could not be run";
  }
};

export const verifySignedData = async (input: VerifyInput): Promise<VerificationResult> => {
  const { signedData, hash, anchors } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = input.opensslBin ?? DEFAULT_OPENSSL_BIN;
  const checks: VerificationChecks = {
    signature: "failed",
    chain: "skipped",
    domain: "failed",
    timestamp: "skipped",
  };

  // 0. 応答の `hash` の欄 (元には無い)。第三者は欄の hash で署名を検めるので、こちらの hash と違えば通らない
  if (signedData.hash !== hash) {
    return {
      ok: false,
      checks,
      reason: `signedData.hash (${String(signedData.hash)}) is not the hash of these bytes (${hash})`,
    };
  }

  let chain: X509Certificate[];
  let leaf: X509Certificate | undefined;
  try {
    chain = splitPemChain(signedData.domainCert);
    leaf = chain[0];
  } catch (error) {
    return {
      ok: false,
      checks,
      reason: `signing certificate could not be parsed: ${String(error)}`,
    };
  }
  if (leaf === undefined) {
    return { ok: false, checks, reason: "signing certificate is missing" };
  }

  // 1. 署名。対象はこだましてきた物ではなく、こちらが計った hash
  try {
    const signed = cryptoVerify(
      "sha256",
      Buffer.from(hash),
      leaf.publicKey,
      Buffer.from(signedData.signature, "base64"),
    );
    checks.signature = signed ? "ok" : "failed";
  } catch {
    checks.signature = "failed";
  }
  if (checks.signature === "failed") {
    return { ok: false, checks, reason: "signature does not cover this hash" };
  }

  // 時刻印は必ず要る (元は無ければ skipped)。無ければ鎖の判定の基準時も無い
  const timeSignature = signedData.timeSignature;
  const hasToken = typeof timeSignature === "string" && timeSignature !== "";

  // 判定の基準時。段より前に 1 回だけ解く —— 鎖と時刻印の両方が使う
  const at = hasToken ? await anchorTime(bin, timeSignature, timeoutMs) : undefined;

  // 2. 鎖。錨は必ず在る
  let anchorCerts: X509Certificate[];
  try {
    anchorCerts = splitPemChain(anchors.signing);
  } catch {
    anchorCerts = [];
  }
  const reaches = chainReaches(
    chain,
    anchorCerts,
    at === undefined ? undefined : new Date(at * 1000),
  );
  checks.chain = reaches ? "ok" : "failed";
  if (!reaches) {
    return { ok: false, checks, reason: "certificate chain does not reach a trusted root" };
  }

  // 3. 応答が名乗る domain を、署名した証明書と突き合わせる
  checks.domain = leaf.checkHost(signedData.domain) === undefined ? "failed" : "ok";
  if (checks.domain === "failed") {
    return { ok: false, checks, reason: `certificate is not valid for ${signedData.domain}` };
  }

  // 4. 時刻印 —— 2 回目の子プロセス。無ければ落とす (元は skipped)
  if (!hasToken) {
    checks.timestamp = "failed";
    return { ok: false, checks, reason: "timestamp is missing: signedData has no timeSignature" };
  }
  const covered = await verifyTimestamp(
    bin,
    { ...signedData, timeSignature },
    anchors.timestamp,
    timeoutMs,
    at,
  );
  checks.timestamp = covered.ok ? "ok" : "failed";
  if (!covered.ok) {
    // `failed` は保つ —— openssl に訊けなかったことは、覆われている証拠にはならない。変えるのは説明だけ
    return { ok: false, checks, reason: timestampReason(covered.error) };
  }

  // 4 つが全部 ok のときだけ通す (ここに来た時点でそうだが、段を足したときに skipped を通さないよう数え直す)
  const passed = Object.values(checks).every((outcome) => outcome === "ok");
  return passed ? { ok: true, checks } : { ok: false, checks, reason: "a check did not run" };
};

/**
 * この配備の openssl が、時刻印の検めに実際に使う機能を持っているか。持っていなければ throw する。
 * **起動で 1 回だけ呼ぶ** (`config/signer.ts`)。合本のたびに静かに落ちるのを、配備した瞬間の 1 回の正しい失敗に
 * 替えるためのもの。
 *
 * **見るのは終了コードではなく `-attime` が在るか。** LibreSSL は `ts` を持ち `-reply` も通すのに `-attime` だけが
 * 無く、「時刻印だけが落ちる」という最も紛らわしい形で出る。`-help` を非ゼロで終える実装も在るので、終了コードで
 * 「使えない」と読まない。
 */
export const assertOpensslUsable = async (
  bin: string = DEFAULT_OPENSSL_BIN,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> => {
  const help = await runOpenssl(bin, ["ts", "-help"], timeoutMs);
  // 使えないと言い切れるのは、プロセスとして起こせなかったときだけ
  if (!help.ok && help.error.kind !== "rejected") {
    throw new Error(
      `${bin} could not be run (${help.error.kind}) — signing a replay bundle needs it for ` +
        "`openssl ts -verify`, the one check Node exposes no API for. Install openssl, or " +
        "point CAPTURE_LEDGER_OPENSSL_BIN at a build that works",
    );
  }
  if (!(help.ok ? help.value : help.error.output).includes("-attime")) {
    throw new Error(
      `${bin} has no \`ts -attime\` — LibreSSL (the openssl on macOS at /usr/bin/openssl) ` +
        "does not carry it, and without it every replay bundle stays unsigned while blaming " +
        "the bundle. Point CAPTURE_LEDGER_OPENSSL_BIN at an OpenSSL build",
    );
  }
};
