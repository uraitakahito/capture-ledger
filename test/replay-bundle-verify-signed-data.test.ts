/**
 * 合本の署名を検める所 (`src/replay-bundle/verify-signed-data.ts`)。BrowserHive の試験
 * (test/storage/wacz/verify-signed-data.test.ts、v25.1.0) を写し、台帳で厳しくした 3 つ (錨は 2 つとも要る・
 * 時刻印が無ければ落とす・`signedData.hash` の欄も見る) と、自作の時刻印の局の対を足した。
 *
 * fixture は本物 (`test/fixtures/signing/`。wacz-signer が dev の CA で作った `signedData`)。置き換えの文字列に
 * すると、いつも true を返す検め手がここの全部を通る。だから各段を両方向で固定する —— 通る入力と、その段だけを
 * 落とす 1 つの改変。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOpensslUsable,
  verifySignedData,
  type SignedData,
} from "../src/replay-bundle/verify-signed-data.js";
import { createTestCa, OPENSSL, type TestCa } from "./signing-ca.js";

const FIXTURES = join(import.meta.dirname, "fixtures/signing");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf-8");

const HASH = "sha256:0be7b2fea93622c434c8f205494e2d0b451acae3803dc87420b6ef51e151239c";

const fixture = (): SignedData => JSON.parse(read("signed-data.json")) as SignedData;

const anchors = {
  signing: read("insecure-dev-ca.crt"),
  timestamp: read("insecure-dev-tsa-ca.crt"),
};

const verify = (
  signedData: SignedData,
  over: Partial<Parameters<typeof verifySignedData>[0]> = {},
) => verifySignedData({ signedData, hash: HASH, anchors, opensslBin: OPENSSL, ...over });

describe("検め —— 通る形", () => {
  it("wacz-signer が dev の CA で作った署名は、4 つの段が全部 ok", async () => {
    const result = await verify(fixture());
    expect(result).toEqual({
      ok: true,
      checks: { signature: "ok", chain: "ok", domain: "ok", timestamp: "ok" },
    });
  });

  it("試験の CA (test/signing-ca.ts) が作った署名も、その錨で通る", async () => {
    // 合本の試験はこの CA で署名する。ここで通らなければ、合本の試験の「落ちた」は CA の誤りかもしれない
    const ca = await createTestCa();
    try {
      const hash = `sha256:${"ab".repeat(32)}`;
      const result = await verifySignedData({
        signedData: await ca.sign(hash),
        hash,
        anchors: ca.anchors,
        opensslBin: OPENSSL,
      });
      expect(result).toEqual({
        ok: true,
        checks: { signature: "ok", chain: "ok", domain: "ok", timestamp: "ok" },
      });
    } finally {
      await ca.dispose();
    }
  });
});

describe("検め —— hash と署名", () => {
  it("応答の hash の欄がこちらの hash と違えば落とす（別の物の正しい署名）", async () => {
    // 署名も鎖も時刻印も本物で、違うのは対象だけ。別の合本の replay-digest.json を持ってきた形
    const result = await verify(fixture(), {
      hash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    });
    expect(result.ok).toBe(false);
    expect(result.checks.signature).toBe("failed");
    expect(result.reason).toContain("signedData.hash");
  });

  it("hash の欄を書き換えても、署名がこちらの hash を覆っていなければ落とす", async () => {
    // 欄だけ合わせた偽物。欄を見るだけの検めはこれを通す
    const forged = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const result = await verify({ ...fixture(), hash: forged }, { hash: forged });
    expect(result.ok).toBe(false);
    expect(result.checks.signature).toBe("failed");
    expect(result.reason).toBe("signature does not cover this hash");
  });

  it("書き換えた署名を落とす", async () => {
    const signedData = fixture();
    const bytes = Buffer.from(signedData.signature, "base64");
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff;
    signedData.signature = bytes.toString("base64");

    const result = await verify(signedData);
    expect(result.ok).toBe(false);
    expect(result.checks.signature).toBe("failed");
  });
});

describe("検め —— 鎖", () => {
  it("錨に届かない鎖を落とす（別の根で検める）", async () => {
    const result = await verify(fixture(), {
      anchors: { ...anchors, signing: read("other-ca.pem") },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.chain).toBe("failed");
    // 署名には触っていないので、動くのは鎖だけ
    expect(result.checks.signature).toBe("ok");
  });

  it("錨が証明書として読めなければ、鎖は届かない（skipped にしない）", async () => {
    const result = await verify(fixture(), { anchors: { ...anchors, signing: "not a pem" } });
    expect(result.ok).toBe(false);
    expect(result.checks.chain).toBe("failed");
  });

  /**
   * 時刻印の時点で失効していた証明書。`checkIssued` も `verify` も時刻を持たないので、期間を見なければ通る。
   * 葉・発行者・中間の 3 つは独立に間違えうる (葉だけ・錨だけを見る実装を、それぞれ 1 つの fixture が捕まえる)。
   */
  it("時刻印の時点で葉が失効していた鎖を落とす", async () => {
    const expired = JSON.parse(read("expired-signer-signed-data.json")) as SignedData;
    const result = await verify(expired, {
      hash: expired.hash,
      anchors: { signing: read("expired-signer-ca.crt"), timestamp: anchors.timestamp },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.signature).toBe("ok");
    expect(result.checks.chain).toBe("failed");
  });

  it("葉が有効でも、発行者が失効していた鎖を落とす", async () => {
    const expired = JSON.parse(read("expired-issuer-signed-data.json")) as SignedData;
    const result = await verify(expired, {
      hash: expired.hash,
      anchors: { signing: read("expired-signer-ca.crt"), timestamp: anchors.timestamp },
    });
    expect(result.checks.signature).toBe("ok");
    expect(result.checks.chain).toBe("failed");
  });

  it("葉と根が有効でも、中間が失効していた鎖を落とす", async () => {
    const expired = JSON.parse(read("expired-intermediate-signed-data.json")) as SignedData;
    const result = await verify(expired, {
      hash: expired.hash,
      anchors: { signing: read("expired-intermediate-root.crt"), timestamp: anchors.timestamp },
    });
    expect(result.checks.signature).toBe("ok");
    expect(result.checks.chain).toBe("failed");
  });
});

describe("検め —— domain", () => {
  it("証明書が発行されていない domain を名乗れば落とす", async () => {
    const result = await verify({ ...fixture(), domain: "not-the-signer.test" });
    expect(result.ok).toBe(false);
    expect(result.checks.domain).toBe("failed");
    expect(result.checks.signature).toBe("ok");
  });
});

describe("検め —— 時刻印", () => {
  it("時刻印を剥がした署名は落とす（元は skipped で通していた）", async () => {
    const withoutToken = fixture();
    delete withoutToken.timeSignature;
    const result = await verify(withoutToken);
    expect(result.ok).toBe(false);
    expect(result.checks.timestamp).toBe("failed");
    expect(result.reason).toBe("timestamp is missing: signedData has no timeSignature");
    // その手前は通っている —— 落ちたのは時刻印が無いから
    expect(result.checks.signature).toBe("ok");
    expect(result.checks.chain).toBe("ok");
    expect(result.checks.domain).toBe("ok");
  });

  it("空の時刻印も、無いのと同じに落とす", async () => {
    const result = await verify({ ...fixture(), timeSignature: "" });
    expect(result.ok).toBe(false);
    expect(result.checks.timestamp).toBe("failed");
  });

  it("別の署名に押した本物の時刻印を落とし、この署名を覆っていないと言う", async () => {
    // 時刻印は本物で同じ局の物。別の署名に属している —— 合本どうしで時刻印を入れ替えた形
    const signedData = { ...fixture(), timeSignature: read("other-time-signature.txt").trim() };
    const result = await verify(signedData);
    expect(result.ok).toBe(false);
    expect(result.checks.timestamp).toBe("failed");
    expect(result.reason).toBe("timestamp does not cover this signature");
    expect(result.checks.signature).toBe("ok");
    expect(result.checks.chain).toBe("ok");
    expect(result.checks.domain).toBe("ok");
  });

  it("時刻印の根に署名の CA を渡せば（根の取り違え）、局の鎖が錨で検められないと言う（覆っていないとは言わない）", async () => {
    // 時刻印そのものは正しい。誤っているのは設定 —— 「この署名を覆っていない」と言うと、読み手は合本を疑う
    const result = await verify(fixture(), {
      anchors: { signing: anchors.signing, timestamp: anchors.signing },
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual({
      signature: "ok",
      chain: "ok",
      domain: "ok",
      timestamp: "failed",
    });
    expect(result.reason).toMatch(
      /^timestamp's TSA chain does not verify against the timestamp anchor \(openssl: .+\)$/,
    );
    expect(result.reason).not.toContain("does not cover");
  });

  /**
   * 自作の局の時刻印。局の鎖を時刻印の中に持つので、時刻印の中の証明書を根に使う検め (`wacz-signer verify`) は
   * これを通す。台帳は設定の錨で検めるので落とす。自作の根を錨に渡せば通る —— 落ちたのは錨のせいで、
   * 時刻印が壊れているからではない。
   *
   * fixture ではなく試験の CA で作る: 自作の局の時刻印の genTime は「いま」で、fixture の葉 (2026-10-30 に失効)
   * は、その時点では鎖の段で先に落ちる。時刻印の段だけを落とすには、葉がいま有効でなければならない。
   */
  describe("自作の時刻印の局", () => {
    let ca: TestCa;
    let rogue: TestCa;
    const hash = `sha256:${"cd".repeat(32)}`;

    beforeAll(async () => {
      [ca, rogue] = await Promise.all([createTestCa(), createTestCa()]);
    });

    afterAll(async () => {
      await Promise.all([ca.dispose(), rogue.dispose()]);
    });

    /**
     * 署名は本物の CA の物、時刻印は自作の局が同じ署名に押した物。`timestampCert` も自作の局の鎖にする ——
     * 辻褄の合った偽物で、答えの中の局の鎖を根に使う検めなら通る形。
     */
    const withRogueToken = async (): Promise<SignedData> => {
      const signedData = await ca.sign(hash);
      return {
        ...signedData,
        timeSignature: await rogue.timestamp(signedData.signature),
        timestampCert: rogue.tsaChain,
      };
    };

    it("自作の局が押した時刻印は、設定の局の根では落ちる", async () => {
      const result = await verifySignedData({
        signedData: await withRogueToken(),
        hash,
        anchors: ca.anchors,
        opensslBin: OPENSSL,
      });
      expect(result.ok).toBe(false);
      expect(result.checks).toEqual({
        signature: "ok",
        chain: "ok",
        domain: "ok",
        timestamp: "failed",
      });
      // 時刻印は自作の局の鎖を持つ。設定の局の根には届かない
      expect(result.reason).toMatch(
        /^timestamp's TSA chain does not verify against the timestamp anchor \(openssl: .+\)$/,
      );
    });

    it("自作の局が押した時刻印は、自作の局の根を錨にすれば通る（上の対）", async () => {
      const result = await verifySignedData({
        signedData: await withRogueToken(),
        hash,
        anchors: { signing: ca.anchors.signing, timestamp: rogue.anchors.timestamp },
        opensslBin: OPENSSL,
      });
      expect(result.ok).toBe(true);
    });

    it("本物の時刻印も、自作の局の根で検めれば落ちる", async () => {
      const result = await verifySignedData({
        signedData: await ca.sign(hash),
        hash,
        anchors: { signing: ca.anchors.signing, timestamp: rogue.anchors.timestamp },
        opensslBin: OPENSSL,
      });
      expect(result.ok).toBe(false);
      expect(result.checks.timestamp).toBe("failed");
      expect(result.reason).toMatch(
        /^timestamp's TSA chain does not verify against the timestamp anchor \(openssl: .+\)$/,
      );
    });
  });

  it("局の証明書が後で失効していても、有効だった間に押した時刻印は通る", async () => {
    // 時刻印の眼目は、それを作った鍵より長生きすること。2036 年に dev の CA が失効しても、合本は検められる
    const signedData = { ...fixture(), timeSignature: read("expired-time-signature.txt").trim() };
    const result = await verify(signedData, {
      anchors: { signing: anchors.signing, timestamp: read("expired-tsa-ca.crt") },
    });
    expect(result.checks.timestamp).toBe("ok");
    expect(result.ok).toBe(true);
  });

  it("時刻印が無ければ鎖の期間は見ないが、時刻印が無いこと自体で落ちる", async () => {
    // 元では「時刻を裏づける物が無ければ期間を見ない」で通っていた形。台帳は時刻印を必ず求めるので落ちる
    const expired = JSON.parse(read("expired-signer-signed-data.json")) as SignedData;
    delete expired.timeSignature;
    const result = await verify(expired, {
      hash: expired.hash,
      anchors: { signing: read("expired-signer-ca.crt"), timestamp: anchors.timestamp },
    });
    expect(result.checks.chain).toBe("ok");
    expect(result.checks.timestamp).toBe("failed");
    expect(result.ok).toBe(false);
  });
});

describe("検め —— 読めない入力", () => {
  it("証明書でない証明書は、投げずに落とす", async () => {
    const result = await verify({
      ...fixture(),
      domainCert: "-----BEGIN CERTIFICATE-----\nnope\n",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("証明書が 1 つも無ければ、投げずに落とす", async () => {
    const result = await verify({ ...fixture(), domainCert: "" });
    expect(result).toMatchObject({ ok: false, reason: "signing certificate is missing" });
  });
});

/**
 * 実行できる偽の openssl を置く。モックではなく本物のプロセスを起こす —— `execFile` の例外は失敗の種類ごとに
 * 形が違い、分け方が正しいことは実物を起こしてしか確かめられない。
 */
const fakeOpenssl = async (dir: string, name: string, script: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
};

describe("検め —— openssl に訊けなかったとき", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cl-openssl-fail-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("openssl を起こせなければ落とし、合本のせいにしない", async () => {
    const result = await verify(fixture(), { opensslBin: join(dir, "no-such-openssl") });
    expect(result.ok).toBe(false);
    expect(result.checks.timestamp).toBe("failed");
    expect(result.reason).toContain("openssl could not be run");
    expect(result.reason).not.toContain("does not cover");
  });

  it("openssl が時間切れになれば、そう言う", async () => {
    // 引数が何であれ答えない物。/bin/sleep は使えない (`ts -reply` を数として読めず、すぐ非ゼロで終わる)
    const hangs = await fakeOpenssl(dir, "openssl-hangs", "#!/bin/sh\nsleep 30\n");
    const result = await verify(fixture(), { opensslBin: hangs, timeoutMs: 150 });
    expect(result.ok).toBe(false);
    expect(result.checks.timestamp).toBe("failed");
    expect(result.reason).toContain("openssl timed out");
  });

  /**
   * openssl は動いて拒んだが、理由が「覆っていない」とも「局の鎖が検められない」とも読めないとき。どちらかを
   * 言い張らず、両方を言う。openssl の理由の名前が読めれば添える。
   */
  it("拒んだ理由が読めなければ、両方を言う", async () => {
    const vague = await fakeOpenssl(
      dir,
      "openssl-vague",
      "#!/bin/sh\necho 'Verification: FAILED' >&2\nexit 1\n",
    );
    const result = await verify(fixture(), { opensslBin: vague });
    expect(result.checks.timestamp).toBe("failed");
    expect(result.reason).toBe(
      "timestamp does not verify against the timestamp anchor (the TSA chain does not reach it, " +
        "or the token does not cover this signature)",
    );
  });

  it("拒んだ理由がほかの名前なら、両方を言い、openssl の名前を添える", async () => {
    const other = await fakeOpenssl(
      dir,
      "openssl-signature-failure",
      "#!/bin/sh\necho '00:error:17800068:time stamp routines:ts_check_signer_certs:" +
        "signature failure:crypto/ts/ts_rsp_verify.c:300:' >&2\nexit 1\n",
    );
    const result = await verify(fixture(), { opensslBin: other });
    expect(result.reason).toBe(
      "timestamp does not verify against the timestamp anchor (the TSA chain does not reach it, " +
        "or the token does not cover this signature) — openssl: signature failure",
    );
  });
});

/**
 * 配備した瞬間に 1 回だけ、正しい理由で落ちる。偽の openssl は「終了コード 0 で、`-attime` を含まない help を
 * stderr に書く」物 —— 終了コードで判定する実装と、stdout だけを読む実装を、どちらも捕まえるため。
 */
describe("openssl の確かめ (起動で 1 回)", () => {
  let dir: string;
  let capable: string;
  let incapable: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cl-openssl-probe-"));
    incapable = await fakeOpenssl(
      dir,
      "openssl-no-attime",
      "#!/bin/sh\necho 'usage: ts -reply -in file -text' >&2\nexit 0\n",
    );
    // 対にする。同じ形・同じ終了コードで `-attime` だけが在る物は通る
    capable = await fakeOpenssl(
      dir,
      "openssl-with-attime",
      "#!/bin/sh\necho 'usage: ts -verify -attime seconds' >&2\nexit 0\n",
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("試験が使う openssl は通る", async () => {
    await expect(assertOpensslUsable(OPENSSL)).resolves.toBeUndefined();
  });

  it("ts -attime を持つ openssl は通る", async () => {
    await expect(assertOpensslUsable(capable)).resolves.toBeUndefined();
  });

  it("ts -attime を持たない openssl を拒み、設定の名前を言う", async () => {
    await expect(assertOpensslUsable(incapable)).rejects.toThrow(
      /ts -attime.*CAPTURE_LEDGER_OPENSSL_BIN/s,
    );
  });

  it("openssl が居なければ拒む", async () => {
    await expect(assertOpensslUsable(join(dir, "no-such-openssl"))).rejects.toThrow(
      /could not be run \(unavailable\)/,
    );
  });
});
