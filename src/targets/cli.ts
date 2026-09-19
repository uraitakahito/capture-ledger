#!/usr/bin/env node
/**
 * 撮る対象 (`capture_targets`) を足す・見る・外す・消す、開発用の CLI。
 *
 *   pnpm run targets add https://example.com/ --org acme
 *   pnpm run targets add - --org acme < my-urls.txt     # 1 行 1 URL。空行と # の行は読み飛ばす
 *   pnpm run targets list --org acme                    # --org を省くと全部。--json で機械向け
 *   pnpm run targets disable 6 7                        # 履歴を残したまま、対象から外す
 *   pnpm run targets enable 6
 *   pnpm run targets rm 6
 *
 * **DB に直接書く開発用の道具で、認可は通らない。** API の口ではなく、誰が足したかも
 * 記録しない。中身は `store.ts` (芯) と `input.ts` (URL の読み取り)。
 *
 * ## 組織は必須で、既定値は置かない
 *
 * 既定値は、書き忘れを「誰のクロールからも見えない行」に変える —— `015` で表から外したのと
 * 同じ罠。
 *
 * ## 出力
 *
 * 結果は標準出力、誤りは標準エラー。誤りのときは終了コード 1 で、DB は何も変えていない。
 */
import { Command, InvalidArgumentError, Option } from "commander";
import type { Kysely } from "kysely";
import { databaseUrlOption } from "../cli/database-url-option.js";
import type { Database } from "../db/database.js";
import { createKyselyClient } from "../db/kysely.js";
import { fatal } from "../logger.js";
import { collectUrls, readAll } from "./input.js";
import {
  addTargets,
  listTargets,
  removeTargets,
  setEnabled,
  type TargetRef,
  type TargetRow,
} from "./store.js";

const nonEmpty = (raw: string): string => {
  const value = raw.trim();
  if (value === "") throw new InvalidArgumentError("空にはできない");
  return value;
};

/** 札。`--label a --label b` のように何度でも渡せる (まとめ書きにすると、後ろの URL を札として飲み込むため)。 */
const collectLabel = (raw: string, previous: string[] | undefined): string[] => [
  ...(previous ?? []),
  nonEmpty(raw),
];

/** 行の id。BIGSERIAL なので、node-pg に合わせて文字列のまま扱う。 */
const parseIds = (raw: readonly string[]): string[] | undefined =>
  raw.every((id) => /^[1-9][0-9]*$/.test(id)) ? [...raw] : undefined;

const fail = (message: string): void => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const say = (mark: string, label: string, target: TargetRef): void => {
  process.stdout.write(`${mark} ${label.padEnd(6, "　")}  #${target.id}  ${target.url}\n`);
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
  .name("targets")
  .description(
    "撮る対象 (capture_targets) を足す・見る・外す・消す。DB に直接書く開発用の道具で、認可は通らない",
  )
  .showHelpAfterError(true);

program
  .command("add")
  .description("URL を撮る対象として足す。無効だった行は有効に戻す")
  .argument("<url...>", "足す URL。`-` なら標準入力から (1 行 1 URL。空行と # の行は読み飛ばす)")
  .addOption(
    new Option("--org <id>", "どの組織の対象か (必須。既定値は無い)")
      .makeOptionMandatory(true)
      .argParser(nonEmpty),
  )
  .addOption(new Option("--label <label>", "足す行に付ける札 (何度でも)").argParser(collectLabel))
  .addOption(databaseUrlOption)
  .action(async (args: string[], opts: { org: string; label?: string[]; databaseUrl: string }) => {
    const collected = await collectUrls(args, () => {
      if (process.stdin.isTTY) process.stderr.write("標準入力から読む (終わりは Ctrl-D)\n");
      return readAll(process.stdin);
    });
    if (collected.kind === "error") return fail(collected.message);

    await withDb(opts.databaseUrl, async (db) => {
      const result = await addTargets(db, {
        orgId: opts.org,
        urls: collected.urls,
        labels: opts.label,
      });
      if (result.kind === "unreadable") {
        for (const url of result.urls) {
          process.stderr.write(`✗ 読めない  ${url}  —— http(s) の URL ではない\n`);
        }
        return fail("1 件も足していない。直してから、もう一度");
      }
      for (const target of result.added) say("✓", "足した", target);
      for (const target of result.reenabled) say("↺", "有効に戻した", target);
      for (const target of result.unchanged) say("=", "すでに在る", target);
      process.stdout.write(
        `${opts.org}: ${String(result.added.length)} 件を足した / ` +
          `${String(result.reenabled.length)} 件を有効に戻した / ` +
          `${String(result.unchanged.length)} 件はすでに在った\n`,
      );
    });
  });

const describeRow = (row: TargetRow): string =>
  `#${row.id}  ${row.orgId}  ${row.enabled ? "有効" : "無効"}  ${row.url}` +
  (row.labels.length > 0 ? `  [${row.labels.join(", ")}]` : "");

program
  .command("list")
  .description("撮る対象を並べる。組織ごとに、足した順 (クロールが種にする順)")
  .addOption(new Option("--org <id>", "この組織のぶんだけ").argParser(nonEmpty))
  .option("--json", "JSON で出す")
  .addOption(databaseUrlOption)
  .action(async (opts: { org?: string; json?: boolean; databaseUrl: string }) => {
    await withDb(opts.databaseUrl, async (db) => {
      const rows = await listTargets(db, opts.org === undefined ? {} : { orgId: opts.org });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      for (const row of rows) process.stdout.write(`${describeRow(row)}\n`);
      const enabled = rows.filter((row) => row.enabled).length;
      process.stdout.write(
        `${opts.org ?? "全部の組織"}: ${String(rows.length)} 件 ` +
          `(有効 ${String(enabled)}・無効 ${String(rows.length - enabled)})\n`,
      );
    });
  });

const toggle = (name: "enable" | "disable", enabled: boolean): void => {
  program
    .command(name)
    .description(
      enabled ? "無効にした行を、撮る対象に戻す" : "行を撮る対象から外す (消さない。履歴は残る)",
    )
    .argument("<id...>", "行の id (list の # の後ろの数)")
    .addOption(databaseUrlOption)
    .action(async (raw: string[], opts: { databaseUrl: string }) => {
      const ids = parseIds(raw);
      if (!ids) return fail(`id は 1 以上の整数で渡す: ${raw.join(" ")}`);
      await withDb(opts.databaseUrl, async (db) => {
        const result = await setEnabled(db, { ids, enabled });
        if (result.kind === "missing") {
          return fail(`見つからない id: #${result.ids.join(", #")}。何も変えていない`);
        }
        for (const target of result.changed) {
          say("✓", enabled ? "有効にした" : "無効にした", target);
        }
        for (const target of result.unchanged) {
          say("=", enabled ? "もともと有効" : "もともと無効", target);
        }
      });
    });
};
toggle("enable", true);
toggle("disable", false);

program
  .command("rm")
  .description("行を消す。履歴を残したいなら、消さずに disable する")
  .argument("<id...>", "行の id (list の # の後ろの数)")
  .addOption(databaseUrlOption)
  .action(async (raw: string[], opts: { databaseUrl: string }) => {
    const ids = parseIds(raw);
    if (!ids) return fail(`id は 1 以上の整数で渡す: ${raw.join(" ")}`);
    await withDb(opts.databaseUrl, async (db) => {
      const result = await removeTargets(db, { ids });
      if (result.kind === "missing") {
        return fail(`見つからない id: #${result.ids.join(", #")}。何も消していない`);
      }
      for (const target of result.removed) say("✓", "消した", target);
    });
  });

program.parseAsync(process.argv).catch(fatal);
