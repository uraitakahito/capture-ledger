/**
 * 成果物の受け口。**BrowserHive が保管庫を持たずに済むための口。**
 *
 * ## なぜ ledger が受けるのか
 *
 * BrowserHive が自前の保管庫へ書く構成では、あちらが**全テナントに書ける鍵**を持ち、
 * どの成果物が誰のものかを知らないので置き場所も分けられない。他人のために動く権限を
 * 持ちながら、誰のためかを判断する材料を持たない形になっている。
 *
 * ここへ押し出させると、BrowserHive が持つのは**1 回きりの口だけ**になる。置き場所を
 * 決めるのはこちらで、応答で最終的な location を返す。
 *
 * ## 鍵は crawl 単位
 *
 * **`task_id` では発行できない。** あれを採番するのは BrowserHive で、投げる時点では
 * まだ存在しない (browserhive の request-mapper.ts の randomUUID())。`capture_submissions` の行も
 * 取り込みが返ってから書かれるので、受け取る時点では引けない。
 *
 * だから crawl を単位にする。1 本のクロールに 1 つのトークンが対応し、その crawl の
 * `org_id` が置き場所を決める。crawl は仕事の単位でもあるので、寿命の考え方も揃う。
 *
 * ## トークンは権限そのもの
 *
 * 署名するのは `{crawlId, exp}` だけ。**これ以上のものを BrowserHive に渡さない**ので、
 * 他のクロールの成果物に触れる手段が無い。認可 (`mayViewArchive`) は挟まない ——
 * これは書き込みの capability であって、読み取りの認可ではない。
 *
 * ## 寿命は取り込みの上限より長く
 *
 * 取り込みは数十分に達しうる (capture-scheduler の既定は 2 時間)。短すぎると
 * **「撮れたのに置けない」**という、この系でいちばん高くつく失敗になる。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Kysely } from "kysely";

import type { Database } from "../db/database.js";
import { putObject } from "../archive/s3.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "api-sink" });

/** `crawls.id` の形。DB へ渡す前に見る。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 成果物 1 つの上限。上限を持たない口は、いずれ落とされる口になる。 */
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface SinkDeps {
  db: Kysely<Database>;
  s3: S3Client;
  bucket: string;
  secret: string;
}

/** `{crawlId, exp}` を署名する。返すのは URL に載せられる形。 */
export const issueSinkToken = (secret: string, crawlId: string, expiresAt: Date): string => {
  const exp = String(Math.floor(expiresAt.getTime() / 1000));
  const mac = createHmac("sha256", secret).update(`${crawlId}.${exp}`).digest("base64url");
  return `${exp}.${mac}`;
};

/**
 * トークンを検めて、期限内なら true。
 *
 * 比較は `timingSafeEqual`。長さが違えば先に落とす —— 例外にせず false にするのは、
 * 「壊れた形」と「合わない署名」を呼ぶ側から区別させないため。
 */
export const verifySinkToken = (
  secret: string,
  crawlId: string,
  token: string,
  now: Date = new Date(),
): boolean => {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now.getTime()) return false;

  const expected = createHmac("sha256", secret).update(`${crawlId}.${exp}`).digest("base64url");
  const given = token.slice(dot + 1);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};

/** 置き場所。**組織で分ける**ので、鍵そのものが帰属の出どころになる。 */
export const sinkObjectKey = (orgId: string, filename: string): string =>
  `org/${orgId}/${filename}`;

/**
 * そのクロールの成果物を置く場所。**クロールを作るときに 1 度だけ計算し、
 * `crawls.artifact_key_prefix` に書く。**
 *
 * 組織で分けたうえに、さらに月で分ける。月は、reconcile が bucket を一覧していた頃に
 * 「直近の月だけを歩く」ために入れたもの。いまの reconcile は bucket を歩かず、報告が
 * 書き留めた鍵だけを読むので、**月はもう何の判断にも使われていない** —— 置き場所の形を
 * 変える理由も無いので、そのまま残している。
 *
 * **UTC で切る。** ローカル時刻で切ると、実行環境の TZ で月の境目がずれる。
 */
export const crawlKeyPrefix = (orgId: string, at: Date): string =>
  `org/${orgId}/${String(at.getUTCFullYear())}-${String(at.getUTCMonth() + 1).padStart(2, "0")}/`;

/**
 * 受け口の設定。**両方揃ったときだけ生きる。**
 *
 * 鍵だけでは口を出せない (誰でも書ける受け口になる)。宛先だけでも配れない
 * (署名できないから)。片方だけ設定できる道を残すと、**「宛先は在るが誰も検めない」**
 * という最悪の中間状態が作れてしまう —— 署名の設定で同じ形を一度踏んでいる。
 */
export interface SinkConfig {
  /** BrowserHive から届く ledger の起点。例: `http://capture-ledger.capture-ledger:7070`。 */
  origin: string;
  secret: string;
}

/** 取り込みの上限より長く。capture-scheduler の既定が 2 時間なので、その外側に置く。 */
const SINK_TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * このクロールぶんの送り先を作る。
 *
 * 段ごとに呼ぶ —— クロールは長く続きうるので、後の段には新しい期限を配る。
 */
export const sinkForCrawl = (
  config: SinkConfig,
  crawlId: string,
  now: Date = new Date(),
): { url: string; token: string } => ({
  url: `${config.origin}/api/sink/${crawlId}`,
  token: issueSinkToken(config.secret, crawlId, new Date(now.getTime() + SINK_TOKEN_TTL_MS)),
});

export const registerSinkRoutes = (app: FastifyInstance, deps: SinkDeps): void => {
  const { db, s3, bucket, secret } = deps;

  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: MAX_ARTIFACT_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.put<{ Params: { crawlId: string; filename: string } }>(
    "/api/sink/:crawlId/:filename",
    async (request, reply) => {
      const { crawlId, filename } = request.params;

      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!verifySinkToken(secret, crawlId, token)) {
        // **理由を分けない。** 期限切れも偽の署名も、外から見れば同じ「通らない」。
        return reply.code(401).send({ error: "invalid or expired sink token" });
      }

      // **形を先に見る。** `crawls.id` は uuid なので、UUID でない値をそのまま
      // 問い合わせると Postgres が `invalid input syntax for type uuid` で落ち、
      // 500 になる —— 実地の疎通確認で踏んだ。呼ぶ側から見れば「そんな crawl は無い」
      // でしかないので、404 に畳む。
      if (!UUID.test(crawlId)) {
        return reply.code(404).send({ error: "no such crawl" });
      }

      const crawl = await db
        .selectFrom("crawls")
        .select(["orgId", "artifactKeyPrefix"])
        .where("id", "=", crawlId)
        .executeTakeFirst();
      if (!crawl) {
        // トークンは通ったのに行が無い。**推測しない** —— 置き場所は組織で決まる。
        return reply.code(404).send({ error: "no such crawl" });
      }

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "empty body" });
      }

      // **クロールを作ったときに決めた場所へ置く。** ここで組み直さない —— いまの時刻から
      // 導くと、月をまたいだクロールの成果物が 2 つの接頭辞に分かれる。記録の無い行だけ
      // 従来の綴りに落ちる。置いた場所は応答の `location` で返り、台帳はそれしか読まない。
      const key = (crawl.artifactKeyPrefix ?? sinkObjectKey(crawl.orgId, "")) + filename;
      await putObject(
        s3,
        bucket,
        key,
        body,
        request.headers["content-type"] ?? "application/octet-stream",
      );

      const location = `s3://${bucket}/${key}`;
      log.debug({ crawlId, filename, location, bytes: body.length }, "Stored artifact from sink");

      // **location を返すことが契約の要。** BrowserHive はこれをそのまま報告に載せるので、
      // 台帳の `parseS3Uri` は今までどおり動く。
      return reply.code(200).send({ location });
    },
  );
};
