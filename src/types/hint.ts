/**
 * 断りの文 1 つを、読む側が自分の言語の文に組み直せる形で運ぶ (`Hint`)。
 *
 * 断りの答えは、人に見せる日本語の文を `hint` (string) で返してきた。capture-workbench が同じ文を別の言語で
 * 出すには、文の種類と、文に埋めた値が要る —— 日本語の字を読んで見分ける作りは、字を 1 つ直しただけで外れる。
 * そこで答えに `hints` (この組の配列) を並べる。**`hint` の字は変えない** (欄を足すだけ)。
 *
 * ## 鍵は約束
 *
 * 下の `HINT_KEYS` が、鍵と、鍵ごとの値の名前の全部。**鍵と値の名前は、一度出したら変えない** —— 読む側が
 * 訳の表の見出しに使う。文の字 (`text`) は直してよい。鍵を足す・消す・名前を替えると `test/hints.test.ts` が
 * 赤になるので、そこで読む側 (capture-workbench の訳の表) と揃える。
 *
 * 鍵の形は `<まとまり>.<意味>` (英小文字で始まる camelCase を `.` で 2 つ)。まとまりは文の出どころ:
 * `params` (宣言の読み)・`variables` (頼みの変数の値の形)・`formats`・`inlineParams`・`fix` (直し方の案)。
 *
 * ## 鍵の付かない組
 *
 * 命令の例 (`wmill variable add …`) や、ほかの library が書いた文のように、訳す物でない文は `{ text }` だけ。
 */

/** 文に埋めた値。 */
export type HintValue = string | number | string[];

/** 断りの文 1 つ。`text` は人に見せる日本語の文（今までの hint と同じ字）。`key` と `params` は、画面が自分の言語の文に組み直すための物。 */
export interface Hint {
  /** 文の種類の名前。決まった文にだけ付く（命令の例のように、訳す物でない文には付かない） */
  key?: string;
  /** 文に埋めた値。string・number・string[]。埋めた値の無い文には付かない */
  params?: Record<string, HintValue>;
  text: string;
}

/** 文を返す関数が、読めた物の代わりに返す断り。読めた物とは `"refused" in x` で見分ける。 */
export interface Refused {
  refused: Hint;
}

/**
 * 鍵 → その文に埋める値の名前。**文に埋めた値は全部ここに並べる** (読む側が `text` を使わずに同じ文を組めるように)。
 * `JSON.stringify` して埋めた値は、埋めた字 (引用符つき) を string で入れる。
 */
export const HINT_KEYS = {
  // 宣言 (`params`) の読み —— `scripts/store.ts` の readParams
  "params.notArray": [],
  "params.tooMany": ["max"],
  "params.entryNotObject": [],
  "params.invalidName": ["name", "max"],
  "params.invalidKind": ["name", "kind"],
  "params.requiredNotBoolean": ["name"],
  "params.summaryNotString": ["name"],
  "params.summaryEmpty": ["name"],
  "params.unknownKeys": ["name", "keys"],
  "params.duplicateName": ["name"],
  "params.schemaOnlyForVariable": ["name"],
  "params.archiveOnlyForSecret": ["name"],
  "params.invalidArchive": ["name", "value"],
  // 変数の値の形 (`schema`) の読み —— 同じく readSchema
  "params.schemaMissing": ["name"],
  "params.schemaUnknownKeys": ["name", "keys"],
  "params.schemaTypeNotString": ["name"],
  "params.schemaInvalidLength": ["name"],
  "params.schemaInvalidEnum": ["name"],
  // 頼みの変数の値が、宣言の形に合わない —— `crawl/values.ts` の shapeProblem
  "variables.notInEnum": ["name", "values"],
  "variables.tooShort": ["name", "min"],
  "variables.tooLong": ["name", "max"],
  // 隠すシークレットと、値を置き換えられない形式 —— `crawl/values.ts` の formatsRefusal
  "formats.cannotHideSecrets": ["formats"],
  // その場の TS の `params` に変数の宣言 —— `crawl/prepare.ts`
  "inlineParams.secretsOnly": [],
  // 直し方の案を断る理由 —— `scripts/fix.ts`
  "fix.noEdits": [],
  "fix.invalidRange": ["from", "to"],
  "fix.outOfRange": ["line", "lines"],
  "fix.overlappingEdits": ["firstFrom", "firstTo", "secondFrom", "secondTo"],
  "fix.suppressedCheck": [],
  "fix.usedAny": [],
  "fix.addedModuleSyntax": [],
  "fix.tooManyLines": ["lines", "max"],
  "fix.unreadableAnswer": [],
} as const satisfies Record<string, readonly string[]>;

export type HintKey = keyof typeof HINT_KEYS;

type ParamName<K extends HintKey> = (typeof HINT_KEYS)[K][number];

/** 値を埋めない鍵は引数なし、埋める鍵は表の名前をちょうど全部。 */
type ParamsArg<K extends HintKey> = [ParamName<K>] extends [never]
  ? []
  : [params: Record<ParamName<K>, HintValue>];

/**
 * 鍵つきの組を作る。**表に無い鍵・表と違う値の名前は、型で落ちる。** `text` は呼ぶ側が雛形のまま組み、
 * 同じ値を `params` にも渡す (食い違いは `test/hints.test.ts` が、値が `text` に出ているかで見る)。
 */
export const hint = <K extends HintKey>(key: K, text: string, ...rest: ParamsArg<K>): Hint => {
  const [params] = rest;
  return { key, ...(params === undefined ? {} : { params }), text };
};

/** 断りとして返す形 (`{ refused }`) で、鍵つきの組を作る。引数は `hint` と同じ。 */
export const refusal = <K extends HintKey>(
  key: K,
  text: string,
  ...rest: ParamsArg<K>
): Refused => ({
  refused: hint(key, text, ...rest),
});

/**
 * `JSON.stringify` して文に埋める値の、埋めた字。`JSON.stringify` は undefined に undefined を返す (型は string と
 * 言う) ので、雛形が埋めるのと同じ字 (`"undefined"`) にして返す。
 */
export const quoted = (value: unknown): string => {
  const text: string | undefined = JSON.stringify(value);
  return String(text);
};
