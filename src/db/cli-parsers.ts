/**
 * db の CLI (`migrate`) のための commander argParser の補助。
 *
 * contact-api の `cli-parsers.ts` と同じ形。`src/config/` ではなく、使う bin
 * スクリプトの隣に置いている —— あちらの cli-options はアプリケーションの CLI の
 * 表面に繋がっているが、この補助は migrate の内輪のものだから。
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { InvalidArgumentError } from "commander";

export const parsePath = (value: string): URL => {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Path must not be empty.");
  }
  return pathToFileURL(path.resolve(value));
};
