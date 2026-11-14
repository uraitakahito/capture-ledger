/**
 * `pnpm run screenshots:locate <WACZ かフォルダ>…` (CAPTURE-432)。手元の WACZ に、検める時と同じ関数
 * (`archive/stage-screenshots.ts` の `locateStageScreenshots`) を掛け、時点ごとの結果を数える。DB も保管庫も環境変数も
 * 要らない。
 *
 * 数の切り方は「時点 × (位置が引けた・残さなかった理由・位置を引けなかった理由)」と、欄の無い本数。dev の WACZ を
 * 落として掛け、`archive_screenshots` に入る数を前もって知るのに使う。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { locateStageScreenshots } from "../archive/stage-screenshots.js";

const waczFiles = (paths: readonly string[]): string[] =>
  paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => name.endsWith(".wacz"))
          .sort()
          .map((name) => join(path, name))
      : [path],
  );

const main = async (): Promise<void> => {
  const files = waczFiles(process.argv.slice(2));
  if (files.length === 0) {
    process.stderr.write("WACZ のファイルかフォルダを渡す\n");
    process.exitCode = 2;
    return;
  }
  const counts = new Map<string, number>();
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  let noField = 0;
  let unreadable = 0;
  for (const file of files) {
    try {
      const rows = await locateStageScreenshots(readFileSync(file));
      if (rows === undefined) {
        noField += 1;
        continue;
      }
      for (const row of rows) {
        const what =
          row.kind === "located"
            ? "located"
            : row.kind === "skipped"
              ? `skipped:${row.skipped}`
              : `problem:${row.problem}`;
        bump(`${row.stage}\t${what}`);
        if (row.kind === "problem") process.stderr.write(`  ${file} ${row.stage} ${row.problem}\n`);
      }
    } catch (err) {
      unreadable += 1;
      process.stderr.write(
        `  読めなかった ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  process.stdout.write(
    `WACZ ${String(files.length)} 本・欄なし ${String(noField)} 本・読めなかった ${String(unreadable)} 本\n`,
  );
  for (const [key, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`${key}\t${String(n)}\n`);
  }
  if (unreadable > 0) process.exitCode = 1;
};

await main();
