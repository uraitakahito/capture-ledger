// CAPTURE-185 段 0: Floci の上で、人と機械のトークンを取り、台帳がこれから使う式で確かめる。
// 使い方: node spike.mjs <Floci の base URL（iss の頭と同じ）> [--write-m2m <file>]
// 通るはずの物と落ちるはずの物を並べて流し、期待と違えば終了コード 1。
import * as C from "@aws-sdk/client-cognito-identity-provider";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const BASE = process.argv[2] ?? "http://127.0.0.1:14566";
const writeM2m = process.argv.indexOf("--write-m2m") > 0 ? process.argv[process.argv.indexOf("--write-m2m") + 1] : undefined;
const TOKEN_URL = `${BASE}/cognito-idp/oauth2/token`;
const CALLBACK = "http://127.0.0.1:7080/callback";
const c = new C.CognitoIdentityProviderClient({
  endpoint: BASE,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const rows = [];
const expect = (name, want, got, note = "") => {
  rows.push({ name, want, got, ok: want === got, note });
};

/** プールを 1 つ用意する: resource server・2 つの client・群・利用者。 */
const setup = async (label) => {
  const pool = (await c.send(new C.CreateUserPoolCommand({ PoolName: `spike-${label}` }))).UserPool.Id;
  await c.send(new C.CreateResourceServerCommand({ UserPoolId: pool, Identifier: "capture-ledger", Name: "ledger", Scopes: [{ ScopeName: "crawl", ScopeDescription: "crawl" }] }));
  const web = (await c.send(new C.CreateUserPoolClientCommand({
    UserPoolId: pool, ClientName: "workbench",
    ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    AllowedOAuthFlows: ["code"], AllowedOAuthScopes: ["openid"], AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: [CALLBACK],
  }))).UserPoolClient;
  const m2m = (await c.send(new C.CreateUserPoolClientCommand({
    UserPoolId: pool, ClientName: "windmill", GenerateSecret: true,
    AllowedOAuthFlows: ["client_credentials"], AllowedOAuthScopes: ["capture-ledger/crawl"], AllowedOAuthFlowsUserPoolClient: true,
  }))).UserPoolClient;
  const other = (await c.send(new C.CreateUserPoolClientCommand({
    UserPoolId: pool, ClientName: "not-allowed", ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"],
  }))).UserPoolClient;
  await c.send(new C.CreateGroupCommand({ UserPoolId: pool, GroupName: "acme" }));
  await c.send(new C.AdminCreateUserCommand({ UserPoolId: pool, Username: "alice", MessageAction: "SUPPRESS" }));
  await c.send(new C.AdminSetUserPasswordCommand({ UserPoolId: pool, Username: "alice", Password: "Passw0rd!spike", Permanent: true }));
  await c.send(new C.AdminAddUserToGroupCommand({ UserPoolId: pool, Username: "alice", GroupName: "acme" }));
  return { pool, iss: `${BASE}/${pool}`, web, m2m, other };
};

const passwordTokens = async (clientId) =>
  (await c.send(new C.InitiateAuthCommand({ ClientId: clientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: "alice", PASSWORD: "Passw0rd!spike" } }))).AuthenticationResult;

const pkceToken = async (clientId) => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, scope: "openid", code_challenge: challenge, code_challenge_method: "S256", state: "s1" });
  const a = await fetch(`${BASE}/cognito-idp/oauth2/authorize?${q}`, { redirect: "manual" });
  const loginUrl = new URL(a.headers.get("location"), BASE);
  const g = await fetch(loginUrl);
  const cookie = (g.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
  const page = await g.text();
  const hidden = Object.fromEntries([...page.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const r = await fetch(`${BASE}/cognito-idp/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ ...hidden, username: "alice", password: "Passw0rd!spike" }) });
  const loc = r.headers.get("location");
  const code = loc ? new URL(loc).searchParams.get("code") : null;
  const state = loc ? new URL(loc).searchParams.get("state") : null;
  const t = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: verifier }) });
  return { status: t.status, body: await t.json(), state, loginStatus: r.status };
};

const m2mToken = async (client, scope = "capture-ledger/crawl", secret = client.ClientSecret) => {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`${client.ClientId}:${secret}`).toString("base64") }, body: `grant_type=client_credentials&scope=${encodeURIComponent(scope)}` });
  return { status: r.status, body: await r.json() };
};

/** 台帳がこれから使う式: 署名・iss・exp の後で、client_id が許した一覧に在り、token_use が access。 */
const verifyLike = (iss, allowed) => {
  const keys = createRemoteJWKSet(new URL(`${iss}/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: iss });
      if (payload.token_use !== "access") return "reject:token_use";
      if (!allowed.includes(payload.client_id)) return "reject:client_id";
      return "accept";
    } catch (e) {
      return `reject:${e.code ?? "error"}`;
    }
  };
};

const t0 = Date.now();
const A = await setup("a");
const B = await setup("b");
const verify = verifyLike(A.iss, [A.web.ClientId, A.m2m.ClientId]);

const disc = await (await fetch(`${A.iss}/.well-known/openid-configuration`)).json();
expect("discovery の issuer が iss と同じ", true, disc.issuer === A.iss, disc.issuer);
expect("discovery に token endpoint", true, typeof disc.token_endpoint === "string", disc.token_endpoint);

const pw = await passwordTokens(A.web.ClientId);
const pwAccess = decodeJwt(pw.AccessToken);
expect("人（パスワード）の access token を受ける", "accept", await verify(pw.AccessToken));
expect("人の access token に aud が無い", true, pwAccess.aud === undefined);
expect("人の access token の cognito:groups", "acme", (pwAccess["cognito:groups"] ?? []).join(","));
expect("人の ID token は断る", "reject:token_use", await verify(pw.IdToken));

const pk = await pkceToken(A.web.ClientId);
expect("PKCE の code を token に替える", 200, pk.status, `login=${pk.loginStatus} state=${pk.state}`);
expect("PKCE の access token を受ける", "accept", pk.body.access_token ? await verify(pk.body.access_token) : "no-token");
expect("PKCE の state が戻る", "s1", pk.state);

const mm = await m2mToken(A.m2m);
const mmPayload = mm.body.access_token ? decodeJwt(mm.body.access_token) : {};
expect("機械（client credentials）の access token を受ける", "accept", mm.body.access_token ? await verify(mm.body.access_token) : "no-token");
expect("M2M の sub = client_id", true, mmPayload.sub === A.m2m.ClientId);
expect("M2M に群が無い", true, mmPayload["cognito:groups"] === undefined);

// 反証
expect("違う secret は invalid_client", "invalid_client", (await m2mToken(A.m2m, "capture-ledger/crawl", "wrong")).body.error);
expect("許していない scope は invalid_scope", "invalid_scope", (await m2mToken(A.m2m, "other/scope")).body.error);
const otherTok = (await passwordTokens(A.other.ClientId)).AccessToken;
expect("許していない client の access token は断る", "reject:client_id", await verify(otherTok));
const bTok = (await passwordTokens(B.web.ClientId)).AccessToken;
const bVerdict = await verify(bTok);
expect("別のプールのトークンは断る", true, bVerdict.startsWith("reject:"), bVerdict);
const parts = pw.AccessToken.split(".");
const sig = parts[2];
const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, -2)}${sig.at(-2) === "A" ? "B" : "A"}${sig.at(-1)}`;
const tVerdict = await verify(tampered);
expect("署名を 1 字変えたトークンは断る", true, tVerdict.startsWith("reject:"), tVerdict);

if (writeM2m) writeFileSync(writeM2m, JSON.stringify({ pool: A.pool, iss: A.iss, clientId: A.m2m.ClientId, secret: A.m2m.ClientSecret }));

let bad = 0;
for (const r of rows) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? "✓" : "✗"} ${r.name} — 期待 ${JSON.stringify(r.want)} / 結果 ${JSON.stringify(r.got)}${r.note ? ` (${r.note})` : ""}`);
}
console.log(`pool=${A.pool} iss=${A.iss} 秒=${((Date.now() - t0) / 1000).toFixed(1)} 失敗=${bad}`);
process.exit(bad === 0 ? 0 : 1);
