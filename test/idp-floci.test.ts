import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet } from "jose";

/**
 * 本物の Floci（Cognito の代役）が出したトークンを、台帳の resolver が確かめる往復。
 *
 * 単体の `identity.test.ts` は、その場で作った鍵で「Cognito の形」のトークンを組む。こちらは
 * 形を組まない —— Floci が実際に出すトークンを、本番と同じ `createRemoteJWKSet` で取った鍵で
 * 確かめる。Floci（と、その先の Cognito）が形を変えたら、ここが赤くなる。
 *
 * Floci が居るときだけ走る。CI は `services:` に立てて `CAPTURE_LEDGER_TEST_IDP_ENDPOINT` を渡す
 * (`.github/workflows/ci.yaml` の idp)。手元では、Floci の `FLOCI_BASE_URL` と同じ値を渡す。
 */
const ENDPOINT = process.env["CAPTURE_LEDGER_TEST_IDP_ENDPOINT"];
if (ENDPOINT !== undefined) process.env["CAPTURE_LEDGER_IDP_ENDPOINT"] = ENDPOINT;

const { cognito, CRAWL_SCOPE, RESOURCE_SERVER, TOKEN_PATH } = await import("../src/tools/idp.js");
const { jwtIdentityResolver } = await import("../src/api/identity.js");

interface Client {
  ClientId: string;
  ClientSecret?: string;
}

const bearer = (jwt: string): FastifyRequest =>
  ({ headers: { authorization: `Bearer ${jwt}` } }) as unknown as FastifyRequest;

describe.skipIf(ENDPOINT === undefined)("Floci のトークンを台帳の resolver が確かめる", () => {
  let issuer = "";
  let web: Client;
  let windmill: Client;
  let stranger: Client;
  let humanTokens: { AccessToken: string; IdToken: string };
  let machineToken = "";

  beforeAll(async () => {
    const { UserPool } = await cognito<{ UserPool: { Id: string } }>("CreateUserPool", {
      PoolName: `capture-ledger-test-${String(Date.now())}`,
    });
    const pool = UserPool.Id;
    issuer = `${ENDPOINT ?? ""}/${pool}`;
    await cognito("CreateResourceServer", {
      UserPoolId: pool,
      Identifier: RESOURCE_SERVER,
      Name: RESOURCE_SERVER,
      Scopes: [{ ScopeName: "crawl", ScopeDescription: "crawl" }],
    });
    const client = async (name: string, settings: object) =>
      (
        await cognito<{ UserPoolClient: Client }>("CreateUserPoolClient", {
          UserPoolId: pool,
          ClientName: name,
          ...settings,
        })
      ).UserPoolClient;
    web = await client("web", { ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"] });
    stranger = await client("stranger", { ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"] });
    windmill = await client("windmill", {
      GenerateSecret: true,
      AllowedOAuthFlows: ["client_credentials"],
      AllowedOAuthScopes: [CRAWL_SCOPE],
      AllowedOAuthFlowsUserPoolClient: true,
    });
    await cognito("CreateGroup", { UserPoolId: pool, GroupName: "acme" });
    await cognito("AdminCreateUser", {
      UserPoolId: pool,
      Username: "alice",
      MessageAction: "SUPPRESS",
    });
    await cognito("AdminSetUserPassword", {
      UserPoolId: pool,
      Username: "alice",
      Password: "Passw0rd!test",
      Permanent: true,
    });
    await cognito("AdminAddUserToGroup", {
      UserPoolId: pool,
      Username: "alice",
      GroupName: "acme",
    });
    humanTokens = (
      await cognito<{ AuthenticationResult: { AccessToken: string; IdToken: string } }>(
        "InitiateAuth",
        {
          ClientId: web.ClientId,
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: "alice", PASSWORD: "Passw0rd!test" },
        },
      )
    ).AuthenticationResult;
    const res = await fetch(`${ENDPOINT ?? ""}${TOKEN_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${windmill.ClientId}:${windmill.ClientSecret ?? ""}`).toString("base64")}`,
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(CRAWL_SCOPE)}`,
    });
    machineToken = ((await res.json()) as { access_token: string }).access_token;
  });

  const resolver = () =>
    jwtIdentityResolver(createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)), {
      issuer,
      clientIds: [web.ClientId, windmill.ClientId],
      machineOrganizations: (subject) =>
        Promise.resolve(subject === windmill.ClientId ? ["acme"] : []),
    });

  it("人の access token を受け、cognito:groups を組織にする", async () => {
    const identity = await resolver()(bearer(humanTokens.AccessToken));
    expect(identity?.organizations).toEqual(["acme"]);
    expect(identity?.subject).not.toBe("alice"); // sub は Floci が付けた ID で、名前ではない
  });

  it("機械（client credentials）の access token を受け、組織は保存された許可から引く", async () => {
    await expect(resolver()(bearer(machineToken))).resolves.toEqual({
      subject: windmill.ClientId,
      organizations: ["acme"],
    });
  });

  it("ID token を拒む", async () => {
    await expect(resolver()(bearer(humanTokens.IdToken))).resolves.toBeUndefined();
  });

  it("受けない client の access token を拒む", async () => {
    const { AuthenticationResult } = await cognito<{
      AuthenticationResult: { AccessToken: string };
    }>("InitiateAuth", {
      ClientId: stranger.ClientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "alice", PASSWORD: "Passw0rd!test" },
    });
    await expect(resolver()(bearer(AuthenticationResult.AccessToken))).resolves.toBeUndefined();
  });

  it("署名を 1 字変えたトークンを拒む", async () => {
    const [head, body, sig = ""] = humanTokens.AccessToken.split(".");
    const flipped = `${sig.slice(0, -2)}${sig.at(-2) === "A" ? "B" : "A"}${sig.at(-1) ?? ""}`;
    await expect(
      resolver()(bearer(`${head ?? ""}.${body ?? ""}.${flipped}`)),
    ).resolves.toBeUndefined();
  });
});
