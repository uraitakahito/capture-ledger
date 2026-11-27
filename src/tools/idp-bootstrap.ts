#!/usr/bin/env node
/**
 * 手元の Floci（Cognito の代役）に、capture-ledger が受けるプール一式を用意する。**本番には無い**
 * （本番の Cognito のプールは AWS の側で作る）。
 *
 *   pnpm run idp:bootstrap
 *
 * 作る物（在れば使い回す。何度打っても同じ形になる）:
 *
 *   - プール `capture-ledger-dev`
 *   - resource server `capture-ledger` と scope `crawl`・`crawl.start`（在る resource server に足りなければ足す）
 *   - app client 4 つ
 *       workbench  public。authorization code と PKCE（戻り先は 7080 の /callback）
 *       cli        public。パスワードの流れ。`pnpm run idp:token` と picker に貼るトークン用
 *       windmill   secret つき。client credentials（M2M）。scope `crawl`（どの route も通る）
 *       ai         secret つき。client credentials。scope `crawl.start` だけ（始める・読む）・token の期限 10 分。
 *                  AI の担当がクロールを始める CLI 用（CAPTURE-450）
 *   - 群 `acme`（群の名前が組織の名前）と、利用者 `$(whoami)`（`acme` に入れる）
 *
 * 書く物:
 *
 *   - `.env.local` に `CAPTURE_LEDGER_OIDC_ISSUER` と `CAPTURE_LEDGER_OIDC_CLIENT_IDS`（API が読む）
 *   - `.dev/idp.env`（引き渡しファイル）に、client の ID・Windmill の secret・利用者のパスワード
 *   - `.dev/idp-ai.env`（AI の担当の引き渡しファイル）に、ai の client の ID と secret だけ
 *
 * ## プールは Floci が起き直すと消える
 *
 * Floci はメモリに持つ（compose の既定）。`stack:up` で作り直されるとプールが消え、`iss` が
 * 替わる。`dev:up` はこの段を毎回打つので揃う。`stack:up` だけを打ったら `dev:up --from idp`。
 */
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";

import { guardEnv, upsertEnvLocal } from "./env.js";
import {
  CRAWL_SCOPE,
  CognitoError,
  DEV_ORGANIZATION,
  IDP_CONTAINER_ENDPOINT,
  IDP_ENDPOINT,
  IDP_AI_HANDOFF,
  IDP_HANDOFF,
  RESOURCE_SERVER,
  START_SCOPE,
  TOKEN_PATH,
  cognito,
  readHandoff,
  writeHandoff,
} from "./idp.js";

guardEnv();

const POOL_NAME = "capture-ledger-dev";
/** workbench の戻り先。capture-workbench の既定の 7080 と `/callback`。 */
const WORKBENCH_CALLBACK = "http://127.0.0.1:7080/callback";

interface PoolSummary {
  Id: string;
  Name: string;
}
interface ClientSummary {
  ClientId: string;
  ClientName: string;
}
interface Client extends ClientSummary {
  ClientSecret?: string;
}

/** Cognito の既定のパスワードの決まり（大文字・小文字・数字・記号・8 字以上）を満たす。 */
const newPassword = () => `Dev-${randomBytes(12).toString("base64url")}9a!`;

const ensurePool = async (): Promise<string> => {
  const { UserPools } = await cognito<{ UserPools: PoolSummary[] }>("ListUserPools", {
    MaxResults: 60,
  });
  const found = UserPools.find((pool) => pool.Name === POOL_NAME);
  if (found !== undefined) return found.Id;
  const { UserPool } = await cognito<{ UserPool: { Id: string } }>("CreateUserPool", {
    PoolName: POOL_NAME,
  });
  return UserPool.Id;
};

/** resource server の scope。`CRAWL_SCOPE`・`START_SCOPE` の、頭の `capture-ledger/` を除いた所。 */
const SCOPES = [
  { ScopeName: "crawl", ScopeDescription: "クロールを始め、段を報告する（どの route も通る）" },
  { ScopeName: "crawl.start", ScopeDescription: "クロールを始め、読む（AI の担当）" },
];

/** resource server を用意する。在って scope が足りなければ足す（作り直さずに、前の bootstrap のプールを揃える）。 */
const ensureResourceServer = async (pool: string) => {
  let have: string[];
  try {
    const { ResourceServer } = await cognito<{
      ResourceServer: { Scopes?: { ScopeName: string }[] };
    }>("DescribeResourceServer", { UserPoolId: pool, Identifier: RESOURCE_SERVER });
    have = (ResourceServer.Scopes ?? []).map((scope) => scope.ScopeName);
  } catch (err) {
    if (!(err instanceof CognitoError) || err.type !== "ResourceNotFoundException") throw err;
    await cognito("CreateResourceServer", {
      UserPoolId: pool,
      Identifier: RESOURCE_SERVER,
      Name: RESOURCE_SERVER,
      Scopes: SCOPES,
    });
    return;
  }
  if (SCOPES.every((scope) => have.includes(scope.ScopeName))) return;
  await cognito("UpdateResourceServer", {
    UserPoolId: pool,
    Identifier: RESOURCE_SERVER,
    Name: RESOURCE_SERVER,
    Scopes: SCOPES,
  });
};

/**
 * AI の担当の app client の設定 (CAPTURE-450)。狭い scope だけを許し、token の期限を短くする —— 出た token は
 * 期限まで止められないので (Cognito の決まり)、漏れた時の害を期限で小さくする。
 */
const AI_CLIENT = {
  GenerateSecret: true,
  AllowedOAuthFlows: ["client_credentials"],
  AllowedOAuthScopes: [START_SCOPE],
  AllowedOAuthFlowsUserPoolClient: true,
  AccessTokenValidity: 10,
  TokenValidityUnits: { AccessToken: "minutes" },
};

/**
 * 在る client の設定が `settings` と違えば、直す。UpdateUserPoolClient は渡さない欄を既定に戻すので、
 * 全部の設定を渡す (secret はそのまま)。
 */
const syncClient = async (
  pool: string,
  client: Client & { AllowedOAuthScopes?: string[]; AccessTokenValidity?: number },
  settings: typeof AI_CLIENT,
): Promise<Client> => {
  const same =
    JSON.stringify(client.AllowedOAuthScopes ?? []) ===
      JSON.stringify(settings.AllowedOAuthScopes) &&
    client.AccessTokenValidity === settings.AccessTokenValidity;
  if (same) return client;
  // 在る client の secret は作り直さない (GenerateSecret は作る時だけの欄)
  const rest: Omit<typeof settings, "GenerateSecret"> = {
    AllowedOAuthFlows: settings.AllowedOAuthFlows,
    AllowedOAuthScopes: settings.AllowedOAuthScopes,
    AllowedOAuthFlowsUserPoolClient: settings.AllowedOAuthFlowsUserPoolClient,
    AccessTokenValidity: settings.AccessTokenValidity,
    TokenValidityUnits: settings.TokenValidityUnits,
  };
  const { UserPoolClient } = await cognito<{ UserPoolClient: Client }>("UpdateUserPoolClient", {
    UserPoolId: pool,
    ClientId: client.ClientId,
    ClientName: client.ClientName,
    ...rest,
  });
  return { ...UserPoolClient, ClientSecret: UserPoolClient.ClientSecret ?? client.ClientSecret };
};

const ensureClient = async (pool: string, name: string, settings: object): Promise<Client> => {
  const { UserPoolClients } = await cognito<{ UserPoolClients: ClientSummary[] }>(
    "ListUserPoolClients",
    { UserPoolId: pool, MaxResults: 60 },
  );
  const found = UserPoolClients.find((client) => client.ClientName === name);
  if (found !== undefined) {
    const { UserPoolClient } = await cognito<{ UserPoolClient: Client }>("DescribeUserPoolClient", {
      UserPoolId: pool,
      ClientId: found.ClientId,
    });
    return UserPoolClient;
  }
  const { UserPoolClient } = await cognito<{ UserPoolClient: Client }>("CreateUserPoolClient", {
    UserPoolId: pool,
    ClientName: name,
    ...settings,
  });
  return UserPoolClient;
};

const ensureGroup = async (pool: string, group: string) => {
  try {
    await cognito("CreateGroup", { UserPoolId: pool, GroupName: group });
  } catch (err) {
    if (!(err instanceof CognitoError) || err.type !== "GroupExistsException") throw err;
  }
};

/**
 * 利用者を用意し、`sub` を返す。パスワードは、利用者が既に居て引き渡しファイルに在ればそれを使い続け、
 * 利用者をいま作ったとき（`idp` を作り直した後など）とファイルに無いときは決め直す
 * （Floci には読み出す API が無いので、知らなければ決め直す）。
 */
const ensureUser = async (pool: string, name: string, known: string | undefined) => {
  let created = false;
  try {
    await cognito("AdminCreateUser", {
      UserPoolId: pool,
      Username: name,
      MessageAction: "SUPPRESS",
    });
    created = true;
  } catch (err) {
    if (!(err instanceof CognitoError) || err.type !== "UsernameExistsException") throw err;
  }
  const password = created || known === undefined ? newPassword() : known;
  await cognito("AdminSetUserPassword", {
    UserPoolId: pool,
    Username: name,
    Password: password,
    Permanent: true,
  });
  await cognito("AdminAddUserToGroup", {
    UserPoolId: pool,
    Username: name,
    GroupName: DEV_ORGANIZATION,
  });
  const { UserAttributes } = await cognito<{ UserAttributes: { Name: string; Value: string }[] }>(
    "AdminGetUser",
    { UserPoolId: pool, Username: name },
  );
  const sub = UserAttributes.find((attr) => attr.Name === "sub")?.Value;
  if (sub === undefined) throw new Error(`利用者 ${name} の sub が読めない`);
  return { password, sub };
};

const main = async () => {
  const before = readHandoff();
  const pool = await ensurePool();
  await ensureResourceServer(pool);
  const workbench = await ensureClient(pool, "workbench", {
    AllowedOAuthFlows: ["code"],
    AllowedOAuthScopes: ["openid"],
    AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: [WORKBENCH_CALLBACK],
    ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
  });
  const cli = await ensureClient(pool, "cli", {
    ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  });
  const windmill = await ensureClient(pool, "windmill", {
    GenerateSecret: true,
    AllowedOAuthFlows: ["client_credentials"],
    AllowedOAuthScopes: [CRAWL_SCOPE],
    AllowedOAuthFlowsUserPoolClient: true,
  });
  if (windmill.ClientSecret === undefined) throw new Error("windmill の client に secret が無い");
  const ai = await syncClient(pool, await ensureClient(pool, "ai", AI_CLIENT), AI_CLIENT);
  if (ai.ClientSecret === undefined) throw new Error("ai の client に secret が無い");
  await ensureGroup(pool, DEV_ORGANIZATION);
  const user = userInfo().username;
  const { password, sub } = await ensureUser(
    pool,
    user,
    before["IDP_USER"] === user ? before["IDP_USER_PASSWORD"] : undefined,
  );

  const issuer = `${IDP_ENDPOINT}/${pool}`;
  // `名前=ID`。API は名前を、その client から来たクロールの行に残す (src/config/identity.ts の clientsFromList)
  const clientIds = [
    `workbench=${workbench.ClientId}`,
    `cli=${cli.ClientId}`,
    `windmill=${windmill.ClientId}`,
    `ai=${ai.ClientId}`,
  ];
  const env = upsertEnvLocal({
    CAPTURE_LEDGER_OIDC_ISSUER: issuer,
    CAPTURE_LEDGER_OIDC_CLIENT_IDS: clientIds.join(","),
  });
  const handoff = writeHandoff({
    IDP_ISSUER: issuer,
    IDP_TOKEN_ENDPOINT: `${IDP_ENDPOINT}${TOKEN_PATH}`,
    IDP_CONTAINER_TOKEN_ENDPOINT: `${IDP_CONTAINER_ENDPOINT}${TOKEN_PATH}`,
    IDP_WORKBENCH_CLIENT_ID: workbench.ClientId,
    IDP_CLI_CLIENT_ID: cli.ClientId,
    IDP_WINDMILL_CLIENT_ID: windmill.ClientId,
    IDP_WINDMILL_CLIENT_SECRET: windmill.ClientSecret,
    IDP_WINDMILL_SCOPE: CRAWL_SCOPE,
    // AI の担当の client の ID (許可を付ける idp:grant が読む)。secret は別のファイルに置く
    IDP_AI_CLIENT_ID: ai.ClientId,
    IDP_ORGANIZATION: DEV_ORGANIZATION,
    IDP_USER: user,
    IDP_USER_PASSWORD: password,
    IDP_USER_SUB: sub,
  });
  // AI の担当の引き渡し。クロールを始める CLI が読む。人のパスワードと Windmill の secret は入れない
  const aiHandoff = writeHandoff(
    {
      IDP_TOKEN_ENDPOINT: `${IDP_ENDPOINT}${TOKEN_PATH}`,
      IDP_AI_CLIENT_ID: ai.ClientId,
      IDP_AI_CLIENT_SECRET: ai.ClientSecret,
      IDP_AI_SCOPE: START_SCOPE,
    },
    IDP_AI_HANDOFF,
  );

  process.stdout.write(
    `プール ${pool}（iss ${issuer}）\n` +
      `  client: workbench ${workbench.ClientId} / cli ${cli.ClientId} / windmill ${windmill.ClientId} / ai ${ai.ClientId}\n` +
      `  利用者 ${user}（群 ${DEV_ORGANIZATION}・sub ${sub}）\n` +
      `${env.path} に CAPTURE_LEDGER_OIDC_ISSUER・CAPTURE_LEDGER_OIDC_CLIENT_IDS を書いた\n` +
      `${handoff} に secret とパスワードを書いた（${IDP_HANDOFF}。値は印字しない）\n` +
      `${aiHandoff} に ai の client の secret を書いた（${IDP_AI_HANDOFF}。値は印字しない）\n`,
  );
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
