/**
 * capture-ledger の 1 行を、そのオブジェクトに対する短命で GET 専用の URL に変える。
 *
 * 署名は純粋な計算で、S3 にリクエストは飛ばない —— だからオブジェクトが存在するか
 * どうかは分からない。それは意図的: 何が存在するかの記録は capture-ledger のほうであり、
 * そこに書かれるのは成功した取り込みだけだから。
 *
 * 有効期限が短いのは、署名付き URL を取り消せないため。一度発行すると、裏の権限が
 * どうなろうと寿命の間ずっと有効なので、この窓は「アクセスを取り消してから実際に
 * アクセスが終わるまで」の、縮められない隙間そのものになる。
 */
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const DEFAULT_EXPIRES_IN_SECONDS = 300;

export interface SignedArchiveUrl {
  url: string;
  expiresIn: number;
}

export const presignArchive = async (
  s3: S3Client,
  location: { bucket: string; objectKey: string },
  expiresIn: number = DEFAULT_EXPIRES_IN_SECONDS,
): Promise<SignedArchiveUrl> => {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: location.bucket, Key: location.objectKey }),
    { expiresIn },
  );
  return { url, expiresIn };
};
