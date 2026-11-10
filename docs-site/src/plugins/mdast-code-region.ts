// ```ts file="src/…#region" のコードフェンスを、現在の実ソース片に置換する
// Sätteri の MDAST プラグイン。doc にコードを手書きコピーせず常に最新を取り込む。
//
// Astro 7.2 で既定の Markdown プロセッサが Sätteri に変わり、remark(unified)
// 版はここへ移した。走査は処理系がやるので、ノード種別ごとの visitor を
// 宣言するだけでよい(以前は自前で再帰していた)。
import { defineMdastPlugin } from "satteri";
import { sourceRegion } from "../lib/extract";

export default defineMdastPlugin({
  name: "code-region",
  code(node, ctx) {
    if (typeof node.meta !== "string") return;
    const m = /file="([^"#]+)#([^"]+)"/.exec(node.meta);
    if (!m) return;
    // **直接代入 (node.value = …) は届かない。** Sätteri の木は arena 側に
    // あり、JS の node はそのビュー。書き込みは setProperty 経由で
    // command buffer に積む必要がある。直接代入はエラーにもならず
    // 黙って無視されるので、置換が効いていないことに気づけない。
    ctx.setProperty(node, "value", sourceRegion(m[1], m[2])); // region 欠落なら throw。ただし build が落ちるのは .mdx だけ (.md は Starlight が握ってログに残すのみ)。守るのは site:check の check-doc-refs
  },
});
