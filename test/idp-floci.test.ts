import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet } from "jose";

/**
 * 本物の Floci（Cognito の代役）が出したトークンを、capture-ledger の resolver が確かめる往復。
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

const { cognito, CRAWL_SCOPE, RESOURCE_SERVER, START_SCOPE, TOKEN_PATH } =
  await import("../src/tools/idp.js");
const { scopeRefusal } = await import("../src/api/scope.js");
const { jwtIdentityResolver } = await import("../src/api/identity.js");

interface Client {
  ClientId: string;
  ClientSecret?: string;
}

const bearer = (jwt: string): FastifyRequest =>
  ({ headers: { authorization: `Bearer ${jwt}` } }) as unknown as FastifyRequest;

describe.skipIf(ENDPOINT === undefined)(
  "Floci のトークンを capture-ledger の resolver が確かめる",
  () => {
    let issuer = "";
    let web: Client;
    let windmill: Client;
    let stranger: Client;
    let humanTokens: { AccessToken: string; IdToken: string };
    let machineToken = "";
    let ai: Client;

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
        Scopes: [
          { ScopeName: "crawl", ScopeDescription: "crawl" },
          { ScopeName: "crawl.start", ScopeDescription: "crawl.start" },
        ],
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
      // AI の担当の client (CAPTURE-450)。狭い scope だけ・token の期限 10 分 (idp:bootstrap と同じ形)
      ai = await client("ai", {
        GenerateSecret: true,
        AllowedOAuthFlows: ["client_credentials"],
        AllowedOAuthScopes: [START_SCOPE],
        AllowedOAuthFlowsUserPoolClient: true,
        AccessTokenValidity: 10,
        TokenValidityUnits: { AccessToken: "minutes" },
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

    /** client credentials の token を取る。答えの状態と本文を返す (断られた時も読むため)。 */
    const clientToken = async (who: Client, scope: string) => {
      const res = await fetch(`${ENDPOINT ?? ""}${TOKEN_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${who.ClientId}:${who.ClientSecret ?? ""}`).toString("base64")}`,
        },
        body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const resolver = () =>
      jwtIdentityResolver(createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)), {
        issuer,
        clientIds: [web.ClientId, windmill.ClientId, ai.ClientId],
        // 名前はトークンに無く、設定 (`名前=ID`) が持つ (CAPTURE-450)
        clientNames: new Map([
          [web.ClientId, "web"],
          [windmill.ClientId, "windmill"],
          [ai.ClientId, "ai"],
        ]),
        machineOrganizations: (subject) =>
          Promise.resolve(subject === windmill.ClientId ? ["acme"] : []),
      });

    it("人の access token を受け、cognito:groups を組織にする", async () => {
      const identity = await resolver()(bearer(humanTokens.AccessToken));
      expect(identity?.organizations).toEqual(["acme"]);
      expect(identity?.subject).not.toBe("alice"); // sub は Floci が付けた ID で、名前ではない
      // 読める名前は username のクレームから。本物のトークンがこのクレームを持つことを、ここで見る (CAPTURE-450)
      expect(identity).toMatchObject({ name: "alice", client: "web" });
      expect(identity?.machine).toBeUndefined();
    });

    it("機械（client credentials）の access token を受け、組織は保存された許可から引く", async () => {
      // 機械のトークンは username を持たない。名前は app client の名前 (CAPTURE-450)
      await expect(resolver()(bearer(machineToken))).resolves.toEqual({
        subject: windmill.ClientId,
        organizations: ["acme"],
        name: "windmill",
        client: "windmill",
        machine: true,
        scopes: [CRAWL_SCOPE],
      });
    });

    /**
     * AI の担当の client (CAPTURE-450)。本物の token に狭い scope が載り、期限が設定どおりで、門が
     * 始める・読む route だけを通すことを、Floci の token で見る。
     */
    it("AI の担当の client: token に狭い scope が載り、期限は 10 分", async () => {
      const { status, body } = await clientToken(ai, START_SCOPE);
      expect(status).toBe(200);
      expect(body["expires_in"]).toBe(600);
      const identity = await resolver()(bearer(String(body["access_token"])));
      expect(identity).toMatchObject({
        name: "ai",
        client: "ai",
        machine: true,
        scopes: [START_SCOPE],
      });
      expect(scopeRefusal(identity!, "POST", "/api/crawls")).toBeUndefined();
      expect(scopeRefusal(identity!, "GET", "/api/crawls/:id")).toBeUndefined();
      expect(scopeRefusal(identity!, "POST", "/api/schedules")).toMatchObject({
        scope: CRAWL_SCOPE,
      });
      expect(scopeRefusal(identity!, "POST", "/api/crawls/:id/failed")).toMatchObject({
        scope: CRAWL_SCOPE,
      });
    });

    // 広い scope は IdP が出さない。狭い client が広い scope の token を取れないことが、AI の担当の狭さの元
    it("AI の担当の client は、広い scope の token を取れない", async () => {
      const { status, body } = await clientToken(ai, CRAWL_SCOPE);
      expect(status).toBe(400);
      expect(body["error"]).toBe("invalid_scope");
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
  },
);
