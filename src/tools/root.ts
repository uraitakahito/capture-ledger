/**
 * repo の根。src/tools/ から見ても dist/tools/ から見ても 2 段上 (`../..`)。
 *
 * 道具は dist/tools/ に書き出してから走らせる (package.json の build:tools)。道具ごとに
 * `new URL("..", import.meta.url)` と書くと、dist/ を根と取り違える —— capture-scheduler が
 * 道具を TypeScript にした日に、それで ENOENT を踏んだ。根はここ 1 か所で決める。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// この module を別の深さへ動かすと、根が黙ってずれる。ずれた根で走らないよう、ここで落とす。
if (!existsSync(join(ROOT, "package.json"))) {
  throw new Error(
    `repo の根を取り違えた: ${ROOT} に package.json が無い (src/tools/root.ts の段の数を見ること)`,
  );
}
