import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConsistencyPreference } from "@openfga/sdk";
import { registerMeRoute, type MeRouteDeps } from "../src/api/me.js";

/**
 * `GET /api/me` の検査。
 *
 * **認可そのものを見ているのではない** —— fga は言われた答えを返しているだけ。見るのは、
 * クロールの口と**同じ問い** (`can_submit`・強い一貫性) を訊いていること、そして
 * 許可が無くても 404 にせず、`canSubmit: false` として答えること。
 */
const TOUCHED = "fga に訊いた";
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error(TOUCHED);
    },
  },
);

interface CheckCall {
  body: { user: string; relation: string; object: string };
  options: { consistency?: ConsistencyPreference };
}

const fgaAnswering = (allowed: boolean) => {
  const calls: CheckCall[] = [];
  const fga = {
    check: (body: CheckCall["body"], options: CheckCall["options"]) => {
      calls.push({ body, options });
      return Promise.resolve({ allowed });
    },
  };
  return { fga, calls };
};

const buildApp = async (deps: MeRouteDeps): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  registerMeRoute(app, deps);
  await app.ready();
  return app;
};

const me = async (deps: MeRouteDeps) => {
  const app = await buildApp(deps);
  const res = await app.inject({ method: "GET", url: "/api/me" });
  await app.close();
  return res;
};

describe("GET /api/me", () => {
  it("身元が解けなければ 401 で、OpenFGA には訊かない", async () => {
    const res = await me({
      fga: untouchable as unknown as MeRouteDeps["fga"],
      resolveIdentity: () => Promise.resolve(undefined),
    });
    expect(res.statusCode).toBe(401);
  });

  it("名前と組織と、クロールを起こせるかを返す", async () => {
    const { fga } = fgaAnswering(true);
    const res = await me({
      fga: fga as unknown as MeRouteDeps["fga"],
      resolveIdentity: () => Promise.resolve({ subject: "windmill", organizations: ["acme"] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subject: "windmill", organizations: ["acme"], canSubmit: true });
  });

  it("クロールの口と同じ問いを訊く（can_submit・強い一貫性）", async () => {
    const { fga, calls } = fgaAnswering(true);
    await me({
      fga: fga as unknown as MeRouteDeps["fga"],
      resolveIdentity: () => Promise.resolve({ subject: "windmill", organizations: ["acme"] }),
    });
    expect(calls).toEqual([
      {
        body: { user: "user:windmill", relation: "can_submit", object: "organization:acme" },
        options: { consistency: ConsistencyPreference.HigherConsistency },
      },
    ]);
  });

  it("許可が無くても 404 にせず、canSubmit: false と答える", async () => {
    const { fga } = fgaAnswering(false);
    const res = await me({
      fga: fga as unknown as MeRouteDeps["fga"],
      resolveIdentity: () => Promise.resolve({ subject: "windmill", organizations: ["acme"] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subject: "windmill", organizations: ["acme"], canSubmit: false });
  });

  it("組織を持たない呼び出し元は、OpenFGA に訊かずに canSubmit: false", async () => {
    const res = await me({
      fga: untouchable as unknown as MeRouteDeps["fga"],
      resolveIdentity: () => Promise.resolve({ subject: "windmill", organizations: [] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ subject: "windmill", organizations: [], canSubmit: false });
  });
});
