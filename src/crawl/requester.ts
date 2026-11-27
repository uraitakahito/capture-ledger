/**
 * クロールを頼んだ者を、名乗りと見出しから組む (CAPTURE-450)。
 *
 * 行に残すのは 4 つ。主体の ID (`requested_by`) は認可の物で、今までどおり。残りの 3 つ
 * (`requested_by_name`・`requested_client`・`requested_actor`) は、capture-workbench の一覧で
 * 「誰が・どこから始めたか」を読めるようにするための写し (`044`)。
 *
 * ## 申告の名前は確かめない
 *
 * `X-Capture-ledger-Actor` は、呼び手が自分で書く名前 (AI の担当の席の名前など)。1 つの app client を
 * いくつもの席が使うので、どの席かはトークンから分からない。**誰でも好きな名前を書けるので、認可には
 * 使わない** —— 画面も「申告」と書いて出す。字の種類と長さだけを限る (行に写して画面に出すため)。
 */
import type { Identity } from "../config/identity.js";
import type { CrawlRequester } from "./prepare.js";

/** 見出しの名前 (Fastify は小文字で持つ)。 */
export const ACTOR_HEADER = "x-capture-ledger-actor";

/** 申告の名前の字。英数字で始まる、英数字と `.`・`_`・`-` の 1〜64 字 (`capture-450-swe.1` が入る)。 */
const ACTOR_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 見出しの形が違うときの 400 の本文。 */
export const INVALID_ACTOR = {
  error:
    "X-Capture-ledger-Actor must be 1 to 64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit",
};

/**
 * 見出しから申告の名前を読む。無ければ undefined、2 つ在る・形が違うなら null (400)。
 *
 * **空の見出しは「無い」と同じ** (申告なし)。道具が「席の名前が分からなければ空」で見出しをいつも送っても、
 * クロールは始まる。前後の空白は HTTP の決まりで値に入らないので、落として読む。
 */
export const actorOf = (header: string | string[] | undefined): string | undefined | null => {
  if (header === undefined) return undefined;
  if (typeof header !== "string") return null;
  const value = header.trim();
  if (value === "") return undefined;
  return ACTOR_SHAPE.test(value) ? value : null;
};

/**
 * 名乗りから、行に残す形を組む。組織は呼び出し元の 1 つ目 —— `maySubmit` はどれか 1 つで
 * 許されていれば通すので、許しをくれた組織とは限らない。
 */
export const requesterOf = (identity: Identity, actor?: string): CrawlRequester => ({
  orgId: identity.organizations[0] ?? "",
  subject: identity.subject,
  ...(identity.name !== undefined && { name: identity.name }),
  ...(identity.client !== undefined && { client: identity.client }),
  ...(actor !== undefined && { actor }),
});
