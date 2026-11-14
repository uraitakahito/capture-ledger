import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registerRoutes, type RouteDeps } from "../src/api/routes.js";

/**
 * route の入口の検査。
 *
 * **deps は意図して張りぼて。** ajv の検証は handler より前に走るので、400 になる
 * 入力ではここに一度も触れない —— 触れたら Proxy が投げて、テストがその事実を
 * 教える。おかげでこのテストは Postgres も OpenFGA も S3 も要らない。
 *
 * 逆に「検証を通った」ことは、deps に触れて失敗したことで分かる。通過を確かめる
 * のに本物の依存を用意しなくてよい、という取り引き。
 */
const TOUCHED_DEPS = "deps を使った（検証を通過した証拠）";

const explode = (): never => {
  throw new Error(TOUCHED_DEPS);
};

/**
 * `registerRoutes` は登録の時点で `deps` を分割代入するので、`get` で投げる Proxy を
 * そのまま渡すと **登録に失敗する**。投げるのは「中身を使ったとき」でなければ
 * ならない —— なので各フィールドを、触られたら投げる入れ物にしてある。
 */
const unreachableDeps = {
  db: new Proxy({}, { get: explode }),
  fga: new Proxy({}, { get: explode }),
  s3: new Proxy({}, { get: explode }),
  resolveIdentity: explode,
} as unknown as RouteDeps;

const SUBJECT = { "x-capture-ledger-subject": "alice" };
const UUID = "d272d256-e528-4581-bb4e-8d9477d78196";

describe("route の入力検証", () => {
  let app: FastifyInstance;
  const original = process.env["CAPTURE_LEDGER_DEV_IDENTITY"];

  beforeEach(async () => {
    // resolveIdentity は deps から来るので Proxy が投げる。identity より前に
    // 弾かれることを見たいので、それで構わない。
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
    app = Fastify({ logger: false });
    // 500 の中身を出さない handler も一緒に確かめる (server.ts と同じ形)。
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
      return reply.code(500).send({ error: "internal error" });
    });
    registerRoutes(app, unreachableDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (original === undefined) delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
    else process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = original;
  });

  // これが要点。以前は new Date("not-a-date") が Invalid Date のまま SQL の
  // パラメータになり、Postgres が 500 で拒んでいた。
  it("rejects a cursor that is not a timestamp", async () => {
    const res = await app.inject({ method: "GET", url: "/api/archives?before=not-a-date" });
    expect(res.statusCode).toBe(400);
  });

  // ?before=a&before=b は配列になる。new Date([...]) も Invalid Date。
  it("rejects a repeated cursor", async () => {
    const res = await app.inject({ method: "GET", url: "/api/archives?before=a&before=b" });
    expect(res.statusCode).toBe(400);
  });

  it("lets a valid cursor through to the handler", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/archives?before=2026-01-01T00:00:00Z",
      headers: SUBJECT,
    });
    // 検証を通ったので deps に触れて落ちる。それが「通った」ということ。
    expect(res.statusCode).toBe(500);
  });

  it("lets a missing cursor through to the handler", async () => {
    const res = await app.inject({ method: "GET", url: "/api/archives", headers: SUBJECT });
    expect(res.statusCode).toBe(500);
  });

  // 形式の検査は認可より前。以前は UUID でない id を FGA が結果的に弾いていたが、
  // それは認可の副作用であって入力の検査ではなかった。
  it("rejects an id that is not a uuid before authorization runs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/archives/not-a-uuid/url",
      headers: SUBJECT,
    });
    expect(res.statusCode).toBe(400);
  });

  it("lets a well-formed id through to authorization", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/archives/${UUID}/url`,
      headers: SUBJECT,
    });
    expect(res.statusCode).toBe(500);
  });

  // 節目のスクリーンショット (CAPTURE-432)。id と時点の形は、認可と DB より前に見る。
  it("uuid でない id と知らない時点の絵は、認可より前に 400", async () => {
    for (const url of [
      "/api/archives/not-a-uuid/screenshots/after-load",
      `/api/archives/${UUID}/screenshots/before-load`,
      `/api/archives/${UUID}/screenshots/thumbnail`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: SUBJECT });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("形の合う絵の要求は、認可まで通る", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/archives/${UUID}/screenshots/after-behaviors`,
      headers: SUBJECT,
    });
    expect(res.statusCode).toBe(500);
  });

  it("leaves /healthz untouched", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  // `/api/archives` の query の schema は、知らない鍵を閉じていない (`additionalProperties: false` が無い)。
  // だから知らない鍵は、拒まれも削られもせず handler へ届く —— 500 は、検証を通って deps に触れた印。
  // 「知らないキーは弾かれる」と誤解しないための杭。本番 (`src/api/server.ts`) は ajv の `removeAdditional` も
  // 切っているので、鍵を閉じた schema でも「黙って削る」は起きず、拒む。
  it("知らない query の鍵は拒まれず、handler まで届く", async () => {
    const res = await app.inject({ method: "GET", url: "/api/archives?bogus=1", headers: SUBJECT });
    expect(res.statusCode).toBe(500);
  });
});

describe("エラーの中身", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((error: FastifyError, _request, reply) => {
      if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
      return reply.code(500).send({ error: "internal error" });
    });
    app.get("/boom", () => {
      const err = new Error(
        'invalid input syntax for type timestamp with time zone: "0NaN-NaN-NaN"',
      ) as FastifyError;
      err.code = "22007";
      throw err;
    });
    registerRoutes(app, unreachableDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // Fastify の既定は 500 でも message と code をそのまま返す。Postgres の
  // エラーはそこに列の型と値を載せてくるので、client 側の誤りが内部を教える窓になる。
  it("does not leak the message or the code of a server error", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
    expect(res.body).not.toContain("timestamp");
    expect(res.body).not.toContain("22007");
  });

  // 4xx は client に向けて書かれた文言なので、隠す理由が無い。
  it("passes a client error through with its message", async () => {
    const res = await app.inject({ method: "GET", url: "/api/archives?before=not-a-date" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("date-time");
  });

  it("keeps the default 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});
