/**
 * robots.txt の例外 (`046`・t-6bc6) の登録の検査。**純粋な関数だけ** —— DB も時計も持たない (今の時刻は引数で受ける)。
 *
 * 行は「robots.txt が断っていても撮る」を許す物なので、字の形を狭く閉じる。
 *
 *   - ホストは `url.host` の形に整える (`crawl_pages.host` と同じ語彙)。wildcard は持たない
 *   - path の型は robots.txt と同じ書き方の 1 行。改行や `#` を許すと、型を robots.txt の規則として読む側が
 *     別の規則・注として読み、判じが覆る
 *   - 名乗る User-Agent は、道具の名 (`BrowserHive/<版>`) と、説明の頁の URL を書く括弧の注 1 つに限る。
 *     browser やほかのクローラの名に見せかける字を断る
 *
 * 断りは、欄の名前と決まった英語の句で返す (`problem`)。句は画面が訳す鍵になるので、字を変える時は
 * capture-workbench の訳の表と揃える。
 */
import type { RobotsExemptionAppliesTo, RobotsExemptionScope } from "../db/database.js";

export const PATH_PATTERN_MAX = 256;
export const USER_AGENT_MAX = 512;
export const REASON_MAX = 500;
/** 期限は登録から 90 日まで。延ばす時は新しい行を足す。 */
export const EXPIRES_MAX_DAYS = 90;
export const DAILY_LIMIT_DEFAULT = 100;
export const DAILY_LIMIT_MAX = 10_000;
export const LINK_LIMIT_DEFAULT = 20;
export const LINK_LIMIT_MAX = 1000;

const HOST_INPUT_MAX = 255;

/**
 * ホストを `url.host` の形に整える (小文字・punycode・既定でないポートは残る)。整えられない字は undefined。
 *
 * 受けるのはホストの名前 (とポート) だけ。scheme・path・userinfo・query・空白・wildcard (`*`) を含む字は断る ——
 * URL として読めても、利用者の書いた物とは別のホストに整ってしまう (`a@b` は `b` になる)。
 *
 * `https://` を前に付けて読むので、`:443` は落ちる (https の既定のポート)。末尾の点のある名 (`site.test.`) も断る ——
 * `url.host` は点を残すので、クロールの起点のホスト (`site.test`) と字で当たらず、どこにも効かない行になる。
 */
export const normalizeHost = (input: string): string | undefined => {
  const text = input.trim();
  if (text === "" || text.length > HOST_INPUT_MAX) return undefined;
  // URL の読み手は tab と改行を黙って落とし、`\` を `/` と読む。読ませる前に断る
  if (/[\s*/\\@?#]/.test(text) || text.endsWith(".")) return undefined;
  let url: URL;
  try {
    url = new URL(`https://${text}`);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
  return url.host === "" ? undefined : url.host;
};

/** path の型のどこが駄目か。良ければ undefined。 */
export const pathPatternProblem = (pattern: string): string | undefined => {
  if (!pattern.startsWith("/")) return "pathPattern must start with /";
  if (pattern.length > PATH_PATTERN_MAX) {
    return `pathPattern must be at most ${String(PATH_PATTERN_MAX)} characters`;
  }
  // 印字できる ASCII (0x21–0x7e) だけ。空白・改行はここで落ちる。`#` は robots.txt の注の始まり
  if (!/^[\x21-\x7e]+$/.test(pattern) || pattern.includes("#")) {
    return "pathPattern must be one line of printable ASCII without spaces or #";
  }
  return undefined;
};

/**
 * 道具の名と、任意の括弧の注 1 つ。注に書けるのは、名乗りを説明する頁の URL (`+https://…` か `+http://…`) だけ ——
 * 地の文を許すと、`(compatible; Googlebot)` のように別の道具や browser の名を並べて名乗れてしまう。
 */
const USER_AGENT_FORM =
  /^BrowserHive\/[0-9A-Za-z.+-]{1,32}(?: \(\+(https?:\/\/[\x21-\x27\x2a-\x7e]+)\))?$/;
/**
 * browser と、よく知られたクローラの印の語。字のどこに在っても断る (大文字小文字を問わない)。形で注を URL だけに
 * 絞ってあるので、これが効くのは URL の中 —— UA を見分ける側は字のどこかの `Chrome`・`Googlebot` を探すので、
 * URL の中でも見せかけの効き目は同じ。並びで閉じ切ることはできない (形の絞りが主で、これは念のため)。
 * `{chrome}` はクロールの User-Agent の欄の置き換えの字で、`chrome` に含まれるが、意図を残すために並べる。
 */
const OTHER_AGENT_WORDS = [
  "mozilla",
  "chrome",
  "safari",
  "applewebkit",
  "gecko",
  "firefox",
  "msie",
  "trident",
  "crios",
  "fxios",
  "{chrome}",
  "compatible",
  "googlebot",
  "bingbot",
  "twitterbot",
  "facebookexternalhit",
  "applebot",
  "slurp",
  "duckduckbot",
  "baiduspider",
  "yandex",
  "linkedinbot",
  "slackbot",
  "discordbot",
  "gptbot",
  "claudebot",
];
/** 短くて、ほかの語の一部にもなる印 (`knowledge` の edg、`cooperate` の opera)。語の境目で当てる。 */
const OTHER_AGENT_SHORT_WORDS = /\b(?:edg|edge|edga|edgios|opr|opera)\b/i;
/**
 * URL の中の、製品の印の形 (`<語>/<数字>`: `…/Edg/131.0`・`…/Version/17`)。日付や番号の段 (`…/docs/2024`) も
 * 同じ形なので断る —— 字の形が製品の印と見分けられない。
 */
const PRODUCT_TOKEN_IN_URL = /[A-Za-z]\/\d/;

/** 名乗る User-Agent のどこが駄目か。良ければ undefined。 */
export const userAgentProblem = (userAgent: string): string | undefined => {
  if (userAgent.length > USER_AGENT_MAX) {
    return `userAgent must be at most ${String(USER_AGENT_MAX)} characters`;
  }
  const lower = userAgent.toLowerCase();
  if (
    OTHER_AGENT_WORDS.some((word) => lower.includes(word)) ||
    OTHER_AGENT_SHORT_WORDS.test(userAgent)
  ) {
    return "userAgent must not contain the name of a browser or of another crawler";
  }
  const form =
    "userAgent must be BrowserHive/<version>, optionally followed by (+https://…) naming a page that describes it";
  const url = USER_AGENT_FORM.exec(userAgent)?.[1];
  if (!USER_AGENT_FORM.test(userAgent)) return form;
  if (url !== undefined && !URL.canParse(url)) return form;
  if (url !== undefined && PRODUCT_TOKEN_IN_URL.test(url)) {
    return "userAgent URL must not hold a letter followed by / and a digit (the form of a product token)";
  }
  return undefined;
};

/** 期限のどこが駄目か。登録の時刻より後で、90 日以内。 */
export const expiresAtProblem = (expiresAt: Date, now: Date): string | undefined => {
  if (Number.isNaN(expiresAt.getTime()))
    return "expiresAt must be an ISO 8601 date-time with an offset";
  if (expiresAt.getTime() <= now.getTime()) return "expiresAt must be in the future";
  if (expiresAt.getTime() > now.getTime() + EXPIRES_MAX_DAYS * 86_400_000) {
    return `expiresAt must be within ${String(EXPIRES_MAX_DAYS)} days`;
  }
  return undefined;
};

/** offset つきの ISO 8601。offset の無い字は、読む側の時間帯で意味が変わるので受けない。 */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const limitProblem = (name: string, value: number, max: number): string | undefined =>
  Number.isInteger(value) && value >= 1 && value <= max
    ? undefined
    : `${name} must be an integer between 1 and ${String(max)}`;

/** 登録の本文のうち、検査する欄 (`POST /api/robots-exemptions`)。組織は route が別に見る。 */
export interface ExemptionRequest {
  host?: string;
  pathPattern?: string;
  scope?: string;
  appliesTo?: string;
  userAgent?: string;
  reason?: string;
  expiresAt?: string;
  dailyLimit?: number;
  linkLimit?: number;
}

/** 検査を通った登録。既定を埋め、ホストと理由は整えた後の字。 */
export interface CheckedExemption {
  host: string;
  pathPattern: string;
  scope: RobotsExemptionScope;
  appliesTo: RobotsExemptionAppliesTo;
  userAgent: string;
  reason: string;
  expiresAt: Date;
  dailyLimit: number;
  linkLimit: number;
}

export type ExemptionCheck =
  | { kind: "valid"; exemption: CheckedExemption }
  /** 最初に見つけた 1 つ。`field` は本文の欄の名前。 */
  | { kind: "invalid"; field: keyof ExemptionRequest; problem: string };

/** 登録の本文を検査する。駄目な欄は、最初の 1 つを名指す。 */
export const checkExemption = (request: ExemptionRequest, now: Date): ExemptionCheck => {
  const invalid = (field: keyof ExemptionRequest, problem: string): ExemptionCheck => ({
    kind: "invalid",
    field,
    problem,
  });

  const host = normalizeHost(request.host ?? "");
  if (host === undefined) {
    return invalid(
      "host",
      "host must be a host name (with an optional port), without scheme, path, userinfo or wildcard",
    );
  }

  const pathPattern = request.pathPattern ?? "/";
  const pathProblem = pathPatternProblem(pathPattern);
  if (pathProblem !== undefined) return invalid("pathPattern", pathProblem);

  const { scope } = request;
  if (scope !== "seeds" && scope !== "links") {
    return invalid("scope", "scope must be seeds or links");
  }

  const appliesTo = request.appliesTo ?? "all";
  if (appliesTo !== "all" && appliesTo !== "human") {
    return invalid("appliesTo", "appliesTo must be all or human");
  }

  // 前後の空白も落とさずに見る。行に残る字が、そのまま相手のサーバに届く名乗りになる
  const userAgent = request.userAgent ?? "";
  if (userAgent === "") return invalid("userAgent", "userAgent is required");
  const agentProblem = userAgentProblem(userAgent);
  if (agentProblem !== undefined) return invalid("userAgent", agentProblem);

  const reason = (request.reason ?? "").trim();
  if (reason === "") return invalid("reason", "reason must not be blank");
  // 字は Unicode の code point で数える (`.length` は UTF-16 の code unit で、絵文字 1 つを 2 と数える)
  if ([...reason].length > REASON_MAX) {
    return invalid("reason", `reason must be at most ${String(REASON_MAX)} characters`);
  }

  const expiresText = request.expiresAt ?? "";
  const expiresAt = new Date(DATE_TIME.test(expiresText) ? expiresText : Number.NaN);
  const expiresProblem = expiresAtProblem(expiresAt, now);
  if (expiresProblem !== undefined) return invalid("expiresAt", expiresProblem);

  const dailyLimit = request.dailyLimit ?? DAILY_LIMIT_DEFAULT;
  const dailyProblem = limitProblem("dailyLimit", dailyLimit, DAILY_LIMIT_MAX);
  if (dailyProblem !== undefined) return invalid("dailyLimit", dailyProblem);

  const linkLimit = request.linkLimit ?? LINK_LIMIT_DEFAULT;
  const linkProblem = limitProblem("linkLimit", linkLimit, LINK_LIMIT_MAX);
  if (linkProblem !== undefined) return invalid("linkLimit", linkProblem);

  return {
    kind: "valid",
    exemption: {
      host,
      pathPattern,
      scope,
      appliesTo,
      userAgent,
      reason,
      expiresAt,
      dailyLimit,
      linkLimit,
    },
  };
};
