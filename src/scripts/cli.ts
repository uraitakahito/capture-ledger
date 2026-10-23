#!/usr/bin/env node
/**
 * ページの中で走らせる JavaScript の目録 (`scripts`) を足す・見る・切り替える・消す、
 * 開発用の CLI。
 *
 *   pnpm run scripts import .upstream/capture-scripts               # catalog.json と受け皿の型
 *   pnpm run scripts add autoscroll --file ./autoscroll.js
 *   pnpm run scripts add autoscroll --file - < ./autoscroll.js      # 標準入力から
 *   pnpm run scripts add hide-webdriver --file ./x.js --phase preload
 *   pnpm run scripts add autoscroll --file ./x.js --options '{"maxSteps":60}'
 *   pnpm run scripts add example-title --file ./x.ts --site example.com   # サイト用 (札)。--site は何度でも
 *   pnpm run scripts list                                           # 各 id の最新版
 *   pnpm run scripts list --all --json                              # 版を全部、機械向け
 *   pnpm run scripts list autoscroll --all                          # 1 つの id の版の並び
 *   pnpm run scripts list --seed https://example.com/               # その起点で既定が走らせる物
 *   pnpm run scripts show autoscroll                                # source をそのまま出す
 *   pnpm run scripts show autoscroll --version 1                    # 古い版 (無効な版も)
 *   pnpm run scripts types                                          # 受け皿 __bh の型
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
import { parseHttpUrl } from "../crawl/scope.js";
import type { Database, ScriptPhase } from "../db/database.js";
import { createKyselyClient } from "../db/kysely.js";
import { fatal } from "../logger.js";
import { readAll } from "../targets/input.js";
import {
  addHostTypes,
  addScript,
  catalogIdRefusal,
  listScripts,
  readHostTypes,
  readScript,
  removeScripts,
  resolveScripts,
  setScriptEnabled,
  sitesRefusal,
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

/** 何度でも書ける旗 (`--site`・`--seed`) を、書いた順の列に集める */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** 札を 1 行の終わりに添える。札の無い台本 (どこでも走る) には何も添えない */
const sitesNote = (sites: readonly string[]): string =>
  sites.length === 0 ? "" : `  札:${sites.join(",")}`;

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
  .option(
    "--site <host>",
    "札: 起点のどれかがこのホスト名のクロールでだけ走る (何度でも。小文字のホスト名)",
    collect,
  )
  .addOption(databaseUrlOption)
  .action(
    async (
      rawId: string,
      opts: {
        file: string;
        phase: ScriptPhase;
        options?: Record<string, unknown>;
        site?: string[];
        databaseUrl: string;
      },
    ) => {
      const id = nonEmpty(rawId);
      // 札は DB の CHECK (`021`) より先に、読める文で断る
      const sitesRefused = opts.site === undefined ? undefined : sitesRefusal(opts.site);
      if (sitesRefused !== undefined) return fail(sitesRefused);
      // `inline-` はその場の JS に取ってある。DB の CHECK (`019`) より先に、ファイルを読む前に断る
      const refused = catalogIdRefusal(id);
      if (refused !== undefined) return fail(refused);
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
          ...(opts.site === undefined ? {} : { sites: opts.site }),
        });
        process.stdout.write(
          `${result.reused ? "=" : "✓"} ${id} v${String(result.version)}  ${opts.phase}  ` +
            `sha256:${result.sha256.slice(0, 12)}…  ` +
            `${result.reused ? "中身が同じなので、版は増やしていない" : "足した"}` +
            `${sitesNote(opts.site ?? [])}\n`,
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
 *
 * 同じ置き場所の types/host.d.ts (受け皿 `__bh` の型) も写す (`host_types`・`020`)。目録の source を
 * 読む人に見せる写しで、走るものではない —— 無ければ言って、目録だけを入れる。
 */
interface CatalogEntry {
  id: string;
  phase: ScriptPhase;
  file: string;
  summary: string;
  /** 札 (`021`)。書いていなければ空 (どこでも走る) */
  sites: string[];
}

/** 札 (`sites`) を書ける形。`/1` は断る —— 札を知らない catalog と区別するため */
const CATALOG_PROFILE = "capture-scripts/2";

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
    // 1 つでも悪ければ何も足さない（下の action）。`inline-` もその 1 つ
    const refused = catalogIdRefusal(id);
    if (refused !== undefined) return `${path}: ${refused}`;
    if (phase !== "behavior" && phase !== "preload") {
      return `${path}: ${id} の phase が behavior でも preload でもない (${String(phase)})`;
    }
    if (typeof file !== "string" || file === "") return `${path}: ${id} に file が無い`;
    const summary = entry["summary"];
    const sites = entry["sites"] ?? [];
    if (!Array.isArray(sites) || !sites.every((site) => typeof site === "string")) {
      return `${path}: ${id} の sites がホスト名の列ではない`;
    }
    const sitesRefused = sitesRefusal(sites);
    if (sitesRefused !== undefined) return `${path}: ${id} の${sitesRefused}`;
    out.push({
      id,
      phase,
      file,
      summary: typeof summary === "string" ? summary : "",
      sites,
    });
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
    // 受け皿の型も先に読む。無いのは許す (目録だけの置き場所もある) が、空なら何も足さない
    const typesPath = join(dir, "types", "host.d.ts");
    const hostTypes = await readFile(typesPath, "utf-8").catch(() => undefined);
    if (hostTypes?.trim() === "") return fail(`中身が空: ${typesPath}`);

    await withDb(opts.databaseUrl, async (db) => {
      let added = 0;
      for (const { entry, source } of sources) {
        // 札は catalog が正なので、必ず意見として渡す (書いていなければ空 = どこでも走る)
        const result = await addScript(db, {
          id: entry.id,
          phase: entry.phase,
          source,
          sites: entry.sites,
        });
        if (!result.reused) added += 1;
        process.stdout.write(
          `${result.reused ? "=" : "✓"} ${entry.id} v${String(result.version)}  ` +
            `${entry.phase.padEnd(8)}  sha256:${result.sha256.slice(0, 12)}…  ` +
            `${result.reused ? "中身が同じなので、版は増やしていない" : "足した"}` +
            `${sitesNote(entry.sites)}\n`,
        );
      }
      process.stdout.write(
        `${dir}: ${String(catalog.length)} 本を読み、${String(added)} 本が新しい版になった\n`,
      );
      if (hostTypes === undefined) {
        process.stdout.write(`${typesPath} が無い。受け皿の型は取り込んでいない\n`);
        return;
      }
      const types = await addHostTypes(db, hostTypes);
      process.stdout.write(
        `${types.reused ? "=" : "✓"} host.d.ts v${String(types.version)}  ` +
          `sha256:${types.sha256.slice(0, 12)}…  ` +
          `${types.reused ? "中身が同じなので、版は増やしていない" : "足した"}\n`,
      );
    });
  });

const describeRow = (row: ScriptRow): string =>
  `${row.id} v${String(row.version)}  ${row.phase.padEnd(8)}  ${row.enabled ? "有効" : "無効"}  ` +
  `${String(row.bytes)} B  sha256:${row.sha256.slice(0, 12)}…  ${row.createdAt.toISOString()}` +
  sitesNote(row.sites);

program
  .command("list")
  .description("目録を並べる。既定は各 id の最新版だけ")
  .argument("[id]", "この id だけ (--all と合わせると、その id の版の並び)")
  .option("--all", "版を全部")
  .option("--json", "JSON で出す")
  .option(
    "--seed <url>",
    "この起点で始めるクロールが、scripts を省いたときに走らせる物を並べる (何度でも)",
    collect,
  )
  .addOption(databaseUrlOption)
  .action(
    async (
      rawId: string | undefined,
      opts: { all?: boolean; json?: boolean; seed?: string[]; databaseUrl: string },
    ) => {
      await withDb(opts.databaseUrl, async (db) => {
        if (opts.seed !== undefined) {
          // 起点で選ぶのは各 id の最新版だけなので、id や --all とは一緒に使えない
          if (rawId !== undefined || opts.all === true)
            return fail("--seed は id・--all と一緒に使えない");
          const parsed = opts.seed.map((raw) => parseHttpUrl(raw));
          if (parsed.some((seed) => seed === undefined))
            return fail("--seed は http(s) の URL だけ");
          const hosts = [...new Set(parsed.map((seed) => seed!.hostname))];
          // POST /api/crawls と同じ関数で選ぶ (札の無い物と、起点に合うサイト用の物)
          const resolved = await resolveScripts(db, undefined, hosts);
          const scripts = resolved.kind === "ok" ? resolved.scripts : [];
          if (opts.json) {
            const shown = scripts.map(({ id, version, phase, sha256, sites }) => ({
              id,
              version,
              phase,
              sha256,
              sites,
            }));
            process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
            return;
          }
          for (const script of scripts) {
            process.stdout.write(
              `${script.id} v${String(script.version)}  ${script.phase.padEnd(8)}${sitesNote(script.sites ?? [])}\n`,
            );
          }
          process.stdout.write(
            `${String(scripts.length)} 本。起点 ${hosts.join("・")} のクロールが、scripts を省いたときに走らせる物\n`,
          );
          return;
        }
        const id = rawId === undefined ? undefined : nonEmpty(rawId);
        const rows = await listScripts(db, {
          allVersions: opts.all === true,
          ...(id === undefined ? {} : { id }),
        });
        // 名指しした id が無いのは誤り (show と同じ)。名指ししない空の目録は、0 行と言う
        if (id !== undefined && rows.length === 0) return fail(`目録に無い: ${id}`);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
          return;
        }
        for (const row of rows) process.stdout.write(`${describeRow(row)}\n`);
        const enabled = rows.filter((row) => row.enabled).length;
        process.stdout.write(
          `${String(rows.length)} 行 (有効 ${String(enabled)}・無効 ${String(rows.length - enabled)})。` +
            "何も指定しないクロールは、有効な各 id の最新版のうち、札の無い物と、起点に合う物を走らせる " +
            "(--seed で見る)\n",
        );
      });
    },
  );

program
  .command("show")
  .description("source をそのまま出す。版を省くと最新版、書けばその版 (無効な版も)")
  .argument("<id>", "スクリプトの id")
  .addOption(new Option("--version <n>", "この版").argParser(parseVersion))
  .addOption(databaseUrlOption)
  .action(async (rawId: string, opts: { version?: number; databaseUrl: string }) => {
    await withDb(opts.databaseUrl, async (db) => {
      const id = nonEmpty(rawId);
      // 版を省いたときは、名指しの解決と同じ道で版を決める —— 「クロールが送るのはこれ」と
      // 同じものを見せるため。1 本だけ頼むので、重ね (`duplicate`) は起きない。
      const resolved = await resolveScripts(db, [{ catalog: id }]);
      if (resolved.kind !== "ok") return fail(`目録に無い: ${resolved.ids.join(", ")}`);
      const latest = resolved.scripts[0];
      if (latest === undefined) return fail(`目録に無い: ${id}`);
      // 読むのは台帳の口 (`GET /api/scripts/:id/versions/:version`) と同じ readScript
      const script = await readScript(db, id, opts.version ?? latest.version);
      if (script === undefined) return fail(`${id} に v${String(opts.version)} は無い`);
      process.stdout.write(script.source.endsWith("\n") ? script.source : `${script.source}\n`);
    });
  });

program
  .command("types")
  .description("受け皿 __bh の型 (import が写した、いちばん新しい版) をそのまま出す")
  .addOption(databaseUrlOption)
  .action(async (opts: { databaseUrl: string }) => {
    await withDb(opts.databaseUrl, async (db) => {
      const types = await readHostTypes(db);
      if (types === undefined) {
        return fail(
          "受け皿の型はまだ無い (pnpm run scripts import .upstream/capture-scripts で入る)",
        );
      }
      process.stdout.write(types.source.endsWith("\n") ? types.source : `${types.source}\n`);
    });
  });

const toggle = (name: "enable" | "disable", enabled: boolean): void => {
  program
    .command(name)
    .description(
      enabled
        ? "既定の顔ぶれに戻す (版を省くと、その id の全版)"
        : "既定の顔ぶれから外す (消さない。クロールの scripts で名指しすれば走る)",
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
