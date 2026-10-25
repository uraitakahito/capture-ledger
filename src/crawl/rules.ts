/**
 * 規則の並びで、見つけたリンクを撮って辿る・撮るだけ・落とすに分ける。
 *
 * 規則は「動き」と「当てる物」の組で、鍵が 1 つの object に書く (`{ "skip": "ads.example.com" }`)。
 * **上から当て、最初に当たった規則の動きを採る。どれにも当たらなければ落とす。**
 *
 *   - `follow`  —— 撮って、そのページのリンクも見る
 *   - `capture` —— 撮るだけ。そのページのリンクは見ない (撮るだけの先は辿らない)
 *   - `skip`    —— 次の段に入れない
 *
 * 当てる物は 3 種類。読み方は `parsePattern`。
 *
 *   - 起点からの範囲 (`same-origin`・`same-host`・`same-site`・`any`)。今までの範囲と同じく
 *     **起点と比べる** (`scope.ts` の冒頭)
 *   - ドメイン。そのホストと、その下のサブドメイン。**ラベルの境目で照らす** —— `ads.example.com` は
 *     `badads.example.com` に当たらない
 *   - URL の前方一致。受けたときに正規化した URL で、文字列として前方一致を見る (`/search` は
 *     `/searching` にも当たる。境目が要るなら末尾に `/`)
 *
 * 規則の番号は 1 から数える。画面の「n 行目」と揃えるため。0 は「どれにも当たらなかった」。
 *
 * ## 覆われた規則は断る
 *
 * 前の規則が当たる URL の集まりが、後ろの規則の集まりを必ず含むなら、後ろの規則は二度と当たらない。
 * 黙って通すと、書いた人は効いているつもりで結果を読む。**含むと言い切れるときだけ**断る ——
 * 正しい規則を断るほうが、覆いを見逃すより悪い (`covers`)。
 */
import type { CrawlRule, CrawlRuleAction } from "../db/database.js";
import {
  HOSTNAME,
  inScope,
  parseHttpUrl,
  siteOf,
  type DiscoveredLink,
  type ParsedUrl,
  type Scope,
} from "./scope.js";

/** 当てる物。前方一致は正規化した URL を持つ。 */
export type Pattern =
  | { kind: "scope"; scope: Scope }
  | { kind: "domain"; domain: string }
  | { kind: "prefix"; url: ParsedUrl };

export interface CompiledRule {
  action: CrawlRuleAction;
  pattern: Pattern;
}

/** 規則を省いた頼みの並び。今までの既定の範囲 (`same-origin`) と同じ動き。 */
export const DEFAULT_RULES: readonly CrawlRule[] = [{ follow: "same-origin" }];

const SCOPES: ReadonlySet<string> = new Set<Scope>([
  "same-origin",
  "same-host",
  "same-site",
  "any",
]);

/**
 * 当てる物を読む。読めなければ `undefined` (受け口は `invalid rule patterns` で名指す)。
 *
 * 範囲の名前が先で、次にホスト名 (スクリプトの札と同じ式)、最後に http(s) の URL。大文字の混じった
 * ホスト名・`*.example.com`・ポート付きのホスト名・`ftp://` は、どれにも読めない。
 */
export const parsePattern = (raw: string): Pattern | undefined => {
  if (SCOPES.has(raw)) return { kind: "scope", scope: raw as Scope };
  if (HOSTNAME.test(raw)) return { kind: "domain", domain: raw };
  const url = parseHttpUrl(raw);
  return url === undefined ? undefined : { kind: "prefix", url };
};

/** 規則 1 本の動きと当てる物。鍵がちょうど 1 つなのは、受け口の schema が守っている。 */
export const ruleParts = (rule: CrawlRule): { action: CrawlRuleAction; raw: string } => {
  const [action, raw] = Object.entries(rule)[0] as [CrawlRuleAction, string];
  return { action, raw };
};

/** 読んだ規則を、書き残す形に戻す。前方一致は正規化した URL になる。 */
export const ruleOf = ({ action, pattern }: CompiledRule): CrawlRule => {
  const text =
    pattern.kind === "scope"
      ? pattern.scope
      : pattern.kind === "domain"
        ? pattern.domain
        : pattern.url.normalized;
  switch (action) {
    case "follow":
      return { follow: text };
    case "capture":
      return { capture: text };
    case "skip":
      return { skip: text };
  }
};

const under = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

/** `url` に `pattern` が当たるか。範囲は起点と比べる。 */
export const matches = (url: ParsedUrl, pattern: Pattern, seeds: readonly ParsedUrl[]): boolean => {
  switch (pattern.kind) {
    case "scope":
      return inScope(url, seeds, pattern.scope);
    case "domain":
      return under(url.hostname, pattern.domain);
    case "prefix":
      return url.normalized.startsWith(pattern.url.normalized);
  }
};

export interface Decision {
  action: CrawlRuleAction;
  /** 当たった規則の番号。1 から数え、0 はどれにも当たらなかった。 */
  rule: number;
}

/** 上から当て、最初に当たった規則の動きと番号。どれにも当たらなければ落とす (番号 0)。 */
export const decide = (
  url: ParsedUrl,
  rules: readonly CompiledRule[],
  seeds: readonly ParsedUrl[],
): Decision => {
  for (const [i, rule] of rules.entries()) {
    if (matches(url, rule.pattern, seeds)) return { action: rule.action, rule: i + 1 };
  }
  return { action: "skip", rule: 0 };
};

/** そのページのリンクを見るか。リンク元が「撮って辿る」のときだけ —— 撮るだけの先は辿らない。 */
export const takeLinksFrom = (
  page: ParsedUrl,
  rules: readonly CompiledRule[],
  seeds: readonly ParsedUrl[],
): boolean => decide(page, rules, seeds).action === "follow";

const RANK: Record<Scope, number> = { "same-origin": 0, "same-host": 1, "same-site": 2, any: 3 };

/**
 * `a` に当たる URL の集まりが、`b` に当たる集まりを必ず含むか。言い切れないときは false (通す)。
 *
 *   - `any` は全部を含む
 *   - 範囲どうしは same-site ⊇ same-host ⊇ same-origin (どれも同じ起点と比べるので言える)
 *   - ドメインは、その下のドメインを含む。same-site は、起点のどれかと同じサイトのドメインを含む
 *   - 前方一致は、それで始まる長い前方一致を含む。前方一致に当たる URL はどれもその前方一致と同じ
 *     origin なので、前方一致の URL 1 本が範囲やドメインに当たれば、全部が当たる —— ただし前方一致が
 *     origin の直後の `/` まで在るときだけ (`https://example.com` だけなら `https://example.com.evil.net/`
 *     にも当たる。受けるときの正規化で `/` が付くので実際には来ないが、ここでも頼らない)
 *
 * 言い切れない組は通す: ドメインと same-origin・same-host (ドメインは別のホストも含む)、範囲やドメインと
 * 前方一致の逆向き、など。same-site とドメインには 1 つ穴がある —— Public Suffix List の私的な区画が
 * そのドメインの**さらに下**に在ると (貸し場所の `*.compute.amazonaws.com` のような形)、その下の名前は
 * 別のサイトになり、言い過ぎになる。断られた側は、規則を並べ替えれば通る。
 */
export const covers = (a: Pattern, b: Pattern, seeds: readonly ParsedUrl[]): boolean => {
  if (a.kind === "scope" && a.scope === "any") return true;
  switch (b.kind) {
    case "scope":
      return a.kind === "scope" && RANK[a.scope] >= RANK[b.scope];
    case "domain":
      if (a.kind === "domain") return under(b.domain, a.domain);
      return (
        a.kind === "scope" &&
        a.scope === "same-site" &&
        seeds.some((seed) => siteOf(seed.hostname) === siteOf(b.domain))
      );
    case "prefix":
      if (a.kind === "prefix") return b.url.normalized.startsWith(a.url.normalized);
      return b.url.normalized.startsWith(`${b.url.origin}/`) && matches(b.url, a, seeds);
  }
};

export interface RulesCheck {
  /** 読んだ規則。読めない物は `undefined` で、番号を揃えるために並びは頼まれたまま。 */
  read: (CompiledRule | undefined)[];
  /** 読めない規則。番号と、頼まれた当てる物。 */
  invalid: { rule: number; pattern: string }[];
  /** 前の規則に覆われて二度と当たらない規則と、覆っている規則の番号 (覆う規則のうち最も上)。 */
  covered: { rule: number; coveredBy: number }[];
  /** 「撮って辿る」に当たらない起点 (正規化した URL)。 */
  unfollowedSeeds: string[];
}

/**
 * 規則の並びを確かめる。始める口 (`POST /api/crawls`) と確かめの口 (`GET /api/crawl-rules/check`) が
 * 同じ物を使う —— 片方だけが通す並びを作らないため。
 *
 * 読めない規則は、覆いと起点の判定から外す。確かめの口は、読めない行があっても残りを確かめて返す。
 */
export const checkRules = (
  rules: readonly CrawlRule[],
  seeds: readonly ParsedUrl[],
): RulesCheck => {
  const read = rules.map((rule): CompiledRule | undefined => {
    const { action, raw } = ruleParts(rule);
    const pattern = parsePattern(raw);
    return pattern === undefined ? undefined : { action, pattern };
  });
  const invalid = rules.flatMap((rule, i) =>
    read[i] === undefined ? [{ rule: i + 1, pattern: ruleParts(rule).raw }] : [],
  );
  const covered = read.flatMap((rule, j) => {
    if (rule === undefined) return [];
    const by = read
      .slice(0, j)
      .findIndex(
        (earlier) => earlier !== undefined && covers(earlier.pattern, rule.pattern, seeds),
      );
    return by < 0 ? [] : [{ rule: j + 1, coveredBy: by + 1 }];
  });
  // 起点の動きに要るのは動きだけで、番号は要らない。読めない行を詰めてよい
  const usable = read.filter((rule) => rule !== undefined);
  const unfollowedSeeds = seeds
    .filter((seed) => decide(seed, usable, seeds).action !== "follow")
    .map((seed) => seed.normalized);
  return { read, invalid, covered, unfollowedSeeds };
};

/**
 * 行に固定した規則を読み直す。1 本でも読めなければ `undefined` —— 受け口が確かめてから書いているので、
 * 読めないなら行が壊れている。
 */
export const compileRules = (rules: readonly CrawlRule[]): CompiledRule[] | undefined => {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    const { action, raw } = ruleParts(rule);
    const pattern = parsePattern(raw);
    if (pattern === undefined) return undefined;
    compiled.push({ action, pattern });
  }
  return compiled;
};

/**
 * 1 本のリンクに規則を当てた結果。`host` はポートを含み (`crawl_pages.host`・ホストごとの間隔の単位)、
 * `hostname` は含まない (`crawl_decisions`・ドメインの単位)。
 */
export interface DecidedLink extends Decision {
  url: string;
  host: string;
  hostname: string;
}

/**
 * 1 ページのリンクに規則を当てる。
 *
 * 当てる前に落とすもの (どの規則の数にも入らない): http(s) でないもの、`rel="nofollow"`。`rel` は
 * 空白区切りの語の並びなので、部分一致ではなく語として見る (`nofollowme` のような値を誤って落とさない
 * ため)。**重複は落とさない** —— 数えるのは `aggregateDecisions` が別々の URL で、入れるのは
 * `acceptLinks` が 1 本にする。
 */
export const decideLinks = (
  links: readonly DiscoveredLink[],
  rules: readonly CompiledRule[],
  seeds: readonly ParsedUrl[],
): DecidedLink[] => {
  const decided: DecidedLink[] = [];
  for (const link of links) {
    const rel = (link.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("nofollow")) continue;

    const parsed = parseHttpUrl(link.href);
    if (parsed === undefined) continue;
    decided.push({
      url: parsed.normalized,
      host: parsed.host,
      hostname: parsed.hostname,
      ...decide(parsed, rules, seeds),
    });
  }
  return decided;
};

export interface AcceptedLink {
  url: string;
  host: string;
  /** 見つけたページの `crawl_pages.id`。行が引けなければ NULL。 */
  discoveredFrom: string | null;
}

/**
 * 次の段に入れるもの (撮って辿る・撮るだけ)。この呼び出しの中での重複は落とし、最初に見つけた
 * ページを残す。
 *
 * **クロール全体での重複は落とさない** —— それは `crawl_pages` の unique index の仕事で、2 か所で
 * 判断すると食い違ったときにどちらが正しいのか言えなくなる。
 */
export const acceptLinks = (
  pages: readonly { from: string | null; links: readonly DecidedLink[] }[],
): AcceptedLink[] => {
  const seen = new Set<string>();
  const accepted: AcceptedLink[] = [];
  for (const page of pages) {
    for (const link of page.links) {
      if (link.action === "skip" || seen.has(link.url)) continue;
      seen.add(link.url);
      accepted.push({ url: link.url, host: link.host, discoveredFrom: page.from });
    }
  }
  return accepted;
};
