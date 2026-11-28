import { describe, it, expect, beforeAll, vi } from "vitest";
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

const {
  cognito,
  syncClient,
  CRAWL_SCOPE,
  RESOURCE_SERVER,
  START_SCOPE,
  TOKEN_PATH,
  WORKBENCH_CLIENT,
  WORKBENCH_SIGNED_OUT,
} = await import("../src/tools/idp.js");
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

/**
 * workbench の client の、サインアウトの後の戻り先 (t-6nje)。workbench は「サインアウト」で IdP の logout の口へ回す ——
 * 戻り先 (`LogoutURLs`) が client に無いと、IdP は 400 で断り、人が IdP の誤りの頁で止まる。前の bootstrap が作った
 * client (戻り先が無い) に `idp:bootstrap` が足せること、足しても client の ID が変わらないこと、Floci の logout の口の
 * 形 (登録した物と 1 字でも違えば断る) を、ここで留める。
 */
describe.skipIf(ENDPOINT === undefined)(
  "workbench の client に、サインアウトの後の戻り先を足す",
  () => {
    interface WorkbenchClient {
      ClientId: string;
      ClientName: string;
      ClientSecret?: string;
      CallbackURLs?: string[];
      LogoutURLs?: string[];
    }
    let pool = "";
    let made: WorkbenchClient;

    /** 設定から、名指した欄を除く。 */
    const without = (settings: Record<string, unknown>, ...names: string[]) =>
      Object.fromEntries(Object.entries(settings).filter(([name]) => !names.includes(name)));

    const describeClient = async (id: string) =>
      (
        await cognito<{ UserPoolClient: WorkbenchClient }>("DescribeUserPoolClient", {
          UserPoolId: pool,
          ClientId: id,
        })
      ).UserPoolClient;

    /** logout の口を引く (回された先へは行かない)。 */
    const logout = (clientId: string, uri: string) =>
      fetch(
        `${ENDPOINT ?? ""}/cognito-idp/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(uri)}`,
        { redirect: "manual" },
      );

    /** `fetch` が Cognito の管理の API をいくつ呼んだか (`run` の間)。 */
    const managementCalls = async (run: () => Promise<unknown>) => {
      const spy = vi.spyOn(globalThis, "fetch");
      try {
        await run();
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    beforeAll(async () => {
      const { UserPool } = await cognito<{ UserPool: { Id: string } }>("CreateUserPool", {
        PoolName: `capture-ledger-test-logout-${String(Date.now())}`,
      });
      pool = UserPool.Id;
      // 前の bootstrap が作った形: 戻り先 (LogoutURLs) の無い client
      made = (
        await cognito<{ UserPoolClient: WorkbenchClient }>("CreateUserPoolClient", {
          UserPoolId: pool,
          ClientName: "workbench",
          ...without(WORKBENCH_CLIENT, "LogoutURLs"),
        })
      ).UserPoolClient;
    });

    it("戻り先の無い client では、logout の口が断る", async () => {
      expect((await logout(made.ClientId, WORKBENCH_SIGNED_OUT)).status).toBe(400);
    });

    it("syncClient が戻り先を足す。client の ID と戻り先 (callback) は変わらない", async () => {
      const synced = await syncClient(pool, await describeClient(made.ClientId), WORKBENCH_CLIENT);
      expect(synced.ClientId).toBe(made.ClientId);
      const now = await describeClient(made.ClientId);
      expect(now.LogoutURLs).toEqual([WORKBENCH_SIGNED_OUT]);
      expect(now.CallbackURLs).toEqual(WORKBENCH_CLIENT.CallbackURLs);
    });

    it("設定が合っていれば、何も呼ばない (dev:up のたびに書き直さない)", async () => {
      const now = await describeClient(made.ClientId);
      expect(await managementCalls(() => syncClient(pool, now, WORKBENCH_CLIENT))).toBe(0);
    });

    it("作った時から設定が合っている client にも、何も呼ばない", async () => {
      const fresh = (
        await cognito<{ UserPoolClient: WorkbenchClient }>("CreateUserPoolClient", {
          UserPoolId: pool,
          ClientName: "workbench-fresh",
          ...WORKBENCH_CLIENT,
        })
      ).UserPoolClient;
      const now = await describeClient(fresh.ClientId);
      expect(await managementCalls(() => syncClient(pool, now, WORKBENCH_CLIENT))).toBe(0);
    });

    it("logout の口は、登録した戻り先へ回し、IdP のサインインの cookie を消す", async () => {
      const res = await logout(made.ClientId, WORKBENCH_SIGNED_OUT);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(WORKBENCH_SIGNED_OUT);
      expect(res.headers.getSetCookie().some((line) => /^cognito=;.*Max-Age=0/i.test(line))).toBe(
        true,
      );
    });

    it("logout の口は、登録した物と 1 字でも違う戻り先を断る (query も足せない)", async () => {
      for (const uri of [
        "http://127.0.0.1:7080/",
        `${WORKBENCH_SIGNED_OUT}?back=%2Fcrawls`,
        "http://127.0.0.1:7081/login",
      ]) {
        expect((await logout(made.ClientId, uri)).status, uri).toBe(400);
      }
    });

    it("secret つきの client: 設定が違えば直し、secret はそのまま。合えば呼ばない", async () => {
      const settings = {
        GenerateSecret: true,
        AllowedOAuthFlows: ["client_credentials"],
        AllowedOAuthScopes: [START_SCOPE],
        AllowedOAuthFlowsUserPoolClient: true,
        AccessTokenValidity: 10,
        TokenValidityUnits: { AccessToken: "minutes" },
      };
      await cognito("CreateResourceServer", {
        UserPoolId: pool,
        Identifier: RESOURCE_SERVER,
        Name: RESOURCE_SERVER,
        Scopes: [{ ScopeName: "crawl.start", ScopeDescription: "crawl.start" }],
      });
      // 期限を書かずに作った client (既定の 60 分) を、10 分に直す
      const old = (
        await cognito<{ UserPoolClient: WorkbenchClient }>("CreateUserPoolClient", {
          UserPoolId: pool,
          ClientName: "ai",
          ...without(settings, "AccessTokenValidity", "TokenValidityUnits"),
        })
      ).UserPoolClient;
      expect(old.ClientSecret).toBeTypeOf("string");
      const synced = await syncClient(pool, await describeClient(old.ClientId), settings);
      expect(synced.ClientId).toBe(old.ClientId);
      expect(synced.ClientSecret).toBe(old.ClientSecret);
      const now = (await describeClient(old.ClientId)) as WorkbenchClient & {
        AccessTokenValidity?: number;
      };
      expect(now.AccessTokenValidity).toBe(10);
      expect(now.ClientSecret).toBe(old.ClientSecret);
      expect(await managementCalls(() => syncClient(pool, now, settings))).toBe(0);
    });
  },
);
