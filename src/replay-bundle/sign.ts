/**
 * 合本の `replay.json` の hash に、wacz-signer の署名を貰い、**置く前に自分で検める** (`replay-bundle/write.ts` が
 * 呼ぶ)。設定は `config/signer.ts`。
 *
 * BrowserHive の createHttpSigner (src/storage/wacz/signer.ts、v25.1.0) に倣った: 頼み方 (`POST /sign` に
 * `{"hash":"sha256:<hex>"}` と Bearer)、時間切れ (`AbortSignal.timeout`)、答えの形の確かめ、そして
 * **投げずに理由を返す**こと。違うのは検めの厳しさ (`replay-bundle/verify-signed-data.ts`): 走らなかった段を
 * 合格に数えず、応答の `hash` の欄も見る。
 *
 * 署名が付かなくても合本は書く (呼ぶ側が決める)。ここが返すのは「署名と、それが確かなこと」か「付かなかった
 * 理由」で、理由は台帳の `crawls.replay_bundle_sign_error` に残る。理由にはいつも宛先を入れる —— 署名の付かない
 * 合本ができる最も多い原因は、宛先が何も指していないこと。
 */
import { verifySignedData, type SignedData } from "./verify-signed-data.js";
import type { SignerConfig } from "../config/signer.js";

/** 署名が付いたか。付いたなら、検めを通った `signedData`。 */
export type SignOutcome =
  { signed: true; signedData: SignedData } | { signed: false; reason: string };

export interface ReplayBundleSigner {
  /** `hash` (`sha256:<hex>`) に署名を頼み、検める。**投げない。** */
  sign: (hash: string) => Promise<SignOutcome>;
}

/** `<url> — <何が起きたか>`。 */
const describe = (url: string, what: string): string => `${url} — ${what}`;

/**
 * 何が起きたか。`fetch` はどの転送の失敗も "fetch failed" と言い、本当の理由は `cause` に入れる
 * (名前が引けない・繋がらない)。両方を言う。
 */
const explain = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
};

/** wacz-auth の `signedData` の形か。検めに使う欄が文字列で在るかだけを見る (中身は検めが見る)。 */
const isSignedData = (value: unknown): value is SignedData => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const text = (name: string): boolean => typeof fields[name] === "string";
  const textIfPresent = (name: string): boolean => !(name in fields) || text(name);
  return (
    text("hash") &&
    text("signature") &&
    text("domain") &&
    text("domainCert") &&
    textIfPresent("timeSignature") &&
    textIfPresent("timestampCert")
  );
};

export const createReplayBundleSigner = (config: SignerConfig): ReplayBundleSigner => ({
  async sign(hash) {
    try {
      const res = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({ hash }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!res.ok) {
        // 番号が診断そのもの: 401 はトークン違い、502 は wacz-signer が TSA に届かない
        return { signed: false, reason: describe(config.url, `returned ${String(res.status)}`) };
      }
      const body: unknown = await res.json();
      if (!isSignedData(body)) {
        return { signed: false, reason: describe(config.url, "returned no signedData") };
      }
      // 200 は、何に署名したかについて何も言わない。置く前に、こちらの hash と錨で検める
      const verified = await verifySignedData({
        signedData: body,
        hash,
        anchors: config.anchors,
        timeoutMs: config.timeoutMs,
        opensslBin: config.opensslBin,
      });
      if (!verified.ok) {
        return {
          signed: false,
          reason: describe(config.url, verified.reason ?? "the signature did not verify"),
        };
      }
      return { signed: true, signedData: body };
    } catch (err) {
      // 時間切れ・名前が引けない・繋がらない・壊れた JSON。どれも「署名なしで書け」の意味になる
      return { signed: false, reason: describe(config.url, explain(err)) };
    }
  },
});
