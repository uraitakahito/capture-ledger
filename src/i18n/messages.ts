/**
 * capture-ledger が自分で訳す文 (`Message`) —— 文の鍵と、文に埋めた値を持ち、返す時に言語ごとの辞書で組む。
 *
 * 保存される文 (クロールの `error`) は、1 つの言語の字でしか残せない。別の言語で返すには、どの文かと、
 * 埋めた値が要る。そこで文を書く側は、字と一緒に鍵と値 (`crawls.error_key`・`error_params`・`048`) を残し、
 * 返す側が `render` で組む。
 *
 * ## 断りの文 (`types/hint.ts`) とは別の表
 *
 * `HINT_KEYS` は「読む側 (capture-workbench) が訳す」文の約束で、workbench が写しを持つ。ここの
 * `MESSAGE_KEYS` は「capture-ledger が訳す」文で、辞書 (`locales/*.json`) はこの repo の中に在る。
 * 混ぜると、workbench の訳の表に、訳さない鍵が増える。
 *
 * ## 鍵は約束
 *
 * **鍵と値の名前は、一度出したら変えない** —— DB の行に残り、答えの `errorKey`・`errorParams` で
 * 読む側にも見える。文の字 (辞書) は直してよい: 鍵の在る行は返すたびに組むので、前に保存した行も新しい字で返る。
 * 鍵を足す・消す・値の名前を替えると `test/i18n-catalog.test.ts` が赤になる。
 *
 * 辞書は ICU MessageFormat (wacz-validator の `packages/core/src/i18n` と同じ作り)。値は文として読み解かれない
 * ので、理由の字 (BrowserHive の文) が `{` や `'` を含んでも、そのまま出る。
 */
import { IntlMessageFormat } from "intl-messageformat";
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };

/** 辞書を持つ言語。 */
export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 鍵 → その文に埋める値の名前。**文に埋めた値は全部ここに並べる。** */
export const MESSAGE_KEYS = {
  // 1 枚も撮れずに終わったクロール (`crawl/close.ts`)。理由の無い時・在る時
  "crawl.nothingCaptured": ["failed", "skipped"],
  "crawl.nothingCapturedBecause": ["failed", "skipped", "reason"],
  // migration 030 が、過去の行に書いた文
  "crawl.nothingCapturedBackfilled": [],
} as const satisfies Record<string, readonly string[]>;

export type MessageKey = keyof typeof MESSAGE_KEYS;

/** 文に埋めた値。 */
export type MessageValue = string | number;
export type MessageParams = Record<string, MessageValue>;

/** 文 1 つ。鍵と、埋めた値。 */
export interface Message {
  key: MessageKey;
  params: MessageParams;
}

type ParamName<K extends MessageKey> = (typeof MESSAGE_KEYS)[K][number];

/** 値を埋めない鍵は引数なし、埋める鍵は表の名前をちょうど全部。 */
type ParamsArg<K extends MessageKey> = [ParamName<K>] extends [never]
  ? []
  : [params: Record<ParamName<K>, MessageValue>];

/** 文を作る。**表に無い鍵・表と違う値の名前は、型で落ちる。** */
export const message = <K extends MessageKey>(key: K, ...rest: ParamsArg<K>): Message => {
  const [params] = rest;
  return { key, params: params ?? {} };
};

const catalogs: Record<Locale, Record<MessageKey, string>> = { ja, en };

/** 読み解いた雛形。言語と鍵ごとに 1 度だけ作る (一覧は workbench が 2 秒ごとに引く)。 */
const compiled = new Map<string, IntlMessageFormat>();

const formatOf = (key: MessageKey, locale: Locale): IntlMessageFormat => {
  const cacheKey = `${locale}\t${key}`;
  let format = compiled.get(cacheKey);
  if (format === undefined) {
    format = new IntlMessageFormat(catalogs[locale][key], locale);
    compiled.set(cacheKey, format);
  }
  return format;
};

const isMessageKey = (key: string): key is MessageKey => Object.hasOwn(MESSAGE_KEYS, key);

const isParams = (params: unknown): params is MessageParams =>
  typeof params === "object" &&
  params !== null &&
  !Array.isArray(params) &&
  Object.values(params).every((value) => typeof value === "string" || typeof value === "number");

/**
 * 保存された鍵と値を、その言語の文にする。**組めなければ undefined** —— 知らない鍵 (この版より新しい
 * capture-ledger が書いた行)・値の形が違う・値が足りない。呼ぶ側は、保存された字に倒す。
 */
export const render = (key: string, params: unknown, locale: Locale): string | undefined => {
  if (!isMessageKey(key) || !isParams(params)) return undefined;
  try {
    return String(formatOf(key, locale).format(params));
  } catch {
    return undefined; // 値が足りない
  }
};

/** `message()` で作った文を、その言語の文にする。鍵も値も型が守るので、必ず組める。 */
export const say = (told: Message, locale: Locale): string => {
  const text = render(told.key, told.params, locale);
  if (text === undefined) throw new Error(`message ${told.key} could not be rendered`);
  return text;
};
