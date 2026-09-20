#!/usr/bin/env node
/**
 * ページの中で走らせる JavaScript の目録 (`scripts`) を足す・見る・切り替える・消す、
 * 開発用の CLI。
 *
 *   pnpm run scripts add autoscroll --file ./autoscroll.js
 *   pnpm run scripts add autoscroll --file - < ./autoscroll.js      # 標準入力から
 *   pnpm run scripts add hide-webdriver --file ./x.js --phase preload
 *   pnpm run scripts add autoscroll --file ./x.js --options '{"maxSteps":60}'
 *   pnpm run scripts list                                           # 各 id の最新版
 *   pnpm run scripts list --all --json                              # 版を全部、機械向け
 *   pnpm run scripts show autoscroll                                # source をそのまま出す
 *   pnpm run scripts disable autofetch                              # 既定の顔ぶれから外す
 *   pnpm run scripts enable autofetch
 *   pnpm run scripts rm autofetch --version 2
 *
 * **DB に直接書く開発用の道具で、認可は通らない** (`targets` と同じ)。中身は `store.ts`。
 *
 * ## なぜ台帳が目録を持つのか
 *
 * BrowserHive v11.0.0 で、サーバは走らせるものの顔ぶれを持たなくなった。送らなければ
 * ページでは何も走らない —— そして **それは成功した取り込みと見分けが付かない**。
 * 既定を持てるのは頼む側だけなので、ここに置く (`017` を見ること)。
 *
 * ## 出力
 *
 * 結果は標準出力、誤りは標準エラー。誤りのときは終了コード 1 で、DB は何も変えていない。
 */
import { readFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import type { Kysely } from "kysely";
import { databaseUrlOption } from "../cli/database-url-option.js";
import type { Database, ScriptPhase } from "../db/database.js";
import { createKyselyClient } from "../db/kysely.js";
import { fatal } from "../logger.js";
import { readAll } from "../targets/input.js";
import {
  addScript,
  listScripts,
  removeScripts,
  resolveScripts,
  setScriptEnabled,
  type ScriptRow,
} from "./store.js";

const nonEmpty = (raw: string): string => {
  const value = raw.trim();
  if (value === "") throw new InvalidArgumentError("空にはできない");
  return value;
};

/** `--options` は JSON のオブジェクトだけ。配列や数値は `__bh.opts[<id>]` の形に合わない。 */
const parseOptions = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidArgumentError("JSON として読めない");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidArgumentError("JSON のオブジェクトで渡す (例: '{\"maxSteps\":60}')");
  }
  return parsed as Record<string, unknown>;
};

const parseVersion = (raw: string): number => {
  if (!/^[1-9][0-9]*$/.test(raw)) throw new InvalidArgumentError("版は 1 以上の整数");
  return Number(raw);
};

const fail = (message: string): void => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const withDb = async (
  databaseUrl: string,
  run: (db: Kysely<Database>) => Promise<void>,
): Promise<void> => {
  const db = createKyselyClient(databaseUrl);
  try {
    await run(db);
  } finally {
    await db.destroy();
  }
};

const program = new Command()
  .name("scripts")
  .description(
    "ページで走らせる JavaScript の目録 (scripts) を足す・見る・切り替える・消す。DB に直接書く開発用の道具で、認可は通らない",
  )
  .showHelpAfterError(true);

program
  .command("add")
  .description("スクリプトを 1 本足す。版は自動で採番する (中身が同じなら足さない)")
  .argument("<id>", "報告と archive に出る名前 (例: autoscroll)")
  .requiredOption("--file <path>", "読む JS ファイル。`-` なら標準入力から")
  .addOption(
    new Option("--phase <phase>", "どちらの口から入れるか")
      .choices(["behavior", "preload"])
      .default("behavior"),
  )
  .addOption(new Option("--options <json>", "そのスクリプトに渡す値").argParser(parseOptions))
  .addOption(databaseUrlOption)
  .action(
    async (
      rawId: string,
      opts: {
        file: string;
        phase: ScriptPhase;
        options?: Record<string, unknown>;
        databaseUrl: string;
      },
    ) => {
      const id = nonEmpty(rawId);
      const source =
        opts.file === "-"
          ? await readAll(process.stdin)
          : await readFile(opts.file, "utf-8").catch(() => undefined);
      if (source === undefined) return fail(`読めない: ${opts.file}`);
      if (source.trim() === "") return fail("中身が空。何も足していない");

      await withDb(opts.databaseUrl, async (db) => {
        const result = await addScript(db, {
          id,
          phase: opts.phase,
          source,
          ...(opts.options === undefined ? {} : { options: opts.options }),
        });
        process.stdout.write(
          `${result.reused ? "=" : "✓"} ${id} v${String(result.version)}  ${opts.phase}  ` +
            `sha256:${result.sha256.slice(0, 12)}…  ` +
            `${result.reused ? "中身が同じなので、版は増やしていない" : "足した"}\n`,
        );
      });
    },
  );

const describeRow = (row: ScriptRow): string =>
  `${row.id} v${String(row.version)}  ${row.phase.padEnd(8)}  ${row.enabled ? "有効" : "無効"}  ` +
  `${String(row.bytes)} B  sha256:${row.sha256.slice(0, 12)}…`;

program
  .command("list")
  .description("目録を並べる。既定は各 id の最新版だけ")
  .option("--all", "版を全部")
  .option("--json", "JSON で出す")
  .addOption(databaseUrlOption)
  .action(async (opts: { all?: boolean; json?: boolean; databaseUrl: string }) => {
    await withDb(opts.databaseUrl, async (db) => {
      const rows = await listScripts(db, { allVersions: opts.all === true });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      for (const row of rows) process.stdout.write(`${describeRow(row)}\n`);
      const enabled = rows.filter((row) => row.enabled).length;
      process.stdout.write(
        `${String(rows.length)} 行 (有効 ${String(enabled)}・無効 ${String(rows.length - enabled)})。` +
          "何も指定しないクロールは、有効な各 id の最新版を走らせる\n",
      );
    });
  });

program
  .command("show")
  .description("source をそのまま出す。版を省くと最新版")
  .argument("<id>", "スクリプトの id")
  .addOption(new Option("--version <n>", "この版").argParser(parseVersion))
  .addOption(databaseUrlOption)
  .action(async (rawId: string, opts: { version?: number; databaseUrl: string }) => {
    await withDb(opts.databaseUrl, async (db) => {
      const id = nonEmpty(rawId);
      // 名指しの解決と同じ道を通す —— 「クロールが送るのはこれ」と同じものを見せるため。
      const resolved = await resolveScripts(db, [id]);
      if (resolved.kind === "missing") return fail(`目録に無い: ${resolved.ids.join(", ")}`);
      const script = resolved.scripts[0];
      if (script === undefined) return fail(`目録に無い: ${id}`);
      if (opts.version !== undefined && opts.version !== script.version) {
        return fail(
          `最新版は v${String(script.version)}。古い版は \`list --all --json\` で見る ` +
            "(この口は「いま送られるもの」だけを出す)",
        );
      }
      process.stdout.write(script.source.endsWith("\n") ? script.source : `${script.source}\n`);
    });
  });

const toggle = (name: "enable" | "disable", enabled: boolean): void => {
  program
    .command(name)
    .description(
      enabled
        ? "既定の顔ぶれに戻す"
        : "既定の顔ぶれから外す (消さない。scriptIds で名指しすれば走る)",
    )
    .argument("<id...>", "スクリプトの id")
    .addOption(new Option("--version <n>", "この版だけ (省くと最新版)").argParser(parseVersion))
    .addOption(databaseUrlOption)
    .action(async (ids: string[], opts: { version?: number; databaseUrl: string }) => {
      await withDb(opts.databaseUrl, async (db) => {
        const result = await setScriptEnabled(db, {
          ids: ids.map(nonEmpty),
          enabled,
          ...(opts.version === undefined ? {} : { version: opts.version }),
        });
        if (result.kind === "missing") {
          return fail(`目録に無い: ${result.ids.join(", ")}。何も変えていない`);
        }
        for (const row of result.changed) {
          process.stdout.write(
            `✓ ${row.id} v${String(row.version)}  ${enabled ? "有効にした" : "無効にした"}\n`,
          );
        }
      });
    });
};
toggle("enable", true);
toggle("disable", false);

program
  .command("rm")
  .description("行を消す。版を省くと、その id の全版。履歴を残したいなら disable する")
  .argument("<id...>", "スクリプトの id")
  .addOption(new Option("--version <n>", "この版だけ").argParser(parseVersion))
  .addOption(databaseUrlOption)
  .action(async (ids: string[], opts: { version?: number; databaseUrl: string }) => {
    await withDb(opts.databaseUrl, async (db) => {
      const result = await removeScripts(db, {
        ids: ids.map(nonEmpty),
        ...(opts.version === undefined ? {} : { version: opts.version }),
      });
      if (result.kind === "missing") {
        return fail(`目録に無い: ${result.ids.join(", ")}。何も消していない`);
      }
      for (const row of result.changed) {
        process.stdout.write(
          `✓ ${row.id}  ${opts.version === undefined ? "全版を" : `v${String(opts.version)} を`}消した\n`,
        );
      }
    });
  });

program.parseAsync(process.argv).catch(fatal);
