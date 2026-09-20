#!/usr/bin/env node
/**
 * ページの中で走らせる JavaScript の目録 (`scripts`) を足す・見る・切り替える・消す、
 * 開発用の CLI。
 *
 *   pnpm run scripts import .upstream/capture-scripts               # catalog.json ごと
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
import { join } from "node:path";
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

/**
 * `catalog.json` を読んで、書かれているものを全部足す。
 *
 * **`phase` を手で打たないためのもの。** phase はそのスクリプトの性質 (遷移の前か、
 * 読み込みの後か) であって、打つ人の選択ではない。`--phase` を打ち間違えると、
 * 遷移の前に入れるはずのコードが読み込みの後に 1 回だけ走り、**しかも成功する**。
 *
 * 中身が同じものは版が増えない (`addScript`) ので、**何度流しても構わない**。
 * 置き場所を移したあとの流し直しも、目録から見れば何も起きない。
 */
interface CatalogEntry {
  id: string;
  phase: ScriptPhase;
  file: string;
  summary: string;
}

const CATALOG_PROFILE = "capture-scripts/1";

/** 読めた catalog か、読めなかった理由。**黙って一部だけ足さない。** */
const readCatalog = async (dir: string): Promise<CatalogEntry[] | string> => {
  const path = join(dir, "catalog.json");
  const raw = await readFile(path, "utf-8").catch(() => undefined);
  if (raw === undefined) return `読めない: ${path}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `JSON として読めない: ${path}`;
  }
  if (typeof parsed !== "object" || parsed === null) return `形が違う: ${path}`;

  const record = parsed as Record<string, unknown>;
  // profile を見るのは、別の形の catalog.json を黙って読まないため。
  if (record["profile"] !== CATALOG_PROFILE) {
    return `${path} の profile が ${CATALOG_PROFILE} ではない (${String(record["profile"])})`;
  }
  const entries = record["scripts"];
  if (!Array.isArray(entries)) return `${path} に scripts の配列が無い`;

  const out: CatalogEntry[] = [];
  for (const entry of entries as Record<string, unknown>[]) {
    const id = entry["id"];
    const phase = entry["phase"];
    const file = entry["file"];
    if (typeof id !== "string" || id === "") return `${path}: id が空の項目がある`;
    if (phase !== "behavior" && phase !== "preload") {
      return `${path}: ${id} の phase が behavior でも preload でもない (${String(phase)})`;
    }
    if (typeof file !== "string" || file === "") return `${path}: ${id} に file が無い`;
    const summary = entry["summary"];
    out.push({ id, phase, file, summary: typeof summary === "string" ? summary : "" });
  }
  return out;
};

program
  .command("import")
  .description("catalog.json を読んで、書かれているスクリプトを全部足す")
  .argument("<dir>", "capture-scripts の置き場所 (例: .upstream/capture-scripts)")
  .addOption(databaseUrlOption)
  .action(async (dir: string, opts: { databaseUrl: string }) => {
    const catalog = await readCatalog(dir);
    if (typeof catalog === "string") return fail(catalog);
    if (catalog.length === 0) return fail(`${dir}/catalog.json に 1 本も書かれていない`);

    // **先に全部読む。** 1 本でも読めなければ、1 本も足さない ——
    // 途中まで入った目録は、入れた人から見ると「入った」と区別が付かない。
    const sources: { entry: CatalogEntry; source: string }[] = [];
    for (const entry of catalog) {
      const source = await readFile(join(dir, entry.file), "utf-8").catch(() => undefined);
      if (source === undefined) return fail(`読めない: ${join(dir, entry.file)}`);
      if (source.trim() === "") return fail(`中身が空: ${join(dir, entry.file)}`);
      sources.push({ entry, source });
    }

    await withDb(opts.databaseUrl, async (db) => {
      let added = 0;
      for (const { entry, source } of sources) {
        const result = await addScript(db, { id: entry.id, phase: entry.phase, source });
        if (!result.reused) added += 1;
        process.stdout.write(
          `${result.reused ? "=" : "✓"} ${entry.id} v${String(result.version)}  ` +
            `${entry.phase.padEnd(8)}  sha256:${result.sha256.slice(0, 12)}…  ` +
            `${result.reused ? "中身が同じなので、版は増やしていない" : "足した"}\n`,
        );
      }
      process.stdout.write(
        `${dir}: ${String(catalog.length)} 本を読み、${String(added)} 本が新しい版になった\n`,
      );
    });
  });

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
        ? "既定の顔ぶれに戻す (版を省くと、その id の全版)"
        : "既定の顔ぶれから外す (消さない。scriptIds で名指しすれば走る)",
    )
    .argument("<id...>", "スクリプトの id")
    .addOption(
      new Option(
        "--version <n>",
        "この版だけ。**省くとその id の全版** —— 最新版だけ外すと古い版が既定に昇格する",
      ).argParser(parseVersion),
    )
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
