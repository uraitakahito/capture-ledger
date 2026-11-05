/**
 * 合本を確かめる道具 (`src/replay-bundle/verify.ts`)。**合本を 1 か所ずつ壊し、壊した所の名前だけが落ちるか**を見る
 * (計画の反証の 8 つ: 1 バイト・pages・WACZ・別の合本の signedData・時刻印を剥がす・別の根・自作の時刻印の局の根・
 * r3 の中身を r5 の置き場に)。
 *
 * 署名は本物 —— 試験の CA (`test/signing-ca.ts`) が、組んだ `replay.json` の hash に署名する。置き換えの文字列では、
 * 検めを消しても通ってしまう。合本は台帳と同じ関数 (`composeReplayBundle`・`replayDigestBytes`) で組み、手元の
 * フォルダに置く (保管庫の置き場と同じ 3 つと、WACZ を `resources[].name` で)。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Fastify from "fastify";
import {
  registerReplayBundleRoutes,
  type ReplayBundleRouteDeps,
} from "../src/api/replay-bundle.js";
import {
  composeReplayBundle,
  replayDigestBytes,
  sha256Of,
  type BundleArchive,
  type BundlePage,
} from "../src/replay-bundle/format.js";
import { createReplayBundleSigner } from "../src/replay-bundle/sign.js";
import {
  dirSource,
  storeSource,
  verifyReplayBundle,
  type CheckLine,
} from "../src/replay-bundle/verify.js";
import { verifySignedData, type SignedData } from "../src/replay-bundle/verify-signed-data.js";
import { recordingDb } from "./recording-db.js";
import { createTestCa, OPENSSL, type TestCa } from "./signing-ca.js";

const CRAWL = "3f2a1b2c-0000-4000-8000-000000000001";
const BUILT_AT = new Date("2026-11-05T03:30:00.000Z");
const FINISHED_AT = new Date("2026-11-05T03:29:58.000Z");

/** WACZ の中身。道具が照らすのは sha256 だけなので、zip でなくてよい。 */
const WACZ: Record<string, Buffer> = {
  a: Buffer.from("WACZ a: the seed"),
  b: Buffer.from("WACZ b: a page at depth 1"),
  c: Buffer.from("WACZ c: reconciled after the last level"),
};
const hexOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const waczOf = (id: string): Buffer => WACZ[id] ?? Buffer.alloc(0);

const archive = (id: string, depth: number, second: number): BundleArchive => ({
  id,
  objectKey: `org/acme/2026-11/${id}_${CRAWL}.wacz`,
  waczSha256: hexOf(waczOf(id)),
  indexEmpty: false,
  capturedAt: new Date(`2026-11-05T01:00:0${String(second)}.000Z`),
  depth,
});

const pageOf = (id: string, url: string, second: number): BundlePage => ({
  archiveId: id,
  ordinal: 0,
  pageId: id,
  url,
  ts: `2026-11-05T01:00:0${String(second)}.000Z`,
  title: url,
  stage: null,
  keys: [url],
});

/** 版の合本。r3 は a・b、r5 は後から入った c も持つ (作り直しで書いた版)。どちらも終わったクロールの物。 */
const bundleOf = (rev: number) => {
  const ids = rev >= 5 ? ["a", "b", "c"] : ["a", "b"];
  const all = [archive("a", 0, 1), archive("b", 1, 2), archive("c", 1, 3)];
  const pages = [
    pageOf("a", "http://site.test/", 1),
    pageOf("b", "http://site.test/b", 2),
    pageOf("c", "http://site.test/c", 3),
  ];
  return composeReplayBundle({
    crawlId: CRAWL,
    orgId: "acme",
    rev,
    depth: null,
    builtAt: BUILT_AT,
    crawlState: "succeeded",
    stopReason: "completed",
    finishedAt: FINISHED_AT,
    archives: all.filter((one) => ids.includes(one.id)),
    pages: pages.filter((one) => ids.includes(one.archiveId)),
  });
};

/** 合本 1 版を署名して、フォルダに置く。 */
const place = async (dir: string, rev: number, ca: TestCa): Promise<void> => {
  const bundle = bundleOf(rev);
  const hash = sha256Of(bundle.replayBytes);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "replay.json"), bundle.replayBytes);
  await writeFile(join(dir, "pages.json"), bundle.pagesBytes);
  await writeFile(join(dir, "replay-digest.json"), replayDigestBytes(hash, await ca.sign(hash)));
  for (const resource of bundle.replayJson.resources) {
    await writeFile(join(dir, resource.name), waczOf(resource.name.split("_")[0] ?? ""));
  }
};

const failedChecks = (lines: readonly CheckLine[]): string[] => [
  ...new Set(lines.filter((line) => !line.ok).map((line) => line.check)),
];

const detailOf = (lines: readonly CheckLine[], check: string): string =>
  lines
    .filter((line) => line.check === check && !line.ok)
    .map((line) => line.detail)
    .join(" | ");

describe("合本を確かめる（手元の写し）", () => {
  let root: string;
  let ca: TestCa;
  /** 錨に届かない別の CA と、別の時刻印の局 (自作の局)。 */
  let other: TestCa;
  let r3: string;
  let r5: string;

  beforeAll(async () => {
    [ca, other] = await Promise.all([createTestCa(), createTestCa()]);
    root = await mkdtemp(join(tmpdir(), "cl-verify-"));
    r3 = join(root, "pristine", "r3");
    r5 = join(root, "pristine", "r5");
    await place(r3, 3, ca);
    await place(r5, 5, ca);
  });

  afterAll(async () => {
    await Promise.all([ca.dispose(), other.dispose(), rm(root, { recursive: true, force: true })]);
  });

  /** 壊す前の r5 を、試験ごとの別のフォルダに写す (壊すのは写しだけ)。 */
  let copies = 0;
  const copyOf = async (from: string): Promise<string> => {
    copies += 1;
    const dir = join(root, `copy-${String(copies)}`);
    await cp(from, dir, { recursive: true });
    return dir;
  };

  const check = (dir: string, rev = 5, anchors = ca.anchors) =>
    verifyReplayBundle(dirSource(dir), { crawlId: CRAWL, rev }, { anchors, opensslBin: OPENSSL });

  /** digest の signedData を書き換えて置き直す。 */
  const rewriteSignedData = async (
    dir: string,
    change: (signedData: SignedData) => Promise<SignedData> | SignedData,
  ): Promise<void> => {
    const path = join(dir, "replay-digest.json");
    const digest = JSON.parse(await readFile(path, "utf8")) as {
      hash: string;
      signedData: SignedData;
    };
    await writeFile(path, replayDigestBytes(digest.hash, await change(digest.signedData)));
  };

  it("壊していない合本は、置き場・digest・署名・pages・各 WACZ が全部 ok", async () => {
    const lines = await check(r5);
    expect(lines.map((line) => [line.check, line.ok])).toEqual([
      ["place", true],
      ["digest", true],
      ["signature", true],
      ["pages", true],
      ["wacz", true],
      ["wacz", true],
      ["wacz", true],
    ]);
  });

  it("replay.json を 1 バイト変えれば、digest と署名が落ちる（主張にすぎない builtAt の 1 字でも）", async () => {
    const dir = await copyOf(r5);
    const path = join(dir, "replay.json");
    const before = await readFile(path);
    const after = Buffer.from(
      before
        .toString("utf8")
        .replace('"builtAt":"2026-11-05T03:30:00', '"builtAt":"2026-11-05T03:30:01'),
    );
    expect(after.length).toBe(before.length);
    expect(after.filter((byte, i) => byte !== before[i])).toHaveLength(1);
    await writeFile(path, after);

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["digest", "signature"]);
    expect(detailOf(lines, "signature")).toContain("signedData.hash");
  });

  it("pages.json を変えれば、pages だけが落ちる", async () => {
    const dir = await copyOf(r5);
    const path = join(dir, "pages.json");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("http://site.test/b", "http://site.test/x"),
    );

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["pages"]);
  });

  it("WACZ を差し替えれば、その WACZ だけが落ちる", async () => {
    const dir = await copyOf(r5);
    await writeFile(join(dir, `b_${CRAWL}.wacz`), waczOf("c"));

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["wacz"]);
    expect(detailOf(lines, "wacz")).toContain(
      `b_${CRAWL}.wacz: sha256 is sha256:${hexOf(waczOf("c"))}`,
    );
    expect(lines.filter((line) => line.check === "wacz" && line.ok)).toHaveLength(2);
  });

  it("別の合本（r3）の正しい digest を入れれば、digest と署名が落ちる（その digest は単体なら通る）", async () => {
    const dir = await copyOf(r5);
    await cp(join(r3, "replay-digest.json"), join(dir, "replay-digest.json"));

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["digest", "signature"]);

    // 対: r3 の digest は、それ自身の hash に対しては正しい署名 (wacz-signer verify 単体の検めなら通る)
    const r3Digest = JSON.parse(await readFile(join(r3, "replay-digest.json"), "utf8")) as {
      signedData: SignedData;
    };
    const alone = await verifySignedData({
      signedData: r3Digest.signedData,
      hash: r3Digest.signedData.hash,
      anchors: ca.anchors,
      opensslBin: OPENSSL,
    });
    expect(alone.ok).toBe(true);
  });

  it("時刻印を剥がせば、署名だけが落ちる", async () => {
    const dir = await copyOf(r5);
    await rewriteSignedData(dir, (signedData) => {
      const stripped = { ...signedData };
      delete stripped.timeSignature;
      return stripped;
    });

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["signature"]);
    expect(detailOf(lines, "signature")).toContain("timestamp is missing");
  });

  it("別の根で検めれば、署名（鎖）だけが落ちる", async () => {
    const lines = await check(r5, 5, {
      signing: other.anchors.signing,
      timestamp: ca.anchors.timestamp,
    });
    expect(failedChecks(lines)).toEqual(["signature"]);
    expect(detailOf(lines, "signature")).toContain(
      "certificate chain does not reach a trusted root",
    );
  });

  it("時刻印の根に署名の CA を渡せば（根の取り違え）、署名（時刻印）だけが落ち、局の鎖が錨で検められないと言う", async () => {
    // 合本は正しい。誤っているのは渡した根 —— 「この署名を覆っていない」と言うと、合本を疑わせる
    const lines = await check(r5, 5, {
      signing: ca.anchors.signing,
      timestamp: ca.anchors.signing,
    });
    expect(failedChecks(lines)).toEqual(["signature"]);
    expect(detailOf(lines, "signature")).toContain(
      "timestamp's TSA chain does not verify against the timestamp anchor (openssl: ",
    );
    expect(detailOf(lines, "signature")).not.toContain("does not cover");
  });

  it("自作の時刻印の局の根で検めれば、署名（時刻印）だけが落ちる", async () => {
    const lines = await check(r5, 5, {
      signing: ca.anchors.signing,
      timestamp: other.anchors.timestamp,
    });
    expect(failedChecks(lines)).toEqual(["signature"]);
    expect(detailOf(lines, "signature")).toContain(
      "timestamp's TSA chain does not verify against the timestamp anchor (openssl: ",
    );
  });

  it("自作の局が押した時刻印に差し替えれば、設定の局の根では署名（時刻印）だけが落ちる", async () => {
    // 時刻印は自分の局の鎖を中に持つので、時刻印の中の証明書を根にする検めなら通る形
    const dir = await copyOf(r5);
    await rewriteSignedData(dir, async (signedData) => ({
      ...signedData,
      timeSignature: await other.timestamp(signedData.signature),
      // 局の鎖も自作の物に (辻褄の合った偽物。答えの中の鎖を根に使う検めなら通る)
      timestampCert: other.tsaChain,
    }));

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["signature"]);
    expect(detailOf(lines, "signature")).toContain(
      "timestamp's TSA chain does not verify against the timestamp anchor (openssl: ",
    );
  });

  it("r3 の中身を r5 の置き場と言えば、置き場だけが落ちる（暗号の検めは全部通る）", async () => {
    const dir = await copyOf(r3);

    const lines = await check(dir, 5);
    expect(failedChecks(lines)).toEqual(["place"]);
    expect(detailOf(lines, "place")).toBe(
      `replayBundle.rev is 3; pagesQueryUrl is /q/org/acme/crawls/${CRAWL}/r3/pages — ` +
        `but it is at crawl ${CRAWL} r5`,
    );
    // 同じ物を r3 と言えば通る (対)
    expect(failedChecks(await check(dir, 3))).toEqual([]);
  });

  it("別のクロールの置き場と言えば、置き場だけが落ちる", async () => {
    const lines = await verifyReplayBundle(
      dirSource(r5),
      { crawlId: "9e9e9e9e-0000-4000-8000-000000000009", rev: 5 },
      { anchors: ca.anchors, opensslBin: OPENSSL },
    );
    expect(failedChecks(lines)).toEqual(["place"]);
    expect(detailOf(lines, "place")).toContain("3 resource(s) name another crawl");
  });

  it("digest が無ければ（署名していない版）、digest と署名が落ちる", async () => {
    const dir = await copyOf(r5);
    await rm(join(dir, "replay-digest.json"));

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["digest", "signature"]);
    expect(detailOf(lines, "digest")).toContain("this version is not signed");
  });

  it("WACZ が無ければ、その WACZ が落ちる（フォルダの外の名前は読まない）", async () => {
    const dir = await copyOf(r5);
    await rm(join(dir, `c_${CRAWL}.wacz`));

    const lines = await check(dir);
    expect(failedChecks(lines)).toEqual(["wacz"]);
    expect(detailOf(lines, "wacz")).toContain(`c_${CRAWL}.wacz: not found`);
    expect(await dirSource(dir).hashResource({ name: "../replay.json", path: "" })).toBeUndefined();
  });

  it("replay.json が無ければ、置き場が落ちて、ほかは照らさない", async () => {
    const dir = await copyOf(r5);
    await rm(join(dir, "replay.json"));

    const lines = await check(dir);
    expect(lines).toEqual([{ check: "place", ok: false, detail: `no replay.json in ${dir}` }]);
  });
});

/**
 * 保管庫から読む。WACZ は `resources[].path` (`/wacz/<符号にした鍵>`) から鍵を戻し、同じ bucket から流して計る。
 * 組織が分かるので、`pagesQueryUrl` を丸ごと比べる。
 */
describe("合本を確かめる（保管庫）", () => {
  let ca: TestCa;

  beforeAll(async () => {
    ca = await createTestCa();
  });

  afterAll(async () => {
    await ca.dispose();
  });

  /** 鍵 → 中身の保管庫の代役。読んだ鍵を記録する。 */
  const store = (objects: Map<string, Buffer>) => {
    const read: string[] = [];
    const s3 = {
      send: (command: { input: { Bucket: string; Key: string } }) => {
        const key = command.input.Key;
        read.push(`${command.input.Bucket}/${key}`);
        const bytes = objects.get(key);
        if (bytes === undefined) {
          return Promise.reject(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));
        }
        const body = Object.assign(Readable.from([bytes]), {
          transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)),
        });
        return Promise.resolve({ Body: body });
      },
    };
    return { s3, read };
  };

  const stored = async (rev: number) => {
    const bundle = bundleOf(rev);
    const hash = sha256Of(bundle.replayBytes);
    const objects = new Map<string, Buffer>([
      [bundle.replayKey, bundle.replayBytes],
      [bundle.pagesKey, bundle.pagesBytes],
      [bundle.digestKey, replayDigestBytes(hash, await ca.sign(hash))],
    ]);
    for (const id of ["a", "b", "c"]) {
      objects.set(`org/acme/2026-11/${id}_${CRAWL}.wacz`, waczOf(id));
    }
    return { bundle, objects };
  };

  it("置き場の 3 つと、resources の鍵の WACZ を同じ bucket から読み、全部 ok", async () => {
    const { bundle, objects } = await stored(5);
    const { s3, read } = store(objects);
    const lines = await verifyReplayBundle(
      storeSource(s3 as never, "browserhive", bundle.dir),
      { crawlId: CRAWL, rev: 5, orgId: "acme" },
      { anchors: ca.anchors, opensslBin: OPENSSL },
    );
    expect(failedChecks(lines)).toEqual([]);
    expect(read).toContain(`browserhive/org/acme/2026-11/c_${CRAWL}.wacz`);
    expect(read).toContain(`browserhive/org/acme/crawls/${CRAWL}/r5/replay-digest.json`);
  });

  it("組織まで比べる（別の組織の置き場と言えば、置き場が落ちる）", async () => {
    const { bundle, objects } = await stored(5);
    const { s3 } = store(objects);
    const lines = await verifyReplayBundle(
      storeSource(s3 as never, "browserhive", bundle.dir),
      { crawlId: CRAWL, rev: 5, orgId: "other" },
      { anchors: ca.anchors, opensslBin: OPENSSL },
    );
    expect(failedChecks(lines)).toEqual(["place"]);
  });

  it("鍵は path の符号を区切りごとに戻して引く", async () => {
    const { s3, read } = store(new Map([["org/a b/x+y%.wacz", Buffer.from("x")]]));
    const source = storeSource(s3 as never, "browserhive", "org/a b/crawls/x/r1");
    expect(
      await source.hashResource({ name: "x+y%.wacz", path: "/wacz/org/a%20b/x%2By%25.wacz" }),
    ).toBe(hexOf(Buffer.from("x")));
    expect(read).toEqual(["browserhive/org/a b/x+y%.wacz"]);
    expect(await source.hashResource({ name: "x", path: "/elsewhere/x" })).toBeUndefined();
  });
});

/**
 * 台帳が書いた物を、道具がそのまま通す。合本の口 (`POST /api/crawls/:id/replay-bundle`) に終わったクロールの
 * 合本を書かせ (本物の窓口に、fetch を差し替えて試験の CA の署名を返させる)、保管庫に置いた物を手元に写して
 * 確かめる。書く側と確かめる側が、同じバイト列と同じ hash の作り方を共有していることの確かめ。
 */
describe("台帳が書いた合本を、道具が通す", () => {
  let ca: TestCa;
  let root: string;

  beforeAll(async () => {
    ca = await createTestCa();
    root = await mkdtemp(join(tmpdir(), "cl-verify-written-"));
  });

  afterAll(async () => {
    await Promise.all([ca.dispose(), rm(root, { recursive: true, force: true })]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("口が書いた replay.json・pages.json・replay-digest.json と WACZ は、全部 ok", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { hash } = JSON.parse(init.body as string) as { hash: string };
      return new Response(JSON.stringify(await ca.sign(hash)), { status: 200 });
    });
    const row = (one: BundleArchive) => ({
      ...one,
      inspectedAt: new Date("2026-11-05T02:00:00.000Z"),
    });
    const { db } = recordingDb([
      [{ id: CRAWL, orgId: "acme" }],
      [],
      [{ rev: 4, state: "succeeded", stopReason: "max_depth", finishedAt: FINISHED_AT }],
      [row(archive("a", 0, 1)), row(archive("b", 1, 2))],
      [pageOf("a", "http://site.test/", 1), pageOf("b", "http://site.test/b", 2)],
    ]);
    const puts = new Map<string, Buffer>();
    const s3 = {
      send: (command: { input: { Key: string; Body: Buffer } }) => {
        puts.set(command.input.Key, command.input.Body);
        return Promise.resolve({});
      },
    };
    const app = Fastify({ logger: false });
    registerReplayBundleRoutes(app, {
      db,
      fga: { check: () => Promise.resolve({ allowed: true }) },
      s3,
      bucket: "browserhive",
      resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
      inspectOne: () => Promise.resolve(),
      now: () => BUILT_AT,
      signer: createReplayBundleSigner({
        url: "http://wacz-signer.test:8080/sign",
        token: "dev-token",
        anchors: ca.anchors,
        timeoutMs: 2_000,
        opensslBin: OPENSSL,
      }),
    } as unknown as ReplayBundleRouteDeps);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: `/api/crawls/${CRAWL}/replay-bundle`,
      payload: { depth: 1 },
    });
    await app.close();
    expect(res.json()).toMatchObject({ rev: 4, signed: true });

    // 置いた物を手元に写す (置き場の 3 つは名前で、WACZ は resources の name で)
    const dir = join(root, "r4");
    await mkdir(dir);
    for (const [key, bytes] of puts)
      await writeFile(join(dir, key.split("/").at(-1) ?? key), bytes);
    for (const id of ["a", "b"]) await writeFile(join(dir, `${id}_${CRAWL}.wacz`), waczOf(id));
    expect([...puts.keys()].map((key) => key.split("/").at(-1))).toEqual([
      "pages.json",
      "replay-digest.json",
      "replay.json",
    ]);

    const lines = await verifyReplayBundle(
      dirSource(dir),
      { crawlId: CRAWL, rev: 4 },
      { anchors: ca.anchors, opensslBin: OPENSSL },
    );
    expect(failedChecks(lines)).toEqual([]);
    expect(lines).toHaveLength(6);
  });
});
