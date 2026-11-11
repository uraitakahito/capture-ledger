#!/usr/bin/env node
/**
 * 手元の Floci の利用者で、access token を 1 本取る。**本番には無い。**
 *
 *   pnpm run --silent idp:token                      # idp:bootstrap が作った $(whoami)
 *   pnpm run --silent idp:token --user bob --org acme --org contoso
 *
 * picker（7070 の画面）に貼るトークンと、curl で台帳を叩くときに使う。利用者が無ければ作り、
 * `--org` の群に入れる（群の名前が組織の名前）。人の名乗りなので `sub` は Floci が付けた ID
 * になる —— クロールを始めるには `pnpm run idp:grant --user <名前>` が要る（その `sub` に許可を与える）。
 *
 * 機械（Windmill）のトークンは client credentials で取る物で、これとは別（capture-scheduler）。
 */
import { randomBytes } from "node:crypto";

import { Command, Option } from "commander";

import { CognitoError, cognito, readHandoff } from "./idp.js";

interface TokenOptions {
  user?: string;
  org: string[];
}

const program = new Command()
  .name("capture-ledger idp:token")
  .description("手元の Floci の利用者で access token を 1 本取る")
  .option("--user <name>", "利用者の名前 (既定は idp:bootstrap が作った利用者)")
  .addOption(
    new Option("--org <group...>", "入れる群 (= 組織)。繰り返せる").default([] as string[]),
  );

const main = async () => {
  const opts = program.parse(process.argv).opts<TokenOptions>();
  const handoff = readHandoff();
  const issuer = handoff["IDP_ISSUER"];
  const cli = handoff["IDP_CLI_CLIENT_ID"];
  if (issuer === undefined || cli === undefined) {
    throw new Error("引き渡しファイルが無い。先に pnpm run idp:bootstrap (dev:up が打つ)");
  }
  const pool = issuer.slice(issuer.lastIndexOf("/") + 1);
  const user = opts.user ?? handoff["IDP_USER"];
  if (user === undefined || user === "") throw new Error("--user を渡す");

  let password = user === handoff["IDP_USER"] ? handoff["IDP_USER_PASSWORD"] : undefined;
  if (password === undefined) {
    try {
      await cognito("AdminCreateUser", {
        UserPoolId: pool,
        Username: user,
        MessageAction: "SUPPRESS",
      });
    } catch (err) {
      if (!(err instanceof CognitoError) || err.type !== "UsernameExistsException") throw err;
    }
    // 決めたパスワードはどこにも残さない。次に取るときも決め直す。
    password = `Dev-${randomBytes(12).toString("base64url")}9a!`;
    await cognito("AdminSetUserPassword", {
      UserPoolId: pool,
      Username: user,
      Password: password,
      Permanent: true,
    });
  }
  for (const group of opts.org) {
    try {
      await cognito("CreateGroup", { UserPoolId: pool, GroupName: group });
    } catch (err) {
      if (!(err instanceof CognitoError) || err.type !== "GroupExistsException") throw err;
    }
    await cognito("AdminAddUserToGroup", { UserPoolId: pool, Username: user, GroupName: group });
  }
  const { AuthenticationResult } = await cognito<{
    AuthenticationResult: { AccessToken: string };
  }>("InitiateAuth", {
    ClientId: cli,
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: user, PASSWORD: password },
  });
  const token = AuthenticationResult.AccessToken;
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
    sub?: string;
    "cognito:groups"?: string[];
  };
  process.stdout.write(`${token}\n`);
  process.stderr.write(
    `利用者 ${user}・sub ${claims.sub ?? "?"}・群 ${(claims["cognito:groups"] ?? []).join(",") || "(なし)"}\n`,
  );
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
