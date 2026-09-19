import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { SignJWT, generateKeyPair } from "jose";

/**
 * JWT を拒んだとき、API のログに理由が残ること。**呼び手には返さない**のはそのまま
 * (`identity.test.ts` がどの場合も `undefined` であることを見ている)。
 *
 * ログの中身は 2 つの向きで見る: 直すのに要るもの (jose の code と、落ちたクレームの名前)
 * が載っていること、そして載せてはいけないもの (トークンと、クレームの値) が載っていないこと。
 * jose のクレームのエラーはトークンの中身を抱えているので、エラーをそのまま渡すと後者が崩れる。
 */
const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../src/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger.js")>();
  return {
    ...actual,
    createChildLogger: () => ({ info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

const { jwtIdentityResolver } = await import("../src/api/identity.js");

const ISSUER = "http://127.0.0.1:9099";
const AUDIENCE = "capture-ledger";
const keys = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");

const token = (opts: { key?: CryptoKey; issuer?: string; audience?: string } = {}) =>
  new SignJWT({ organizations: ["secret-org"] })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("alice")
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(opts.key ?? keys.privateKey);

const resolve = jwtIdentityResolver(keys.publicKey, { issuer: ISSUER, audience: AUDIENCE });
const bearer = (jwt: string): FastifyRequest =>
  ({ headers: { authorization: `Bearer ${jwt}` } }) as unknown as FastifyRequest;

describe("JWT を拒んだ理由のログ", () => {
  beforeEach(() => {
    info.mockClear();
  });

  it.each([
    ["別の鍵の署名", { key: other.privateKey }, { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }],
    [
      "iss が合わない",
      { issuer: "http://localhost:9099" },
      { code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "iss" },
    ],
    [
      "aud が合わない",
      { audience: "someone-else" },
      { code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "aud" },
    ],
  ])("%s: code と claim を残す", async (_, opts, expected) => {
    await expect(resolve(bearer(await token(opts)))).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expected, "JWT rejected");
  });

  it("トークンとクレームの値は、ログに載せない", async () => {
    const jwt = await token({ issuer: "http://localhost:9099" });
    await resolve(bearer(jwt));
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(jwt);
    expect(logged).not.toContain("secret-org");
    expect(logged).not.toContain("alice");
  });

  it("受け取ったトークンでは、何も残さない", async () => {
    await expect(resolve(bearer(await token()))).resolves.toMatchObject({ subject: "alice" });
    expect(info).not.toHaveBeenCalled();
  });
});
