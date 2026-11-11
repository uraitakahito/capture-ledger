import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyRequest } from "fastify";
import { SignJWT, generateKeyPair } from "jose";
import {
  denyAllResolver,
  devIdentityResolver,
  jwtIdentityResolver,
  selectIdentity,
} from "../src/api/identity.js";

const request = (headers: Record<string, string>): FastifyRequest =>
  ({ headers }) as unknown as FastifyRequest;

describe("devIdentityResolver", () => {
  it("reads the subject and organizations from headers", async () => {
    await expect(
      devIdentityResolver(
        request({
          "x-capture-ledger-subject": "bob",
          "x-capture-ledger-organizations": "acme,contoso",
        }),
      ),
    ).resolves.toEqual({ subject: "bob", organizations: ["acme", "contoso"] });
  });

  it("trims and drops empty organization entries", async () => {
    await expect(
      devIdentityResolver(
        request({
          "x-capture-ledger-subject": "bob",
          "x-capture-ledger-organizations": " acme , , contoso ,",
        }),
      ),
    ).resolves.toEqual({ subject: "bob", organizations: ["acme", "contoso"] });
  });

  it("yields no organizations when the header is absent", async () => {
    await expect(
      devIdentityResolver(request({ "x-capture-ledger-subject": "bob" })),
    ).resolves.toEqual({
      subject: "bob",
      organizations: [],
    });
  });

  // subject が無いことは identity が無いということ —— route は `user:undefined` に
  // 対する Check へ落ちるのではなく、401 で答える。
  it("returns undefined without a subject", async () => {
    await expect(devIdentityResolver(request({}))).resolves.toBeUndefined();
    await expect(
      devIdentityResolver(request({ "x-capture-ledger-subject": "" })),
    ).resolves.toBeUndefined();
  });
});

describe("selectIdentity", () => {
  const original = process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
  beforeEach(() => {
    delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
    else process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = original;
  });

  // header の resolver は言われたことを何でも信じるので、設定していない配備が
  // 事故でそれを手にしてはならない。
  it("denies everyone by default", async () => {
    const identity = selectIdentity();
    expect(identity).toMatchObject({ mode: "deny", resolve: denyAllResolver });
    await expect(
      identity.resolve(request({ "x-capture-ledger-subject": "mallory" })),
    ).resolves.toBeUndefined();
  });

  it("only enables the dev resolver on an exact opt-in", () => {
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "true";
    expect(selectIdentity()).toMatchObject({ mode: "deny", resolve: denyAllResolver });
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
    expect(selectIdentity()).toMatchObject({ mode: "header", resolve: devIdentityResolver });
  });

  const withEnv = async (values: Record<string, string>, run: () => Promise<void>) => {
    const original = Object.fromEntries(
      Object.keys(values).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, values);
    try {
      await run();
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  /**
   * issuer が設定されていれば JWT の resolver を選ぶ。**開発用ヘッダより優先する** ——
   * 両方設定された環境で、弱いほう (そのポートに届く者が誰にでもなれる) へ
   * 落ちてはいけない。
   */
  it("issuer が在れば、開発用ヘッダより JWT を優先する", async () => {
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
    await withEnv(
      {
        CAPTURE_LEDGER_OIDC_ISSUER: "http://127.0.0.1:4566/us-east-1_example",
        CAPTURE_LEDGER_OIDC_CLIENT_IDS: " web , windmill ,",
      },
      async () => {
        const identity = selectIdentity();
        // どれを選んだかも返す —— 起動ログがこれを言う (`startup-notes.ts`)。
        expect(identity).toMatchObject({
          mode: "jwt",
          issuer: "http://127.0.0.1:4566/us-east-1_example",
          clientIds: ["web", "windmill"],
        });
        expect(identity.resolve).not.toBe(devIdentityResolver);
        // ヘッダだけを渡しても、もう通らない。
        await expect(
          identity.resolve(request({ "x-capture-ledger-subject": "mallory" })),
        ).resolves.toBeUndefined();
      },
    );
  });

  // 全員を 401 にして動き続けると、設定の漏れが「トークンが悪い」に見える。
  it("issuer が在って client の ID が無ければ、起動で落とす", async () => {
    await withEnv(
      {
        CAPTURE_LEDGER_OIDC_ISSUER: "http://127.0.0.1:4566/us-east-1_example",
        CAPTURE_LEDGER_OIDC_CLIENT_IDS: " , ",
      },
      () => {
        expect(() => selectIdentity()).toThrow(/CAPTURE_LEDGER_OIDC_CLIENT_IDS/);
        return Promise.resolve();
      },
    );
  });
});

/**
 * JWT を検証する resolver。
 *
 * トークンの形は Amazon Cognito (と代役の Floci) の access token に合わせる: `aud` は無く、
 * 呼び手のアプリは `client_id`、種類は `token_use`、組織は `cognito:groups`。M2M
 * (client credentials) のトークンは `sub` が `client_id` と同じで、群を持たない。
 *
 * 鍵を引数で受け取る形にしてあるので、IdP を立てずに試せる。本番と手元は
 * `createRemoteJWKSet(...)` を渡し、ここでは作ったばかりの鍵を渡す ——
 * `jose` の `jwtVerify` がどちらも受ける。Floci を相手にした往復は `idp-floci.test.ts`。
 */
const ISSUER = "http://127.0.0.1:4566/us-east-1_example";
const WEB = "web-client";
const MACHINE = "windmill-client";

// describe の中では await できないので、module の頭で作る。
const keys = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");

const token = async (
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; issuer?: string; expires?: string } = {},
): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.expires ?? "1h")
    .sign(opts.key ?? keys.privateKey);

/** 人の access token の形。 */
const human = (extra: Record<string, unknown> = {}) => ({
  sub: "alice-sub",
  username: "alice",
  token_use: "access",
  client_id: WEB,
  "cognito:groups": ["acme"],
  ...extra,
});
/** 機械 (client credentials) の access token の形。 */
const machine = (extra: Record<string, unknown> = {}) => ({
  sub: MACHINE,
  client_id: MACHINE,
  token_use: "access",
  scope: "capture-ledger/crawl",
  ...extra,
});

const bearer = (jwt: string): FastifyRequest => request({ authorization: `Bearer ${jwt}` });

describe("jwtIdentityResolver", () => {
  const resolve = jwtIdentityResolver(keys.publicKey, {
    issuer: ISSUER,
    clientIds: [WEB, MACHINE],
  });

  it("人の access token: sub と cognito:groups を Identity に写す", async () => {
    await expect(resolve(bearer(await token(human())))).resolves.toEqual({
      subject: "alice-sub",
      organizations: ["acme"],
    });
  });

  // Cognito の ID token は aud に client の ID を持つ。aud で照らす式だと通ってしまう。
  it("ID token (token_use = id) を拒む", async () => {
    await expect(
      resolve(bearer(await token(human({ token_use: "id", aud: WEB })))),
    ).resolves.toBeUndefined();
  });

  it("token_use の無いトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token(human({ token_use: undefined })))),
    ).resolves.toBeUndefined();
  });

  it("受けない client の access token を拒む", async () => {
    await expect(
      resolve(bearer(await token(human({ client_id: "someone-else" })))),
    ).resolves.toBeUndefined();
  });

  // 前の形 (aud = capture-ledger) のトークン。aud が合っていても client_id が無ければ通さない。
  it("aud だけが在り client_id の無いトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token(human({ client_id: undefined, aud: WEB })))),
    ).resolves.toBeUndefined();
  });

  // 前の開発用 issuer の綴り。組織のクレームの名前は cognito:groups だけ。
  it("organizations のクレームは読まない", async () => {
    await expect(
      resolve(bearer(await token(human({ "cognito:groups": undefined, organizations: ["acme"] })))),
    ).resolves.toEqual({ subject: "alice-sub", organizations: [] });
  });

  it("別の鍵で署名されたトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token(human(), { key: other.privateKey }))),
    ).resolves.toBeUndefined();
  });

  it("issuer が合わないトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token(human(), { issuer: "http://127.0.0.1:4566/us-east-1_other" }))),
    ).resolves.toBeUndefined();
  });

  it("期限切れのトークンを拒む", async () => {
    await expect(
      resolve(bearer(await token(human(), { expires: "-1h" }))),
    ).resolves.toBeUndefined();
  });

  // 「どこにも属さない人」は表せる必要がある —— 組織が無いことは不正ではない。
  it("群の無い人は、組織が空になる", async () => {
    await expect(
      resolve(bearer(await token(human({ "cognito:groups": undefined })))),
    ).resolves.toEqual({ subject: "alice-sub", organizations: [] });
  });

  it("sub が無いトークンを拒む", async () => {
    await expect(resolve(bearer(await token(human({ sub: undefined }))))).resolves.toBeUndefined();
  });

  it("Authorization ヘッダが無い要求を拒む", async () => {
    await expect(resolve(request({}))).resolves.toBeUndefined();
  });

  /**
   * 前置きは **`Bearer ` と同じ 7 文字**にする。`Basic ` (6 文字) だと
   * `slice(7)` がトークンの先頭を削って署名検証が落ちるので、
   * `startsWith` を外しても試験が通ってしまった —— 偶然で守られていた。
   * 同じ長さなら、防壁は `startsWith` 1 つだけになる。
   */
  it("Bearer でない Authorization ヘッダを拒む", async () => {
    await expect(
      resolve(request({ authorization: `Sneaky ${await token(human())}` })),
    ).resolves.toBeUndefined();
  });
});

/**
 * 機械 (M2M) の組織。トークンに群が無いので、capture-ledger が OpenFGA に保存した許可から引く。
 * 引く関数は server.ts が `submitterOrganizations` を渡す。ここでは呼ばれ方を見る。
 */
describe("jwtIdentityResolver の機械の組織", () => {
  const asked: string[] = [];
  const resolve = jwtIdentityResolver(keys.publicKey, {
    issuer: ISSUER,
    clientIds: [WEB, MACHINE],
    machineOrganizations: (subject) => {
      asked.push(subject);
      return Promise.resolve(["acme"]);
    },
  });

  beforeEach(() => {
    asked.length = 0;
  });

  it("M2M のトークンは、保存された許可から組織を引く", async () => {
    await expect(resolve(bearer(await token(machine())))).resolves.toEqual({
      subject: MACHINE,
      organizations: ["acme"],
    });
    expect(asked).toEqual([MACHINE]);
  });

  // 人は群の無いことも表せる必要がある。保存された許可で所属を補わない。
  it("群の無い人には引かない", async () => {
    await expect(
      resolve(bearer(await token(human({ "cognito:groups": undefined })))),
    ).resolves.toEqual({ subject: "alice-sub", organizations: [] });
    expect(asked).toEqual([]);
  });

  // sub と client_id が違えば人。client_id を偽っても、機械の扱いにはならない。
  it("sub と client_id が違うトークンは機械として扱わない", async () => {
    await expect(resolve(bearer(await token(machine({ sub: "someone" }))))).resolves.toEqual({
      subject: "someone",
      organizations: [],
    });
    expect(asked).toEqual([]);
  });

  // OpenFGA に届かないのは「名乗りが偽」ではない。401 に化けさせず、投げる (500 になる)。
  it("引く処理が落ちたら、投げる", async () => {
    const failing = jwtIdentityResolver(keys.publicKey, {
      issuer: ISSUER,
      clientIds: [MACHINE],
      machineOrganizations: () => Promise.reject(new Error("openfga unreachable")),
    });
    await expect(failing(bearer(await token(machine())))).rejects.toThrow("openfga unreachable");
  });
});
