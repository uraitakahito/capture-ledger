/**
 * 頼みの言語を決める (`Accept-Language`)。capture-ledger が自分で訳す文 (`messages.ts`) を、どの言語で返すか。
 *
 * ## 決め方
 *
 * 値を重み (`q`) の大きい順に見て、辞書を持つ言語 (`LOCALES`) に当たる最初の物を選ぶ。`en-US` は `en`、
 * `ja-JP` は `ja` と読む (頭の subtag だけを見る)。`q=0` は「受けない」の意味なので外す。
 *
 * **見出しが無い・どれにも当たらない・読めないときは、既定の英語** (`DEFAULT_LOCALE`)。断らない ——
 * 言語は答えの中身を変えない添え物で、知らない言語を頼んだ呼び手にも、答えは返す。
 * `*` (何でもよい) も既定に倒す: Node の `fetch` は、見出しを付けない頼みに `*` を自分で付ける。
 *
 * ## なぜ既定が英語か
 *
 * 言語を付けない呼び手 (CLI・AI の担当・ほかの道具) には英語で返す、と決めた (t-evv8)。日本語で受ける
 * 呼び手は `Accept-Language: ja` を付ける (capture-workbench は画面の言語を付け、CLI は `--lang ja`)。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { LOCALES, type Locale } from "./messages.js";

/** 言語の付かない頼みに返す言語。 */
export const DEFAULT_LOCALE: Locale = "en";

const isLocale = (tag: string): tag is Locale => (LOCALES as readonly string[]).includes(tag);

/** `ja;q=0.8` の 1 つを、頭の subtag と重みに。重みが読めなければ 0 (選ばない)。 */
const rangeOf = (part: string): { tag: string; q: number } => {
  const [range = "", ...params] = part.split(";").map((piece) => piece.trim());
  const weight = params.find((param) => param.toLowerCase().startsWith("q="));
  const q = weight === undefined ? 1 : Number(weight.slice(2));
  return {
    tag: (range.toLowerCase().split("-")[0] ?? "").trim(),
    q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0,
  };
};

/** `Accept-Language` の値から、返す言語を決める。 */
export const localeOf = (header: string | undefined): Locale => {
  if (header === undefined) return DEFAULT_LOCALE;
  const wanted = header
    .split(",")
    .map(rangeOf)
    .filter((range): range is { tag: Locale; q: number } => range.q > 0 && isLocale(range.tag))
    // 重みの大きい順。同じ重みなら、書いた順 (sort は安定)
    .sort((a, b) => b.q - a.q);
  return wanted[0]?.tag ?? DEFAULT_LOCALE;
};

/**
 * 頼みの言語を決め、答えにその言語を書く (`Content-Language`) —— 言語で字の変わる答えを返す handler が呼ぶ。
 * `Vary: Accept-Language` も付ける (同じ URL の答えが、頼みの言語で変わるため)。
 */
export const speak = (request: FastifyRequest, reply: FastifyReply): Locale => {
  const locale = localeOf(request.headers["accept-language"]);
  void reply.header("content-language", locale).header("vary", "Accept-Language");
  return locale;
};
