/**
 * 直す係の評価 (CAPTURE-49)。よく落ちる型の誤りの見本を、本物の ts-compile-service と Claude で直させ、
 * 2 回までに通ったか・回数・断った理由・費用を表で出す。
 *
 * **Claude を本当に呼ぶので、お金が掛かる** (見本ごとと合計の費用を出す)。CI では走らない。DB も台帳の API も
 * 使わない —— エンドポイント (`POST /api/crawls/:id/inline/:name/fix`) と同じ `fixInline` を、組み合わせを直に渡して呼ぶ。
 * 受け皿の型は、`scripts import` が `host_types` に写すのと同じ file (capture-scripts の submodule) から読む。
 *
 * 読む env: `CAPTURE_LEDGER_ANTHROPIC_API_KEY` (必須)・`CAPTURE_LEDGER_TS_COMPILE_URL` (既定
 * `http://127.0.0.1:28080`。capture-scheduler の compose が出すポート)。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";

import { fixModelOf } from "../claude/client.js";
import { optional, required } from "../config/read-env.js";
import type { CrawlScript } from "../db/database.js";
import { fixInline } from "../scripts/fix.js";
import { attributeDiagnostics, tsCompileAt } from "../scripts/ts-compile.js";

/** 受け皿の型 (`__bh`)。台帳の `host_types` の元と同じ file。 */
const HOST_TYPES = ".upstream/capture-scripts/types/host.d.ts";

interface Sample {
  name: string;
  inline: string;
  /** 一緒に走る (読むだけの) スクリプト。 */
  others?: readonly [id: string, source: string][];
  /** クロールに渡された変数の名前。 */
  variableNames?: readonly string[];
}

/** 見本。どれも、本物の ts-compile-service で型の誤りになる形 (CAPTURE-49 の計画の 8 節)。 */
const SAMPLES: readonly Sample[] = [
  {
    name: "型の無い引数 (TS7006)",
    inline: "(() => {\n  const press = (el) => el.click();\n  void press;\n})();\n",
  },
  {
    name: "null かもしれない値 (TS18047)",
    inline:
      '(() => {\n  const box = document.querySelector<HTMLInputElement>("input");\n  box.value = "個人情報";\n})();\n',
  },
  { name: "DOM の大域と重なる const name (TS2451)", inline: 'const name = "query";\nvoid name;\n' },
  {
    name: "top-level の await (TS1375。export {} を足させない)",
    inline: "await new Promise((resolve) => setTimeout(resolve, 100));\n",
  },
  {
    name: "台帳のスクリプトとの const step の重なり (TS2451)",
    inline: "const step = 1;\nvoid step;\n",
    others: [["step-catalog", "const step = 2;\nvoid step;\n"]],
  },
  {
    name: "zod の import を持つ TS の型の誤り (TS2322。import を消させない)",
    inline:
      'import { z } from "zod";\n\n(async () => {\n  const n: number = z.string().parse(document.title);\n  globalThis.__bh.report({ n });\n})();\n',
  },
  {
    name: "defineParams を持つ TS の型の誤り (TS2322。必須を任意にさせない)",
    inline:
      'import { z } from "zod";\n\n(() => {\n  const { query } = defineParams(z.object({ query: z.string().min(1) }));\n  const hits: number = query;\n  globalThis.__bh.report({ hits });\n})();\n',
    variableNames: ["query"],
  },
  {
    name: "DOM の型の食い違い (TS2339。as any で黙らせさせない)",
    inline:
      '(() => {\n  const field = document.querySelector(".search");\n  if (field) field.value = "x";\n})();\n',
  },
];

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const script = (id: string, source: string): CrawlScript => ({
  id,
  version: 1,
  phase: "behavior",
  source,
  sha256: sha256(source),
  options: {},
});

const main = async (): Promise<void> => {
  const tsCompile = tsCompileAt({
    base: optional("CAPTURE_LEDGER_TS_COMPILE_URL", "http://127.0.0.1:28080").replace(/\/+$/, ""),
    timeoutMs: 10_000,
  });
  const model = fixModelOf(new Anthropic({ apiKey: required("CAPTURE_LEDGER_ANTHROPIC_API_KEY") }));
  let hostTypes: string;
  try {
    hostTypes = readFileSync(HOST_TYPES, "utf8");
  } catch {
    throw new Error(`${HOST_TYPES} が読めない (.upstream が空なら git submodule update --init)`);
  }

  let total = 0;
  let fixed = 0;
  for (const sample of SAMPLES) {
    const inline = script("inline-sample", sample.inline);
    const scripts = [inline, ...(sample.others ?? []).map(([id, source]) => script(id, source))];
    const variableNames = sample.variableNames ?? [];
    const before = await tsCompile.compile(scripts, variableNames);
    if (before.ok) {
      console.log(`✗ ${sample.name}: 見本が型を通ってしまう (見本を直す)`);
      continue;
    }
    const diagnostics = attributeDiagnostics(
      before.diagnostics,
      scripts.map((s) => s.id),
    );
    const result = await fixInline({
      scripts,
      inlineId: inline.id,
      diagnostics,
      typescript: before.typescript,
      hostTypes,
      tsCompile,
      variableNames,
      model,
    });
    total += result.usd;
    if (result.kind === "fixed") fixed += 1;
    const mark = result.kind === "fixed" ? "✓" : "✗";
    console.log(
      `${mark} ${sample.name}: ${result.kind}・${String(result.rounds)} 回・$${result.usd.toFixed(4)}` +
        (result.kind === "failed" && result.refusals.length > 0
          ? `・断った: ${result.refusals.join(" / ")}`
          : ""),
    );
    if (result.kind === "fixed") {
      for (const h of result.hunks) {
        for (const line of h.before) console.log(`    - ${line}`);
        for (const line of h.after) console.log(`    + ${line}`);
      }
    }
  }
  console.log(`\n通った ${String(fixed)} / ${String(SAMPLES.length)}・費用 $${total.toFixed(4)}`);
};

await main();
