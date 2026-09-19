import { afterEach, describe, it, expect, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet } from "jose";

import { buildDevIssuer } from "../src/dev/issuer.js";
import { jwtIdentityResolver } from "../src/api/identity.js";

/**
 * 開発用の issuer が刷ったトークンを、**本番の resolver が受け取れること**。
 *
 * これがこの一連の狙いそのもの。単体では鍵を直接渡して試せるが、それだけだと
 * 「JWKS を HTTP で取ってくる経路」が一度も走らない —— 本番で使うのはそちら。
 * ここは `createRemoteJWKSet` を通し、issuer を実際に立てて確かめる。
 */
describe("開発用の issuer", () => {
  const AUDIENCE = "capture-ledger";

  /**
   * issuer を立てて URL を渡す。片付けまで面倒を見る。
   *
   * port 0 で OS に選ばせる —— 固定すると並行して走る試験とぶつかる。
   * `iss` は issuer 自身が待受から導くので、こちらは port を知る必要が無い。
   */
  const withIssuer = async (body: (issuer: string) => Promise<void>): Promise<void> => {
    const app = await buildDevIssuer(AUDIENCE);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      await body(address);
    } finally {
      await app.close();
    }
  };

  const mint = async (issuer: string, payload: Record<string, unknown>): Promise<string> => {
    const response = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await response.json()) as { access_token?: string };
    return json.access_token ?? "";
  };

  const bearer = (token: string): FastifyRequest =>
    ({ headers: { authorization: `Bearer ${token}` } }) as unknown as FastifyRequest;

  /**
   * 鍵を覚えている API を作る: resolver を作り、1 本検証させて JWKS を取らせる。
   * 本番の API と同じく `createRemoteJWKSet` は既定のまま (覚えは 10 分、cooldown は 30 秒)。
   */
  const rememberingResolver = (issuer: string) =>
    jwtIdentityResolver(createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)), {
      issuer,
      audience: AUDIENCE,
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("刷ったトークンを、JWKS 越しに本番の resolver が受け取る", async () => {
    await withIssuer(async (issuer) => {
      const token = await mint(issuer, { subject: "alice", organizations: ["acme"] });

      const resolve = jwtIdentityResolver(
        createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
        { issuer, audience: AUDIENCE },
      );

      await expect(
        resolve({ headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest),
      ).resolves.toEqual({ subject: "alice", organizations: ["acme"] });
    });
  });

  it("discovery が jwks_uri を指す", async () => {
    await withIssuer(async (issuer) => {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`);
      await expect(response.json()).resolves.toMatchObject({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
      });
    });
  });

  it("subject を省いた要求は 400 で拒む", async () => {
    await withIssuer(async (issuer) => {
      const response = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizations: ["acme"] }),
      });
      expect(response.status).toBe(400);
    });
  });

  /**
   * 鍵は issuer の起動ごとに作り直される。**それが正しい** —— 鍵の更新をローカルで再現できる
   * ということ。
   *
   * **鍵を覚えている API で確かめる。** resolver を立て直しの「前」に作り、1 本検証させて鍵を
   * 覚えさせてから issuer を立て直す —— 動き続ける API と同じ状態。以前は立て直しの後に
   * resolver を作っていて、覚えが空のまま新しい鍵を取るので、kid が固定 (`dev-key-1`) でも
   * 緑だった。実際の API は覚えている古い鍵で照合し続け、最長 10 分、新しいトークンが
   * 401・古いトークンが通っていた。
   *
   * 時計は Date だけを進める (通信は本物)。jose は直前の取り直しから 30 秒 (cooldown) の間、
   * 知らない kid でも取り直さない。動いている API の直前の取り直しは、ふつうそれより前。
   * 2 本のトークンは 1 つの expect で見る —— 間違えるときは両方が逆さまになるので、
   * 片方だけでは何が起きたかが読めない。
   */
  it("issuer を立て直すと、鍵を覚えている API でも新しいトークンが通り、古いトークンは通らない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await buildDevIssuer(AUDIENCE);
    const address = await first.listen({ port: 0, host: "127.0.0.1" });
    const resolve = rememberingResolver(address);
    const old = await mint(address, { subject: "alice" });
    try {
      await expect(resolve(bearer(old))).resolves.toMatchObject({ subject: "alice" });
    } finally {
      await first.close();
    }

    // 同じ port で立て直す = URL は同じで、鍵だけが変わる。
    const second = await buildDevIssuer(AUDIENCE, address);
    await second.listen({ port: Number(new URL(address).port), host: "127.0.0.1" });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      const fresh = await mint(address, { subject: "bob" });
      const answers = {
        fresh: (await resolve(bearer(fresh)))?.subject,
        old: (await resolve(bearer(old)))?.subject,
      };
      expect(answers).toEqual({ fresh: "bob", old: undefined });
    } finally {
      await second.close();
    }
  });

  /**
   * jose の cooldown をここで固定する。直前の取り直しから 30 秒の間は、知らない kid でも
   * 取り直さない —— だから issuer を立て直した直後は、新しいトークンもしばらく 401 になる。
   * capture-scheduler の `check:connection` が「30 秒待つ」と言う根拠。
   */
  it("直前の取り直しから 30 秒の間は、知らない kid でも取り直さない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await buildDevIssuer(AUDIENCE);
    const address = await first.listen({ port: 0, host: "127.0.0.1" });
    const resolve = rememberingResolver(address);
    try {
      await expect(
        resolve(bearer(await mint(address, { subject: "alice" }))),
      ).resolves.toBeDefined();
    } finally {
      await first.close();
    }

    const second = await buildDevIssuer(AUDIENCE, address);
    await second.listen({ port: Number(new URL(address).port), host: "127.0.0.1" });
    try {
      const fresh = await mint(address, { subject: "bob" });
      const within = (await resolve(bearer(fresh)))?.subject;
      vi.setSystemTime(Date.now() + 31_000);
      const after = (await resolve(bearer(fresh)))?.subject;
      expect({ within, after }).toEqual({ within: undefined, after: "bob" });
    } finally {
      await second.close();
    }
  });
});
