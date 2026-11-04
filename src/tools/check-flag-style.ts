/**
 * `pnpm run <script> -- --flag` と書いていないか見張る。
 *
 * npm は `--` を「ここから先は script への引数」の合図として食べるが、**pnpm は
 * 食べずにそのまま子プロセスへ渡す。** だから `pnpm run <script> -- --flag` と書くと、
 * commander には `--` が 1 個目の引数として届く。commander はそこで
 * オプションの解釈をやめるので、`--since-days` は**ただの余った引数**になり、
 * **旗を渡したつもりで既定の振る舞いが走る。**
 *
 * 誤りが例外にならないのが厄介なところ。落ちないし、警告も出ない。docs に書けば
 * そのまま人が写す。実際に踏んだ (2026-09-10、`archive-ledger.md` の en/ja 両方)。
 *
 * この検査は元々 CI の workflow に inline の shell として在り、**手元では走らせ
 * ようが無かった。** script に出したのは、CI と `pnpm run check` が同じものを
 * 走らせるようにするため —— 検査が片側にしか無いと、もう片側は必ず遅れる。
 *
 *   pnpm run check:flag-style        # check から自動で走る
 *
 * 見つかれば終了コード 1。効いていることを見たいなら、どこかの .md に
 * `pnpm run build`・空白・ハイフン 2 つ・空白・`--watch` と書いて走らせ直すこと。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./root.js";

/**
 * 走査しないもの。`.upstream` は別の repo の写しで、綴りを決めるのは向こう側。
 * `dist` は生成物なので、直すなら元のほう。
 */
const SKIP = new Set(["node_modules", ".git", ".upstream", "dist", ".astro", "coverage"]);

/**
 * `pnpm run <script> -- -<何か>`。CI の workflow に在った grep の形に、script の名前の `-` を足した物
 * (`[a-z:]+` だけだと `check-env`・`replay-bundle:rebuild` のような名前の誤りを素通りした)。
 */
const PATTERN = /pnpm run [a-z:-]+ -- -/;

interface Hit {
  path: string;
  line: number;
  text: string;
}

const walk = (dir: string): Hit[] => {
  const found: Hit[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
      continue;
    }
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // 読めないもの (binary 等) は対象外
    }
    text.split("\n").forEach((line, i) => {
      if (PATTERN.test(line))
        found.push({ path: relative(ROOT, path), line: i + 1, text: line.trim() });
    });
  }
  return found;
};

const hits = walk(ROOT);
if (hits.length > 0) {
  console.error("pnpm では `--` が literal で渡ります。落としてください:\n");
  for (const hit of hits) console.error(`  ${hit.path}:${String(hit.line)}  ${hit.text}`);
  console.error(`\n${String(hits.length)} 件`);
  process.exit(1);
}
console.log("✓ flag-style check passed: no npm-style `--` before flags");
