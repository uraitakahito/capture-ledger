#!/usr/bin/env node
/**
 * `idp:bootstrap` が作った利用者と Windmill の client に、組織のクロールの許可を与える。
 *
 *   pnpm run idp:grant
 *
 * 許可（OpenFGA の `submitter`）は **名前ではなく `sub`** に付く。Cognito（と代役の Floci）の
 * `sub` は、人なら Floci が付けた ID、機械（client credentials）なら app client の ID。
 * だから値を知っている引き渡しファイルから読んで、`fga:grant` を 2 回打つ。
 */
import { spawnSync } from "node:child_process";

import { readHandoff } from "./idp.js";
import { ROOT } from "./root.js";

const handoff = readHandoff();
const org = handoff["IDP_ORGANIZATION"];
const subjects = [handoff["IDP_WINDMILL_CLIENT_ID"], handoff["IDP_USER_SUB"]];
if (org === undefined || subjects.some((subject) => subject === undefined || subject === "")) {
  process.stderr.write("引き渡しファイルが無い。先に pnpm run idp:bootstrap (dev:up が打つ)\n");
  process.exit(1);
}
for (const subject of subjects as string[]) {
  const result = spawnSync("pnpm", ["run", "--silent", "fga:grant", "submitter", subject, org], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
