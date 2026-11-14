/**
 * capture-ledger のための S3 アクセス: 結果 manifest を読むこと、アーカイブ本体を取ること、
 * 受け取り先が受けた成果物と、クロールの合本 (`replay-bundle/write.ts`) を置くこと。
 *
 * **bucket は列挙しない。** 読むのは、書いた本人が答えた鍵 (段の報告が運び、
 * `capture_submissions` に書き留めたものと、その `.result.json` が言う成果物) だけ。以前は一覧を URL 符号化から戻して
 * 鍵を作り直していたが、戻し方が実装に依存し、空白を含む鍵を別の名前にした。
 *
 * 署名付き URL は `api/presign.ts` に在る —— この client は共有するが、関心は別
 * (あちらはオブジェクトを一度も読まず、署名するだけ)。
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StorageConfig } from "../config/env.js";

export const createS3Client = (config: StorageConfig): S3Client =>
  new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });

/**
 * JSON のオブジェクトを取って解析する。無ければ `undefined`。
 *
 * オブジェクトが無いのは想定内の結果 (manifest の代替経路は、そもそも書かれて
 * いないかもしれないものを求める) なので、エラーではない。それ以外 —— 資格情報、
 * ネットワーク、壊れた JSON —— は今までどおり throw する。
 */
export const getJsonObject = async (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<unknown> => {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await result.Body?.transformToString();
    if (body === undefined) return undefined;
    // 解析は呼ぶ側の仕事 (readManifest など)。ここで型を名乗らせない ——
    // 名乗れるようにすると、いつか誰かが検査せずに名乗る。
    return JSON.parse(body);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

/**
 * オブジェクトを丸ごとバイト列で取る。無ければ `undefined`。
 *
 * `getJsonObject` と分けてあるのは、こちらの相手が **JSON ではない**から ——
 * WACZ (zip) を開くのに使う。文字列に変換すると壊れる。
 *
 * **丸ごと読む。** WACZ の大半は WARC なので、`pages.jsonl` 1 本のために全部を
 * 落とすことになる。それを承知でこうしている: 索引 (`search/index-archive.ts`) と検め
 * (`replay-bundle/inspect.ts`) は 1 本につき 1 回しか読まず、前回からの変化の周回 (`changes/worker.ts`) が
 * 読み直すのも文字の違った取り込みの WACZ だけ (同じ 1 本を、今の回として読んだ次の周回で前の回として
 * もう 1 度読むことがある)。大きさは 1 本で数 KB〜数十 MB (2026-11-15 の dev の 966 本で 6 KB〜49.5 MB・
 * 中央 12 KB。実サイトのトップは数 MB〜数十 MB) で、1 本ずつなら丸ごと持てる。
 *
 * 同じ 1 本を何度も読む所は、丸ごと読まない: 節目のスクリーンショット (`archive/stage-screenshots.ts`) は、
 * 検める時に位置だけを覚え、読む時は `getObjectRange` で 1 本の Range にする。zip の中を全部 Range で読む形が
 * 要るなら、wacz-validator の packages/core/src/wacz/s3-range-reader.ts が `HeadObject` で大きさを
 * 訊いてから yauzl に Range で食わせる形を持っている。
 */
export const getObjectBytes = async (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer | undefined> => {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    return bytes === undefined ? undefined : Buffer.from(bytes);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

/**
 * オブジェクトの `start` バイト目から `length` バイトを、Range の読み 1 本で取る。無ければ `undefined`。
 *
 * **返った長さを確かめる** —— Range を聞かない保管庫は 200 で全文を返す (WACZ なら数十 MB)。本文を読む前に
 * `ContentLength` を見て、読んだ後も長さを見る。範囲が終わりを越えた時の答え (416) は、無いのでなく読めない物として投げる。
 */
export const getObjectRange = async (
  s3: S3Client,
  bucket: string,
  key: string,
  start: number,
  length: number,
): Promise<Buffer | undefined> => {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0) {
    throw new Error(
      `a range must start at 0 or later and be at least 1 byte (${String(start)}, ${String(length)})`,
    );
  }
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${String(start)}-${String(start + length - 1)}`,
      }),
    );
    if (result.ContentLength !== undefined && result.ContentLength !== length) {
      throw new Error(
        `the store answered ${String(result.ContentLength)} bytes of ${key}, not the ${String(length)} asked`,
      );
    }
    const bytes = await result.Body?.transformToByteArray();
    if (bytes === undefined) return undefined;
    if (bytes.length !== length) {
      throw new Error(
        `the store sent ${String(bytes.length)} bytes of ${key}, not the ${String(length)} asked`,
      );
    }
    return Buffer.from(bytes);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

/**
 * オブジェクトの大きさ (バイト) を、本文を読まずに訊く (`HeadObject`)。無ければ `undefined`。
 *
 * 丸ごと読む前に上限と比べるため。失敗の時点の絵 (`api/trace.ts`) が使う —— 読む鍵は `.result.json` が言った物で、
 * そこに何が置いてあるかは読むまで分からない。大きさを言わない答えは、無いのではなく読めない物として投げる。
 */
export const objectSize = async (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<number | undefined> => {
  try {
    const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (result.ContentLength === undefined) {
      throw new Error(`the store answered ${key} without a length`);
    }
    return result.ContentLength;
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

/**
 * オブジェクトを**流して** sha256 を計る (16 進の小文字)。無ければ `undefined`。
 *
 * 合本を確かめる道具 (`replay-bundle/verify.ts`) が、合本の WACZ を 1 本ずつ計るのに使う。`getObjectBytes` と
 * 違い丸ごと持たない —— クロールの WACZ を全部読むので、1 本ずつでも数百 MB になりうる。
 */
export const sha256OfObject = async (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<string | undefined> => {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = result.Body;
    if (body === undefined) return undefined;
    // Node の SDK は本文を Readable で返す (ブラウザの形は、この process には来ない)
    if (!(body instanceof Readable)) throw new Error(`the store answered ${key} without a stream`);
    const hash = createHash("sha256");
    for await (const chunk of body) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

const isNotFound = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const err = cause as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404;
};

/**
 * オブジェクトを 1 つ書く。
 *
 * **冪等であること。** 同じ鍵に 2 度書けば上書きされる —— BrowserHive が再送しうるので、
 * 連番を振ると再送のたびに object が増える。鍵は呼ぶ側が決める。
 *
 * ledger が S3 に**書く**のはこの関数だけで、呼ぶのは 2 か所: 受け取り先 (`api/sink.ts`。BrowserHive の成果物を
 * 受け取る構成のとき) と合本 (`replay-bundle/write.ts`。版ごとの置き場に 1 度だけ書き、書き換えない。署名した版は
 * `replay-digest.json` も)。
 * 他はすべて読み取り。
 */
export const putObject = async (
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
};
