/**
 * クロールの頼みを確かめ、走らせる物を解決する。**行は足さない。**
 *
 * `POST /api/crawls` と定期実行の周回で、同じ確かめを通すために切り出した。答えは 2 つだけで、断る理由と
 * 状態の番号 (`refused`) か、そのまま行にできる形 (`PreparedCrawl`) を返す。HTTP の応答は呼ぶ側が作る。
 */
import type { Kysely } from "kysely";
import type { CaptureFormats } from "../config/capture-formats.js";
import type { CrawlRule, CrawlScript, CrawlSecret, Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";
import {
  enabledLatest,
  INLINE_PREFIX,
  offsiteScripts,
  readParams,
  resolveScripts,
  VALUE_NAME,
  VALUE_NAME_MAX,
  VALUE_TEXT_MAX,
  VALUES_MAX,
  type RequestedScript,
} from "../scripts/store.js";
import { TsCompileUnreachable, type TsCompile } from "../scripts/ts-compile.js";
import { hint, type Hint } from "../types/hint.js";
import { checkRules, DEFAULT_RULES, ruleOf } from "./rules.js";
import { parseHttpUrl, type ParsedUrl } from "./scope.js";
import { toDispatched } from "./launch.js";
import { checkValues, formatsRefusal, pinDeclarations, type DeclaredSecret } from "./values.js";
import { WindmillUnreachable, type WindmillVariables } from "./windmill-variables.js";

const log = createChildLogger({ module: "api" });

/**
 * 既定の方針。**控えめな側に倒してある。**
 *
 * `MAX_PAGES` が小さいのは、深さより先にこちらで止まるのが普通であってほしいから ——
 * 上限が働いていることが日常的に見えていれば、「全部辿った」と思い込む余地が消える。
 * 広げるのは呼ぶ側の意図的な行為にする。
 *
 * `PER_HOST_DELAY_MS` は 1 回の取り込みが 1 リクエストではないことを踏まえた値。
 * ブラウザはサブリソースまで取るので、1 ページが相手には数十本のバーストに見える。
 */
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_PER_HOST_DELAY_MS = 2000;
const DEFAULT_HOST_PARALLELISM = 4;
/** 規則の当てる物の長さの上限。始めると確かめのエンドポイントで同じ数。 */
export const RULE_PATTERN_MAX = 2048;
/** 規則の本数の上限。始めると確かめのエンドポイントで同じ数。 */
export const RULES_MAX = 32;
/**
 * `POST /api/crawls` が受ける本文の上限。**capture-workbench の門（その src/lib.mjs の WRITE_LIMIT）と
 * 同じ 1 MiB** —— 片方だけを変えると、workbench が通すのに capture-ledger が 413、の形になる。Fastify の既定と同じ値だが、
 * 既定に頼らずにこのエンドポイントに書く。その先の BrowserHive は 4 MiB で、変換後の JS と登録済みのスクリプトを足しても収まる。
 */
export const CRAWL_BODY_LIMIT = 1024 * 1024;

/** BrowserHive の契約 (`CaptureRequest.userAgent`) と同じ形。 */
const USER_AGENT_FORM = /^[\x20-\x7e]{1,512}$/;

export interface CrawlBody {
  /** 起点の URL。**必須** だが、断るのは handler (`CRAWL_BODY_SCHEMA` の注記) なので型では省ける。 */
  seeds?: string[];
  /**
   * クロールごとの変数 (名前 → 文字列)。スクリプトが宣言した名前 (`params` の `variable`) だけを渡せ、
   * 行に固定されて段ごとに配られ、BrowserHive WACZ の `settings.variables` に**値が残る**。シークレットには欄が無い ——
   * 宣言した名前を Windmill の変数に結ぶ (`crawl/values.ts`)。
   */
  variables?: Record<string, string>;
  /**
   * このクロールで送る User-Agent。空白だけは省くのと同じ。形だけをここで断り、
   * `{chrome}` は解かずに BrowserHive まで運ぶ。
   */
  userAgent?: string;
  /**
   * どのリンクを撮って辿り、撮るだけにし、落とすか。**上から当て、最初に当たった規則が勝つ** (`crawl/rules.ts`)。
   * 省くと `[{ follow: "same-origin" }]` (起点と同じ origin を辿り、外は落とす)。
   */
  rules?: CrawlRule[];
  maxDepth?: number;
  maxPages?: number;
  perHostDelayMs?: number;
  hostParallelism?: number;
  /**
   * ページの中で走らせるもの。**並びがそのまま実行順**。要素は登録済みのスクリプトの名指し (`{ catalog }`) か、
   * その場で書いた TS (`{ inline }`)。その場の TS は登録されず、この行の写しにだけ固定される。
   *
   * 省くと登録済みのスクリプトの**有効な各 id の最新版**のうち、対象サイトの無い物と、起点に合うサイト用の物が走る
   * (`017`・`021`)。空配列を渡せば何も走らない ——
   * 「既定でよい」と「何も走らせない」は別の意思なので、書き分けられるようにしてある。
   */
  scripts?: RequestedScript[];
}

/** `POST /api/crawls` の本文の形。定期実行の頼みも同じ形で受ける。 */
export const CRAWL_BODY_SCHEMA = {
  type: "object",
  // 知らない鍵は拒む。`server.ts` の `removeAdditional: false` がこれを
  // 「黙って削る」ではなく「400 で返す」意味にしている。
  additionalProperties: false,
  // **`seeds` は必須だが、`required` には書かず handler で断る。** 本文の検査は名乗りより先に走るので、
  // ここに書くと `{}` が 401 ではなく 400 になる —— capture-scheduler の doctor は、名乗らずに `{}` を
  // 投げて 401 が返ることで、このエンドポイントが在ることを確かめている。
  properties: {
    // **1 本以上。** 起点を持たないクロールは始まりが無いので進みようがなく、
    // 受理されたのに何も起きない、という形になる (`011` の CHECK と対)。
    seeds: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    // **鍵が 1 つの object** の並び (下の `scripts` の要素と同じ形。誤りの場所だけが 400 に出る)。
    // 当てる物の読み方・前の規則との覆い・起点を辿るかは handler で見て、400 で名指す。
    rules: {
      type: "array",
      minItems: 1,
      maxItems: RULES_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        maxProperties: 1,
        properties: {
          follow: { type: "string", minLength: 1, maxLength: RULE_PATTERN_MAX },
          capture: { type: "string", minLength: 1, maxLength: RULE_PATTERN_MAX },
          skip: { type: "string", minLength: 1, maxLength: RULE_PATTERN_MAX },
        },
      },
    },
    maxDepth: { type: "integer", minimum: 0, maximum: 10 },
    maxPages: { type: "integer", minimum: 1, maximum: 10000 },
    // 0 を許すのは、試験で意図的に間隔を外せるようにするため。
    perHostDelayMs: { type: "integer", minimum: 0, maximum: 600000 },
    hostParallelism: { type: "integer", minimum: 1, maximum: 32 },
    // 字の形は handler で見て、読める文で断る (`pattern` の 400 は読めない)。
    userAgent: { type: "string" },
    // クロールごとの変数。名前の綴りと長さ・数・値の長さは BrowserHive の契約 (ValueName・ValueText・
    // Values) と同じ。宣言に在るか・required が揃っているかは handler で見て 400 で名指す (`crawl/values.ts`)。
    variables: {
      type: "object",
      maxProperties: VALUES_MAX,
      propertyNames: {
        type: "string",
        pattern: VALUE_NAME.source,
        maxLength: VALUE_NAME_MAX,
      },
      additionalProperties: { type: "string", maxLength: VALUE_TEXT_MAX },
    },
    // **空配列を許す。** 「既定でよい」(省く) と「何も走らせない」([]) を
    // 書き分けられるようにするため。
    //
    // 要素は**鍵が 1 つの object**。`oneOf` にしないのは、400 の文に別の枝の誤りが
    // 混ざるため (名前の綴りの誤りに「catalog が要る」が並ぶ)。この形なら誤りの場所だけが出る。
    scripts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        maxProperties: 1,
        properties: {
          catalog: { type: "string", minLength: 1 },
          inline: {
            type: "object",
            additionalProperties: false,
            required: ["name", "phase", "source"],
            properties: {
              // `inline-` と合わせて、ts-compile-service の ScriptId
              // (`^[a-z][a-z0-9-]*$`・64 字) に収まる綴り。変換の段まで行ってから
              // 400 になると、失敗したクロールが残る。
              name: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 57 },
              phase: { type: "string", enum: ["behavior", "preload"] },
              source: { type: "string", minLength: 1 },
              // シークレットの宣言 (catalog.json の params と同じ形)。変数は source の `defineParams` で
              // 宣言するので、kind: variable は handler が断る。重複と required の既定も handler
              params: {
                type: "array",
                maxItems: VALUES_MAX,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "kind"],
                  properties: {
                    name: {
                      type: "string",
                      pattern: VALUE_NAME.source,
                      maxLength: VALUE_NAME_MAX,
                    },
                    kind: { type: "string", enum: ["variable", "secret"] },
                    required: { type: "boolean" },
                    summary: { type: "string" },
                    // 値を BrowserHive WARC に残すか (capture-scripts の `/6`)。省けば BrowserHive が隠す
                    archive: { type: "string", enum: ["keep"] },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** 誰の頼みか。組織は行の帰属に、subject は行とログに使う。 */
export interface CrawlRequester {
  orgId: string;
  subject: string;
}

export interface PrepareDeps {
  db: Kysely<Database>;
  tsCompile: TsCompile;
  windmill?: WindmillVariables;
  /** この配備が頼む形式 (`config/capture-formats.ts`)。隠すシークレットと組めない形式なら断る (`formatsRefusal`)。 */
  formats: CaptureFormats;
}

/** 断る答え。**行はまだ無い。** `status` は 400 か 503 (呼んだサービスが答えない)。 */
export interface RefusedCrawl {
  kind: "refused";
  status: number;
  body: Record<string, unknown>;
}

/** 確かめが済んだ頼み。そのまま `crawls` の行と最初の段にできる。 */
export interface PreparedCrawl {
  kind: "prepared";
  seeds: ParsedUrl[];
  rules: CrawlRule[];
  maxDepth: number;
  maxPages: number;
  perHostDelayMs: number;
  hostParallelism: number;
  /** 解決して固定した写し。並びが実行順。 */
  scripts: CrawlScript[];
  variables: Record<string, string>;
  secrets: Record<string, CrawlSecret>;
  /** 宣言から集めたシークレット。定期実行は回ごとに、これを `resolveSecrets` で訊き直す。 */
  declaredSecrets: DeclaredSecret[];
  /** 打った字のまま (指定なしは `""`)。 */
  userAgent: string;
}

const refused = (status: number, body: Record<string, unknown>): RefusedCrawl => ({
  kind: "refused",
  status,
  body,
});

/**
 * 人に見せる文つきの断り。本文の `hint` は文を ` / ` で繋いだ字 (今までと同じ)、`hints` は文ごとの組
 * (`types/hint.ts`)。命令の例やスクリプトの id の並びのように、訳す物でない文は鍵なし (`{ text }` だけ)。
 */
const refusedWithHints = (
  status: number,
  body: Record<string, unknown>,
  text: string,
  hints: Hint[],
): RefusedCrawl => refused(status, { ...body, hint: text, hints });

/** その場の TS の `params` に、変数の宣言が書いてあるときの文。 */
export const INLINE_PARAMS_SECRETS_ONLY: Hint = hint(
  "inlineParams.secretsOnly",
  "params に書けるのはシークレットだけ。変数は source の defineParams で宣言する",
);

/** スクリプトを省いた頼みを断る文の終わりに添える案内。何も走らせないのは、明示の `scripts: []`。 */
const RUN_NOTHING_ON_PURPOSE = "(run nothing on purpose: send scripts: [])";

export type ResolvedSecrets =
  { kind: "resolved"; secrets: Record<string, CrawlSecret> } | RefusedCrawl;

/**
 * 宣言したシークレットが Windmill に在るかを訊き、行に固定する形 (path と更新時刻と、宣言の `archive`) にする。値は
 * 読まない。定期実行は作ったときだけでなく、回ごとにここを通す (消された変数で flow まで進まないため)。
 *
 * 答えの行の写しが、そのまま flow へ送る名前になる (`secretsForFlow`)。だから送れるかもここで決める: 隠す物が在るのに
 * 配備の形式が値を置き換えられなければ 400 (`formatsRefusal`)。周回も同じ答えを受けるので、回ごとに見直される。
 */
export const resolveSecrets = async (
  windmill: WindmillVariables | undefined,
  declared: readonly DeclaredSecret[],
  subject: string,
  formats: Readonly<CaptureFormats>,
): Promise<ResolvedSecrets> => {
  // **宣言したシークレットが Windmill に在るか。** 値は読まない (`crawl/windmill-variables.ts`)。required の
  // 物が無ければ 400 で名前と path を言い、secret でない変数が置かれていれば 400。required でない物が無ければ
  // 渡さないだけ (スクリプトは undefined を読む)。訊けなければ 503 で始めない —— Windmill に届かないなら
  // flow も動かない。
  const secrets: Record<string, CrawlSecret> = {};
  if (declared.length > 0) {
    if (windmill === undefined) {
      return refused(400, {
        error: "secrets need the windmill webhook",
        names: declared.map((secret) => secret.name),
      });
    }
    const unknown: DeclaredSecret[] = [];
    const notSecret: DeclaredSecret[] = [];
    try {
      for (const secret of declared) {
        const meta = (await windmill.exists(secret.path))
          ? await windmill.meta(secret.path)
          : undefined;
        if (meta === undefined) {
          if (secret.required) unknown.push(secret);
          continue;
        }
        if (!meta.isSecret) {
          notSecret.push(secret);
          continue;
        }
        secrets[secret.name] = {
          path: secret.path,
          editedAt: meta.editedAt,
          rotated: null,
          // 宣言の `keep` を写す。写し忘れると、残すつもりの値が黙って隠れる
          ...(secret.archive === "keep" && { archive: "keep" as const }),
        };
      }
    } catch (err) {
      if (!(err instanceof WindmillUnreachable)) throw err;
      log.warn({ err, subject: subject }, "Could not ask Windmill about the secrets");
      return refused(503, { error: "windmill unreachable" });
    }
    const named = (list: DeclaredSecret[]) =>
      list.map(({ name, path, declaredBy }) => ({ name, path, declaredBy }));
    if (unknown.length > 0) {
      // wmill CLI の綴り (値が先、path が後)。置き場は capture-scheduler の docs が案内する
      const commands = unknown.map(
        (secret) => `wmill variable add <value> ${secret.path} --secret`,
      );
      return refusedWithHints(
        400,
        { error: "unknown secrets", secrets: named(unknown) },
        commands.join(" / "),
        commands.map((text) => ({ text })),
      );
    }
    if (notSecret.length > 0) {
      return refused(400, { error: "not a secret variable", secrets: named(notSecret) });
    }
  }
  const withheld = formatsRefusal(formats, secrets);
  if (withheld !== undefined) return refused(400, withheld);
  return { kind: "resolved", secrets };
};

export const prepareCrawl = async (
  deps: PrepareDeps,
  body: CrawlBody,
  who: CrawlRequester,
): Promise<PreparedCrawl | RefusedCrawl> => {
  const { db, tsCompile } = deps;

  // 起点が無ければ始まりが無い。保存された予定の頼みを読み直す「固定し直す」もここを通るので、
  // `seeds` の無い古い行も、500 ではなくこの文で断られる。
  if (body.seeds === undefined) {
    return refused(400, { error: "seeds is required" });
  }

  // BrowserHive の契約と同じ形 (印字可能な ASCII・512 字以下)。字の中身は頼む人が決める。
  const userAgent = body.userAgent?.trim() ?? "";
  if (userAgent !== "" && !USER_AGENT_FORM.test(userAgent)) {
    return refused(400, { error: "userAgent must be printable ASCII, at most 512 characters" });
  }

  // 読めない起点の URL が 1 本でもあれば拒む。**黙って落とさない** ——
  // 落とすと、投げた側は全部辿ったつもりで結果を読むことになる。
  const seeds = body.seeds.map((raw) => parseHttpUrl(raw));
  if (seeds.some((parsed) => parsed === undefined)) {
    return refused(400, { error: "every seed must be an http(s) URL" });
  }
  const parsedSeeds = seeds as ParsedUrl[];

  // **規則を確かめる。** 読めない・前の規則に覆われて二度と当たらない・起点を辿らない、のどれも 400 で
  // 名指す —— 通すと、効いているつもりの規則でクロールが走る。確かめのエンドポイントと同じ関数で見る。
  const checked = checkRules(body.rules ?? DEFAULT_RULES, parsedSeeds);
  if (checked.invalid.length > 0) {
    return refused(400, { error: "invalid rule patterns", rules: checked.invalid });
  }
  if (checked.covered.length > 0) {
    return refused(400, { error: "rules that can never match", rules: checked.covered });
  }
  if (checked.unfollowedSeeds.length > 0) {
    return refused(400, { error: "seeds the rules do not follow", seeds: checked.unfollowedSeeds });
  }
  // 読んだ形で固定する (前方一致は正規化した URL)。報告のたびにこれを読み直して当てる
  const rules = checked.read.filter((rule) => rule !== undefined).map(ruleOf);

  // 走らせるものを **いま 1 度だけ** 決める。登録済みのスクリプトは後から変わりうるが、
  // このクロールが走らせるものは変わらない (`018`)。対象サイト (`021`) と比べるのは起点のホスト名で、
  // ポートは見ない —— 省いた頼みでは、対象サイトの無い物と、起点に合うサイト用の物が走る
  const seedHosts = [...new Set(parsedSeeds.map((parsed) => parsed.hostname))];
  // その場の TS の宣言は、catalog と同じ決まりで読んでから写す (重複と required の既定は schema が見ない)。
  // 添えなかった物は添えないまま —— 「宣言が無い」と「何も読まない」は別 (`crawl/values.ts`)
  const requested: RequestedScript[] = [];
  for (const element of body.scripts ?? []) {
    if (!("inline" in element) || element.inline.params === undefined) {
      requested.push(element);
      continue;
    }
    // 変数の宣言の正は source の `defineParams`。ここにも書けると、宣言が 2 か所になって片方が腐る
    if (element.inline.params.some((param) => param.kind === "variable")) {
      return refusedWithHints(
        400,
        { error: "invalid params", script: INLINE_PREFIX + element.inline.name },
        INLINE_PARAMS_SECRETS_ONLY.text,
        [INLINE_PARAMS_SECRETS_ONLY],
      );
    }
    const params = readParams(element.inline.params, { summaryRequired: false });
    if ("refused" in params) {
      return refusedWithHints(
        400,
        { error: "invalid params", script: INLINE_PREFIX + element.inline.name },
        params.refused.text,
        [params.refused],
      );
    }
    requested.push({ inline: { ...element.inline, params } });
  }
  const resolved = await resolveScripts(
    db,
    body.scripts === undefined ? undefined : requested,
    seedHosts,
  );
  if (resolved.kind === "missing") {
    return refused(400, { error: "unknown script ids", ids: resolved.ids });
  }
  if (resolved.kind === "duplicate") {
    return refused(400, { error: "duplicate script ids", ids: resolved.ids });
  }

  // **名指しで入れたサイト用のスクリプトは、起点のどれかがそのサイトにあること。** 通すと、どの頁でも
  // 冒頭の見分けで何もせずに終わるスクリプトを、走らせたと記録することになる。外す (名指さない) のは自由
  const offsite = offsiteScripts(resolved.scripts, seedHosts);
  if (offsite.length > 0) {
    const theirSites = offsite.map((script) => `${script.id}: ${script.sites.join(", ")}`);
    return refusedWithHints(
      400,
      { error: "site scripts need a seed on their site", ids: offsite.map((script) => script.id) },
      theirSites.join(" / "),
      theirSites.map((text) => ({ text })),
    );
  }

  // **既定を頼まれたのに、既定が空。** スクリプトを登録し忘れた配備はここで止まる ——
  // 通すと、スクロールも遅延読み込みもしないクロールが「成功」として出ていく。
  // アーカイブは出るし `completeness` も緑なので、**後から見分ける手が無い**。
  //
  // 明示の `scripts: []` は通す: 設定漏れと「何も走らせない」という意思は別物で、
  // 後者を表せなくすると、素の取り込みが欲しい配備がスクリプトを登録させられることになる。
  if (body.scripts === undefined && resolved.scripts.length === 0) {
    // スクリプトは在るのに、全部が別のサイト用 —— 「スクリプトが無い」とは言わない (取り込み直しても直らない)
    const enabled = await enabledLatest(db);
    if (enabled.length > 0) {
      const theirSites = enabled.map((script) => `${script.id}: ${script.sites.join(", ")}`);
      return refusedWithHints(
        400,
        { error: "no default scripts for these seeds" },
        `${theirSites.join(" / ")} ${RUN_NOTHING_ON_PURPOSE}`,
        [...theirSites, RUN_NOTHING_ON_PURPOSE].map((text) => ({ text })),
      );
    }
    const command = "pnpm run scripts import .upstream/capture-scripts";
    return refusedWithHints(
      400,
      { error: "no scripts are registered" },
      `${command} ${RUN_NOTHING_ON_PURPOSE}`,
      [command, RUN_NOTHING_ON_PURPOSE].map((text) => ({ text })),
    );
  }

  // **クロールごとの値を、宣言に照らす。** 変数は頼みの物 (無ければ空)、シークレットは宣言から集める
  // (`crawl/values.ts`)。断るのは行を立てる前 —— 行は残らない。
  const variables = body.variables ?? {};

  // **始める前に compile に訊く。** 必須の変数が足りなければ 400 で断り、行も run も残さない —— 判定は
  // ts-compile-service の 1 か所 (BH0001) で、送るのは名前だけ。答えの宣言は行に固定する。ふつうの型の誤りは
  // ここでは断らない: 行を立て、flow の compile の段で落ちた行から「直し方を訊く」へ進む。
  let pinned = resolved.scripts;
  let unreadable = false;
  if (resolved.scripts.length > 0) {
    let answer;
    try {
      answer = await tsCompile.compile(resolved.scripts.map(toDispatched), Object.keys(variables));
    } catch (err) {
      if (!(err instanceof TsCompileUnreachable)) throw err;
      log.warn({ err, subject: who.subject }, "ts-compile-service did not answer");
      return refused(503, { error: "ts-compile unreachable" });
    }
    if (!answer.ok && answer.missingVariables.length > 0) {
      return refused(400, {
        error: "missing variables",
        names: answer.missingVariables,
        diagnostics: answer.diagnostics.filter((d) => d.code === "BH0001"),
      });
    }
    pinned = pinDeclarations(resolved.scripts, answer.declarations);
    unreadable = answer.declarations.some((declared) => declared.unreadable);
  }

  const values = checkValues(pinned, variables, { unreadable });
  if (values.kind === "refused") return refused(400, values.body);

  const resolvedSecrets = await resolveSecrets(
    deps.windmill,
    values.secrets,
    who.subject,
    deps.formats,
  );
  if (resolvedSecrets.kind === "refused") return resolvedSecrets;

  return {
    kind: "prepared",
    seeds: parsedSeeds,
    rules,
    maxDepth: body.maxDepth ?? DEFAULT_MAX_DEPTH,
    // 既定の 30 だと、名指しした起点まで切り落とされうる。**起点の数は下回らせない。**
    maxPages: body.maxPages ?? Math.max(DEFAULT_MAX_PAGES, parsedSeeds.length),
    perHostDelayMs: body.perHostDelayMs ?? DEFAULT_PER_HOST_DELAY_MS,
    hostParallelism: body.hostParallelism ?? DEFAULT_HOST_PARALLELISM,
    scripts: pinned,
    variables,
    secrets: resolvedSecrets.secrets,
    declaredSecrets: values.secrets,
    userAgent,
  };
};
