/**
 * `--database-url` の旗。既定は環境変数 `DATABASE_URL` (`pnpm run …` なら `.env` から入る)。
 *
 * DB に直接つなぐ CLI が共有する: capture-ledger の保守コマンド (`fga/ledger-commands.ts`) と、
 * スクリプトの CLI (`scripts/cli.ts`)。
 */
import { Option } from "commander";

export const databaseUrlOption = new Option("--database-url <url>", "Postgres connection string")
  .env("DATABASE_URL")
  .makeOptionMandatory(true);
