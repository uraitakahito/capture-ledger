/**
 * クロールを始める要求の鍵 (`Idempotency-Key`。CAPTURE-180・`037`)。
 *
 * `POST /api/crawls` は鍵を必ず求める。応答が切れた後に同じ要求を送り直しても、同じ鍵なら最初に始めた
 * クロールを返し、2 本目を始めない。鍵は組織ごと (別の組織が同じ字を使っても混ざらない)。
 *
 * **覚えるのは始めた答え (202) だけ。** 走行中の 409 と中身の 400 は覚えない —— 直してから (または走行中の
 * 1 本が終わってから) 同じ鍵で送り直せば始まる。同じ鍵で違う本文が来たら 422 —— 1 つの鍵が 2 つの要求を
 * 指すと、どちらの答えを返しても嘘になる。
 *
 * 鍵の期限は 24 時間。古い行は、次に始める要求が消す。
 */
import { createHash } from "node:crypto";

import type { Kysely } from "kysely";

import type { Database } from "../db/database.js";
import { canonicalJson } from "./recipe-digest.js";

/** 鍵の期限。これより古い鍵は、無かったものとして扱う (行は消す)。 */
export const REQUEST_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** 見出しの名前 (Fastify は小文字で持つ)。 */
export const REQUEST_KEY_HEADER = "idempotency-key";

/** 鍵の字。見える ASCII (空白なし) の 1〜255 字。UUID も ULID も入る。 */
const KEY_SHAPE = /^[\x21-\x7e]{1,255}$/;

/** 鍵が無い・形が違うときの 400 の本文。 */
export const MISSING_KEY = {
  error: "Idempotency-Key header is required (1 to 255 visible ASCII characters)",
};

/** 同じ鍵で違う本文が来たときの 422 の本文。 */
export const KEY_REUSED = {
  error: "Idempotency-Key was already used with a different request",
};

/** 見出しから鍵を読む。無い・2 つ在る・形が違うなら undefined (400)。 */
export const requestKeyOf = (header: string | string[] | undefined): string | undefined =>
  typeof header === "string" && KEY_SHAPE.test(header) ? header : undefined;

/** 本文の digest。鍵の並びは揃える (送り直す側が JSON の鍵の順を変えても同じ要求)。 */
export const requestDigest = (body: unknown): string =>
  createHash("sha256").update(canonicalJson(body)).digest("hex");

/** 鍵と本文の digest。`launchCrawl` に渡すと、鍵の行を `crawls` の行と同じトランザクションで入れる。 */
export interface RequestKey {
  key: string;
  sha256: string;
}

/** 覚えている答え。 */
export interface RememberedRequest {
  requestSha256: string;
  answer: { crawlId: string };
}

/** 期限を過ぎた鍵を消す。 */
export const forgetOldRequests = async (db: Kysely<Database>, now = new Date()): Promise<void> => {
  await db
    .deleteFrom("crawlRequests")
    .where("createdAt", "<", new Date(now.getTime() - REQUEST_KEY_TTL_MS))
    .execute();
};

/** 組織と鍵で、覚えている答えを引く。 */
export const findRequest = async (
  db: Kysely<Database>,
  orgId: string,
  key: string,
): Promise<RememberedRequest | undefined> =>
  db
    .selectFrom("crawlRequests")
    .select(["requestSha256", "answer"])
    .where("orgId", "=", orgId)
    .where("key", "=", key)
    .executeTakeFirst();
