import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyRequest } from "fastify";
import { SignJWT, generateKeyPair } from "jose";
import {
  denyAllResolver,
  devIdentityResolver,
  jwtIdentityResolver,
  selectIdentity,
} from "../src/api/identity.js";

const request = (headers: Record<string, string>): FastifyRequest =>
  ({ headers }) as unknown as FastifyRequest;

describe("devIdentityResolver", () => {
  it("reads the subject and organizations from headers", async () => {
    await expect(
      devIdentityResolver(
        request({
          "x-capture-ledger-subject": "bob",
          "x-capture-ledger-organizations": "acme,contoso",
        }),
      ),
    ).resolves.toEqual({ subject: "bob", organizations: ["acme", "contoso"] });
  });

  it("trims and drops empty organization entries", async () => {
    await expect(
      devIdentityResolver(
        request({
          "x-capture-ledger-subject": "bob",
          "x-capture-ledger-organizations": " acme , , contoso ,",
        }),
      ),
    ).resolves.toEqual({ subject: "bob", organizations: ["acme", "contoso"] });
  });

  it("yields no organizations when the header is absent", async () => {
    await expect(
      devIdentityResolver(request({ "x-capture-ledger-subject": "bob" })),
    ).resolves.toEqual({
      subject: "bob",
      organizations: [],
    });
  });

  // subject が無いことは identity が無いということ —— route は `user:undefined` に
  // 対する Check へ落ちるのではなく、401 で答える。
  it("returns undefined without a subject", async () => {
    await expect(devIdentityResolver(request({}))).resolves.toBeUndefined();
    await expect(
      devIdentityResolver(request({ "x-capture-ledger-subject": "" })),
    ).resolves.toBeUndefined();
  });
});

describe("selectIdentity", () => {
  const original = process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
  beforeEach(() => {
    delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
    else process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = original;
  });

  // header の resolver は言われたことを何でも信じるので、設定していない配備が
  // 事故でそれを手にしてはならない。
  it("denies everyone by default", async () => {
    const identity = selectIdentity();
    expect(identity).toMatchObject({ mode: "deny", resolve: denyAllResolver });
    await expect(
      identity.resolve(request({ "x-capture-ledger-subject": "mallory" })),
    ).resolves.toBeUndefined();
  });

  it("only enables the dev resolver on an exact opt-in", () => {
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "true";
    expect(selectIdentity()).toMatchObject({ mode: "deny", resolve: denyAllResolver });
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
    expect(selectIdentity()).toMatchObject({ mode: "header", resolve: devIdentityResolver });
  });

  /**
   * issuer が設定されていれば JWT の resolver を選ぶ。**開発用ヘッダより優先する** ——
   * 両方設定された環境で、弱いほう (そのポートに届く者が誰にでもなれる) へ
   * 落ちてはいけない。
   */
  it("issuer が在れば、開発用ヘッダより JWT を優先する", async () => {
    const originalIssuer = process.env["CAPTURE_LEDGER_OIDC_ISSUER"];
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
    process.env["CAPTURE_LEDGER_OIDC_ISSUER"] = "http://127.0.0.1:9099";
    try {
      const identity = selectIdentity();
      // どれを選んだかも返す —— 起動ログがこれを言う (`startup-notes.ts`)。
      expect(identity).toMatchObject({
        mode: "jwt",
        issuer: "http://127.0.0.1:9099",
        audience: "capture-ledger",
      });
      expect(identity.resolve).not.toBe(devIdentityResolver);
      // ヘッダだけを渡しても、もう通らない。
      await expect(
        identity.resolve(request({ "x-capture-ledger-subject": "mallory" })),
      ).resolves.toBeUndefined();
    } finally {
      if (originalIssuer === undefined) delete process.env["CAPTURE_LEDGER_OIDC_ISSUER"];
      else process.env["CAPTURE_LEDGER_OIDC_ISSUER"] = originalIssuer;
    }
  });
});

/**
 * JWT を検証する resolver。
 *
 * **これが案 1 (ヘッダを信じる) では書けなかった試験**。署名・issuer・audience・
 * 期限は、本物の IdP を繋いだ日に初めて動くコードだった。ここで毎日動かす。
 *
 * 鍵を引数で受け取る形にしてあるので、issuer を立てずに試せる。本番は
 * `createRemoteJWKSet(...)` を渡し、ここでは作ったばかりの鍵を渡す ——
 * `jose` の `jwtVerify` がどちらも受ける。
 */
const ISSUER = "http://127.0.0.1:9099";
const AUDIENCE = "capture-ledger";

// describe の中では await できないので、module の頭で作る。
const keys = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");

describe("jwtIdentityResolver", () => {
  const token = async (
    claims: Record<string, unknown>,
    opts: { key?: CryptoKey; issuer?: string; audience?: string; expires?: string } = {},
  ): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.expires ?? "1h")
      .sign(opts.key ?? keys.privateKey);

  const resolve = jwtIdentityResolver(keys.publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  const bearer = (jwt: string): FastifyRequest => request({ authorization: `Bearer ${jwt}` });

  it("sub と組織のクレームを Identity に写す", async () => {
    await expect(
      resolve(bearer(await token({ sub: "alice", organizations: ["acme"] }))),
    ).resolves.toEqual({ subject: "alice", organizations: ["acme"] });
  });

  it("別の鍵で署名されたトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token({ sub: "mallory" }, { key: other.privateKey }))),
    ).resolves.toBeUndefined();
  });

  it("issuer が合わないトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token({ sub: "alice" }, { issuer: "https://evil.example" }))),
    ).resolves.toBeUndefined();
  });

  it("audience が合わないトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token({ sub: "alice" }, { audience: "someone-else" }))),
    ).resolves.toBeUndefined();
  });

  it("期限切れのトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token({ sub: "alice" }, { expires: "-1h" }))),
    ).resolves.toBeUndefined();
  });

  // 「どこにも属さない人」は表せる必要がある —— 組織が無いことは不正ではない。
  it("組織のクレームが無ければ、組織は空になる", async () => {
    await expect(resolve(bearer(await token({ sub: "alice" })))).resolves.toEqual({
      subject: "alice",
      organizations: [],
    });
  });

  it("sub が無いトークンを拒む", async () => {
    await expect(resolve(bearer(await token({})))).resolves.toBeUndefined();
  });

  it("Authorization ヘッダが無い要求を拒む", async () => {
    await expect(resolve(request({}))).resolves.toBeUndefined();
  });

  /**
   * 前置きは **`Bearer ` と同じ 7 文字**にする。`Basic ` (6 文字) だと
   * `slice(7)` がトークンの先頭を削って署名検証が落ちるので、
   * `startsWith` を外しても試験が通ってしまった —— 偶然で守られていた。
   * 同じ長さなら、防壁は `startsWith` 1 つだけになる。
   */
  it("Bearer でない Authorization ヘッダを拒む", async () => {
    await expect(
      resolve(request({ authorization: `Sneaky ${await token({ sub: "alice" })}` })),
    ).resolves.toBeUndefined();
  });
});
