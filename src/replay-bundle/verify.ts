/**
 * 合本 1 版が、その署名と合っているかを確かめる (CAPTURE-61)。道具 (`replay-bundle/verify-cli.ts`) の本体で、
 * 保管庫からでも手元の写しからでも同じ物を照らす (読む部品だけを `BundleSource` で差し替える)。
 *
 * ## 照らす物
 *
 * | 名前        | 何を                                                                                      |
 * | ----------- | ----------------------------------------------------------------------------------------- |
 * | `place`     | `replay.json` の `replayBundle.crawlId`・`rev`・`pagesQueryUrl`・`resources[].crawlId` が、 |
 * |             | 名指した置き場 (クロールと版) と同じ。r3 の中身を r5 の置き場に置けば、ここだけが落ちる       |
 * | `digest`    | `replay-digest.json` の `path` が `replay.json` で、sha256(replay.json) = `hash` =          |
 * |             | `signedData.hash`。別の合本の正しい digest を置けば、ここが落ちる                           |
 * | `signature` | 署名の 4 段 (`replay-bundle/verify-signed-data.ts`。置く前の検めと同じ物)。hash は自分で計った物 |
 * | `pages`     | sha256(pages.json) = `replayBundle.pagesHash`                                              |
 * | `wacz`      | 各 WACZ を流して計った sha256 = `resources[].hash` (1 本に 1 行)                           |
 *
 * どれか 1 つが落ちても、残りも照らして全部を言う (直す人には、どこが合わないかの全体が要る)。全部 ok のときだけ
 * 「合っている」。
 *
 * ## 何を証さないか
 *
 * 署名が覆うのは `replay.json` のバイト列で、その中に WACZ ごとの sha256・`pages.json` の sha256・クロールの状態が
 * ある。**`builtAt` は capture-ledger の時計の主張にすぎない** —— 時刻として確かなのは時刻印の genTime だけ。WACZ の中の
 * 署名 (各 WACZ の `datapackage-digest.json`) は、ここでは照らさない (WACZ のバイト列が合本の言う物と同じことだけを
 * 見る)。記録が 0 で外した WACZ (`skippedResources`) は名前と sha256 だけで在り処を持たないので、照らさない。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { getObjectBytes, sha256OfObject } from "../archive/s3.js";
import { keyPath, REPLAY_DIGEST_NAME, replayBundleDir, sha256Of, waczKeyOf } from "./format.js";
import {
  verifySignedData,
  type SignedData,
  type TrustAnchors,
  type VerificationChecks,
} from "./verify-signed-data.js";

/** 合本の置き場を読む部品。保管庫と手元の写しで差し替える。 */
export interface BundleSource {
  /** 報告で置き場を言う文字列。 */
  where: string;
  /** 置き場の中の 1 つ (`replay.json` など) のバイト列。無ければ `undefined`。 */
  read: (name: string) => Promise<Buffer | undefined>;
  /** `resources` の 1 本を流して sha256 (16 進) を計る。無ければ `undefined`。 */
  hashResource: (resource: { name: string; path: string }) => Promise<string | undefined>;
}

/** 名指した置き場。`orgId` は保管庫から読むときだけ分かる (在れば `pagesQueryUrl` を丸ごと比べる)。 */
export interface BundleClaim {
  crawlId: string;
  rev: number;
  orgId?: string;
}

export type CheckName = "place" | "digest" | "signature" | "pages" | "wacz";

export interface CheckLine {
  check: CheckName;
  ok: boolean;
  /** 何を見て、どうだったか (1 行)。 */
  detail: string;
}

export interface VerifyBundleOptions {
  anchors: TrustAnchors;
  opensslBin?: string;
  timeoutMs?: number;
}

/** 手元の写し: `replay.json`・`pages.json`・`replay-digest.json` と、`resources[].name` の WACZ が並ぶフォルダ。 */
export const dirSource = (dir: string): BundleSource => {
  const absent = (err: unknown): boolean =>
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
  return {
    where: dir,
    read: async (name) => {
      try {
        return await readFile(join(dir, name));
      } catch (err) {
        if (absent(err)) return undefined;
        throw err;
      }
    },
    hashResource: async ({ name }) => {
      // 名前は replay.json が言う物。フォルダの外を指させない
      if (name === "" || name === "." || name === ".." || basename(name) !== name) return undefined;
      const hash = createHash("sha256");
      try {
        for await (const chunk of createReadStream(join(dir, name))) hash.update(chunk as Buffer);
      } catch (err) {
        if (absent(err)) return undefined;
        throw err;
      }
      return hash.digest("hex");
    },
  };
};

/** 保管庫の置き場 (`org/<orgId>/crawls/<crawlId>/r<rev>`)。WACZ は `resources[].path` の鍵を同じ bucket から読む。 */
export const storeSource = (s3: S3Client, bucket: string, dir: string): BundleSource => ({
  where: `${bucket}/${dir}`,
  read: (name) => getObjectBytes(s3, bucket, `${dir}/${name}`),
  hashResource: async ({ path }) => {
    const key = waczKeyOf(path);
    return key === undefined ? undefined : sha256OfObject(s3, bucket, key);
  },
});

const parseJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ReadResource {
  name: string;
  path: string;
  hash: string;
  crawlId: string;
}

interface ReadReplay {
  pagesQueryUrl: string;
  resources: ReadResource[];
  crawlId: string;
  rev: number;
  pagesHash: string | undefined;
}

/** `replay.json` から、照らすのに要る欄を読む。形が違えば理由。 */
const readReplay = (value: unknown): ReadReplay | string => {
  if (!isRecord(value)) return "replay.json is not a JSON object";
  const bundle = value["replayBundle"];
  if (!isRecord(bundle))
    return "replay.json has no replayBundle (not a replay bundle of the ledger)";
  const resources = value["resources"];
  if (!Array.isArray(resources)) return "replay.json has no resources";
  const read: ReadResource[] = [];
  for (const resource of resources) {
    if (
      !isRecord(resource) ||
      typeof resource["name"] !== "string" ||
      typeof resource["path"] !== "string" ||
      typeof resource["hash"] !== "string" ||
      typeof resource["crawlId"] !== "string"
    ) {
      return "a resource of replay.json lacks name, path, hash or crawlId";
    }
    read.push({
      name: resource["name"],
      path: resource["path"],
      hash: resource["hash"],
      crawlId: resource["crawlId"],
    });
  }
  const pagesQueryUrl = value["pagesQueryUrl"];
  const crawlId = bundle["crawlId"];
  const rev = bundle["rev"];
  const pagesHash = bundle["pagesHash"];
  if (typeof pagesQueryUrl !== "string") return "replay.json has no pagesQueryUrl";
  if (typeof crawlId !== "string" || typeof rev !== "number") {
    return "replayBundle of replay.json has no crawlId or rev";
  }
  return {
    pagesQueryUrl,
    resources: read,
    crawlId,
    rev,
    pagesHash: typeof pagesHash === "string" ? pagesHash : undefined,
  };
};

/** wacz-auth の `signedData` の形か (検めに使う欄が文字列で在るか)。 */
const isSignedData = (value: unknown): value is SignedData =>
  isRecord(value) &&
  typeof value["hash"] === "string" &&
  typeof value["signature"] === "string" &&
  typeof value["domain"] === "string" &&
  typeof value["domainCert"] === "string";

const stages = (checks: VerificationChecks): string =>
  `signature ${checks.signature} · chain ${checks.chain} · domain ${checks.domain} · ` +
  `timestamp ${checks.timestamp}`;

/** 名指した置き場と、replay.json が言う置き場が同じか。 */
const placeCheck = (replay: ReadReplay, claim: BundleClaim): CheckLine => {
  const problems: string[] = [];
  if (replay.crawlId !== claim.crawlId) {
    problems.push(`replayBundle.crawlId is ${replay.crawlId}`);
  }
  if (replay.rev !== claim.rev) problems.push(`replayBundle.rev is ${String(replay.rev)}`);
  // 組織が分かれば丸ごと、分からなければ (手元の写し) クロールと版の所だけ
  const query =
    claim.orgId === undefined
      ? replay.pagesQueryUrl.endsWith(
          `/crawls/${encodeURIComponent(claim.crawlId)}/r${String(claim.rev)}/pages`,
        )
      : replay.pagesQueryUrl ===
        `/q/${keyPath(replayBundleDir(claim.orgId, claim.crawlId, claim.rev))}/pages`;
  if (!query) problems.push(`pagesQueryUrl is ${replay.pagesQueryUrl}`);
  const strangers = replay.resources.filter((resource) => resource.crawlId !== claim.crawlId);
  if (strangers.length > 0) {
    problems.push(`${String(strangers.length)} resource(s) name another crawl`);
  }
  const here = `crawl ${claim.crawlId} r${String(claim.rev)}`;
  return problems.length === 0
    ? { check: "place", ok: true, detail: here }
    : { check: "place", ok: false, detail: `${problems.join("; ")} — but it is at ${here}` };
};

export const verifyReplayBundle = async (
  source: BundleSource,
  claim: BundleClaim,
  options: VerifyBundleOptions,
): Promise<CheckLine[]> => {
  const lines: CheckLine[] = [];
  const fail = (check: CheckName, detail: string): void => {
    lines.push({ check, ok: false, detail });
  };
  const pass = (check: CheckName, detail: string): void => {
    lines.push({ check, ok: true, detail });
  };

  // ── replay.json (無ければ、照らす物が無い) ─────────────────────────────────
  const replayBytes = await source.read("replay.json");
  if (replayBytes === undefined) {
    fail("place", `no replay.json in ${source.where}`);
    return lines;
  }
  const replay = readReplay(parseJson(replayBytes));
  if (typeof replay === "string") {
    fail("place", replay);
    return lines;
  }
  lines.push(placeCheck(replay, claim));

  // ── digest: sha256(replay.json) = digest.hash = signedData.hash ─────────────────
  const hash = sha256Of(replayBytes);
  const digestBytes = await source.read(REPLAY_DIGEST_NAME);
  const digest = digestBytes === undefined ? undefined : parseJson(digestBytes);
  const signedData = isRecord(digest) ? digest["signedData"] : undefined;
  if (digestBytes === undefined) {
    fail("digest", `no ${REPLAY_DIGEST_NAME} in ${source.where} (this version is not signed)`);
  } else if (!isRecord(digest)) {
    fail("digest", `${REPLAY_DIGEST_NAME} is not a JSON object`);
  } else {
    const problems: string[] = [];
    if (digest["path"] !== "replay.json") {
      problems.push(`path is ${JSON.stringify(digest["path"])}, not "replay.json"`);
    }
    if (digest["hash"] !== hash) problems.push(`hash is ${String(digest["hash"])}`);
    const signedHash = isRecord(signedData) ? signedData["hash"] : undefined;
    if (signedHash !== hash) problems.push(`signedData.hash is ${String(signedHash)}`);
    if (problems.length === 0) pass("digest", `${hash} (replay.json = hash = signedData.hash)`);
    else fail("digest", `sha256(replay.json) is ${hash}, but ${problems.join("; ")}`);
  }

  // ── signature: 4 段。hash は自分で計った物 ───────────────────────────────────
  if (!isSignedData(signedData)) {
    fail("signature", "no signedData to check");
  } else {
    const verified = await verifySignedData({
      signedData,
      hash,
      anchors: options.anchors,
      ...(options.opensslBin === undefined ? {} : { opensslBin: options.opensslBin }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (verified.ok) pass("signature", `${stages(verified.checks)} (${signedData.domain})`);
    else fail("signature", `${verified.reason ?? "not verified"} (${stages(verified.checks)})`);
  }

  // ── pages: sha256(pages.json) = pagesHash ─────────────────────────────────────
  const pagesBytes = await source.read("pages.json");
  if (replay.pagesHash === undefined) {
    fail("pages", "replay.json has no replayBundle.pagesHash (written before CAPTURE-61)");
  } else if (pagesBytes === undefined) {
    fail("pages", `no pages.json in ${source.where}`);
  } else {
    const got = sha256Of(pagesBytes);
    if (got === replay.pagesHash) pass("pages", got);
    else fail("pages", `sha256(pages.json) is ${got}, but replay.json says ${replay.pagesHash}`);
  }

  // ── wacz: 1 本ずつ流して計る ────────────────────────────────────────────────
  for (const resource of replay.resources) {
    let got: string | undefined;
    try {
      const hex = await source.hashResource(resource);
      got = hex === undefined ? undefined : `sha256:${hex}`;
    } catch (err) {
      fail(
        "wacz",
        `${resource.name}: could not be read (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    if (got === undefined) fail("wacz", `${resource.name}: not found (${resource.path})`);
    else if (got !== resource.hash) {
      fail("wacz", `${resource.name}: sha256 is ${got}, but replay.json says ${resource.hash}`);
    } else pass("wacz", `${resource.name} ${got}`);
  }
  return lines;
};
