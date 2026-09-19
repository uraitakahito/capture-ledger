import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { satteri } from "@astrojs/markdown-satteri";
import mdastCodeRegion from "./src/plugins/mdast-code-region";
import hastRebaseLinks from "./src/plugins/hast-rebase-links";

const BASE = "/capture-ledger";

// BrowserHive の公開ドキュメント。ledger は BrowserHive の挙動を一切書かず、
// ここへリンクする(DRY: 一次情報は向こうにしかない)。絶対 URL なのは意図的で、
// root-relative にすると Starlight が日本語ページ上で /ja/ を注入し 404 になる。

export default defineConfig({
  site: "https://uraitakahito.github.io",
  base: BASE,
  // `urls` は v0.21.0 で `capture_targets` に改名した。ページの名前も変えたので、
  // 古い URL への外部リンク (issue、ブックマーク、会話に貼られたもの) が 404 になる。
  // 名前が悪かったという理由での改名で読み手のリンクを切るのは筋が通らないので、
  // 転送を残す。
  //
  // **鍵と値で base の扱いが違う。** 鍵は base 抜き (astro が出力先を
  // `dist/databases/urls/` に置き、それが `/capture-ledger/databases/urls/` になる)。
  // 値は **base を自分で付ける** —— astro は転送先を書き換えないので、
  // `/databases/...` と書くとドメイン直下を指して 404 になる。
  redirects: {
    "/databases/urls": `${BASE}/databases/capture-targets`,
    "/ja/databases/urls": `${BASE}/ja/databases/capture-targets`,
  },
  integrations: [
    // ```mermaid をクライアントサイドで描画。starlight より前に置く。
    //
    // wrappingWidth は mermaid 11 の既定値 (200) を明示している。mermaid 12 は既定を 120 に
    // 狭めたので、書かないと「決める・記録する」のような短い行が語の途中で折れる (実際に
    // トップページの図がそうなった)。図のソースは改行を <br/> で書いてあり、自動の折り返し
    // には頼っていない。
    //
    // 配置は mermaid 12 の既定 (ELK) に任せている。mermaid 11 の配置に戻すなら
    // mermaidConfig に layout: "dagre" を足す —— 2026-09 に両方を撮って比べ、architecture の
    // 2 枚目が読める大きさになる ELK を採った。
    mermaid({ theme: "neutral", mermaidConfig: { flowchart: { wrappingWidth: 200 } } }),
    starlight({
      title: "capture-ledger Docs",
      customCss: ["./src/styles/tables.css"],
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ja: { label: "日本語", lang: "ja" },
      },
      // 各項目に `ja` 訳を持たせる。Starlight はページを翻訳するが
      // ナビゲーションは翻訳しないので、これが無いと日本語ドキュメントは
      // 翻訳済みのページが英語の目次にぶら下がった状態になる。
      sidebar: [
        { label: "Quickstart", translations: { ja: "クイックスタート" }, slug: "quickstart" },
        {
          label: "Guides",
          translations: { ja: "ガイド" },
          items: [
            {
              label: "Development environment",
              translations: { ja: "開発環境" },
              slug: "development-environment",
            },
            { label: "URL source", translations: { ja: "URL ソース" }, slug: "url-source" },
            {
              label: "Capture options",
              translations: { ja: "キャプチャオプション" },
              slug: "capture-options",
            },
            // 何を撮るか → どう撮るか → **撮れたものを見る** → 台帳と API の詳細、の順。
            {
              label: "Browsing archives",
              translations: { ja: "アーカイブを見る" },
              slug: "picker",
            },
            {
              label: "Archive ledger",
              translations: { ja: "アーカイブ台帳" },
              slug: "archive-ledger",
            },
            {
              label: "Upgrading BrowserHive",
              translations: { ja: "BrowserHive の更新" },
              slug: "upgrading-browserhive",
            },
          ],
        },
        {
          label: "For developers",
          translations: { ja: "開発者向け" },
          items: [
            { label: "Architecture", translations: { ja: "アーキテクチャ" }, slug: "architecture" },
            {
              label: "Databases",
              translations: { ja: "データベース" },
              items: [
                { label: "Overview", translations: { ja: "全体像" }, slug: "databases" },
                { label: "capture_targets", slug: "databases/capture-targets" },
                { label: "capture_submissions", slug: "databases/capture-submissions" },
                { label: "archives", slug: "databases/archives" },
                { label: "fga_outbox", slug: "databases/fga-outbox" },
                { label: "tuple", slug: "databases/tuple" },
              ],
            },
          ],
        },
        // 一次情報 (BrowserHive の docs) への出口はここに置いていた。あちらが
        // web への公開をやめ、チェックアウトで `pnpm run docs:local` を実行して
        // 読む形になったので、リンクとして張れるものが無くなった。
      ],
    }),
  ],
  // ```ts file="src/…#region" を実ソースに差し替える(コード片を live 化)
  markdown: {
    // Astro 7.2 の既定プロセッサ。legacy の remarkPlugins/rehypePlugins は
    // @astrojs/markdown-remark(unified) を要求するので、そちらは使わない。
    processor: satteri({
      mdastPlugins: [mdastCodeRegion],
      hastPlugins: [hastRebaseLinks],
    }),
  },
});
