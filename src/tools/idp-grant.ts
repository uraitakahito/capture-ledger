#!/usr/bin/env node
/**
 * 手元の Floci の主体に、組織のクロールの許可を与える。
 *
 *   pnpm run idp:grant                  # idp:bootstrap が作った利用者と Windmill の client
 *   pnpm run idp:grant --user e2e       # Floci の利用者 e2e も (無ければ作り、群 acme に入れる)
 *
 * 許可（OpenFGA の `submitter`）は **名前ではなく `sub`** に付く。Cognito（と代役の Floci）の
 * `sub` は、人なら Floci が付けた ID、機械（client credentials）なら app client の ID。
 * だから値を知っている引き渡しファイルと Floci に訊いて、`fga:grant` を打つ。
 */
import { spawnSync } from "node:child_process";

import { CognitoError, DEV_ORGANIZATION, cognito, readHandoff } from "./idp.js";
import { ROOT } from "./root.js";

const handoff = readHandoff();
const org = handoff["IDP_ORGANIZATION"] ?? DEV_ORGANIZATION;
const issuer = handoff["IDP_ISSUER"];
const defaults = [handoff["IDP_WINDMILL_CLIENT_ID"], handoff["IDP_USER_SUB"]];
if (issuer === undefined || defaults.some((subject) => subject === undefined || subject === "")) {
  process.stderr.write("引き渡しファイルが無い。先に pnpm run idp:bootstrap (dev:up が打つ)\n");
  process.exit(1);
}
const pool = issuer.slice(issuer.lastIndexOf("/") + 1);

/** `--user <名前>` (繰り返せる)。commander を使わないのは、ほかに旗が無いから。 */
const users: string[] = [];
const argv = process.argv.slice(2);
for (let at = 0; at < argv.length; at++) {
  if (argv[at] === "--user" && argv[at + 1] !== undefined) users.push(String(argv[++at]));
  else {
    process.stderr.write(`知らない引数: ${String(argv[at])}（使えるのは --user <名前>）\n`);
    process.exit(1);
  }
}

/** 利用者を用意し (無ければ作り、群に入れる)、sub を返す。パスワードは決めない —— 取るのは idp:token。 */
const subOf = async (name: string): Promise<string> => {
  try {
    await cognito("AdminCreateUser", {
      UserPoolId: pool,
      Username: name,
      MessageAction: "SUPPRESS",
    });
  } catch (err) {
    if (!(err instanceof CognitoError) || err.type !== "UsernameExistsException") throw err;
  }
  await cognito("AdminAddUserToGroup", { UserPoolId: pool, Username: name, GroupName: org });
  const { UserAttributes } = await cognito<{ UserAttributes: { Name: string; Value: string }[] }>(
    "AdminGetUser",
    { UserPoolId: pool, Username: name },
  );
  const sub = UserAttributes.find((attr) => attr.Name === "sub")?.Value;
  if (sub === undefined) throw new Error(`利用者 ${name} の sub が読めない`);
  return sub;
};

const main = async () => {
  const subjects = [...(defaults as string[]), ...(await Promise.all(users.map(subOf)))];
  for (const subject of subjects) {
    const result = spawnSync("pnpm", ["run", "--silent", "fga:grant", "submitter", subject, org], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
