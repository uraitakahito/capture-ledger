import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyError } from "fastify";
import { registerSearchRoutes, type SearchRouteDeps } from "../src/api/search.js";

/**
 * 検索の口。**押さえているのは認可で絞っていること**。
 *
 * 索引は誰に見せてよいかを知らない (知るべきでもない) ので、絞りは OpenFGA を
 * 訊く 1 か所にしかない。そこが抜けても**索引は正しく答え続ける**ため、
 * 見てはいけないアーカイブが黙って結果に出る。赤くならない失敗なので、ここで押さえる。
 *
 * fga が「誰を拒むか」はここでは見ていない —— それは `fga/model.fga.yaml` の
 * assertion の仕事。ここで見るのは、**拒まれたものが結果から消えること**。
 */

const SUBJECT = { "x-capture-ledger-subject": "alice", "x-capture-ledger-organizations": "acme" };

/** 索引が返す 2 件。片方だけ見てよい、という状況を作る。 */
const MINE = "11111111-1111-1111-1111-111111111111";
const NOT_MINE = "22222222-2222-2222-2222-222222222222";

const hit = (archiveId: string, title: string, stage: string | null = null) => ({
  _source: {
    archiveId,
    stage,
    url: `http://capture-fixtures.capture-ledger:8080/${title}`,
    title,
    objectKey: `${archiveId}.wacz`,
    capturedAt: "2026-09-07T22:06:40.697Z",
    textTruncated: false,
    textWithheld: null,
  },
});

/** 索引の張りぼて。**両方を返す** —— 絞るのは索引の仕事ではない。 */
const fakeSearch = (hits: unknown[]) => ({
  search: () => Promise.resolve({ body: { hits: { hits, total: { value: hits.length } } } }),
  indices: { exists: () => Promise.resolve({ body: true }) },
});

/** 許す archive id を明示する fga。 */
const fakeFga = (allowedIds: string[]) => ({
  batchCheck: (req: { checks: { object: string }[] }) =>
    Promise.resolve({
      result: req.checks.map((check) => ({
        allowed: allowedIds.some((id) => check.object === `archive:${id}`),
        request: { object: check.object },
      })),
    }),
});

const build = async (deps: Partial<SearchRouteDeps>) => {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.send(error);
    return reply.code(500).send({ error: "internal error" });
  });
  registerSearchRoutes(app, {
    resolveIdentity: () => Promise.resolve({ subject: "alice", organizations: ["acme"] }),
    index: "capture-pages",
    ...deps,
  } as unknown as SearchRouteDeps);
  await app.ready();
  return app;
};

describe("検索の認可", () => {
  beforeEach(() => {
    process.env["CAPTURE_LEDGER_DEV_IDENTITY"] = "1";
  });
  afterEach(() => {
    delete process.env["CAPTURE_LEDGER_DEV_IDENTITY"];
  });

  it("見てよいものだけを返す", async () => {
    // **これが肝。** 索引は 2 件返し、fga は 1 件しか許さない。絞りが抜けると
    // 2 件返り、しかも索引側は何も間違えていないので、どこも赤くならない。
    const app = await build({
      search: fakeSearch([hit(MINE, "mine"), hit(NOT_MINE, "secret")]) as never,
      fga: fakeFga([MINE]) as never,
    });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x", headers: SUBJECT });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ hits: { archiveId: string }[] }>();
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]!.archiveId).toBe(MINE);
    await app.close();
  });

  it("どれも許されなければ 0 件", async () => {
    const app = await build({
      search: fakeSearch([hit(MINE, "mine"), hit(NOT_MINE, "secret")]) as never,
      fga: fakeFga([]) as never,
    });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x", headers: SUBJECT });
    expect(res.json<{ hits: unknown[] }>().hits).toHaveLength(0);
    await app.close();
  });

  it("総数は索引が数えた生の値で、返った件数と一致しないことがある", async () => {
    // docs に明記している代償。**申告どおりに振る舞うこと**を固定しておく ——
    // 黙って一致させる実装に変わると、認可の前に数えていることになる。
    const app = await build({
      search: fakeSearch([hit(MINE, "mine"), hit(NOT_MINE, "secret")]) as never,
      fga: fakeFga([MINE]) as never,
    });
    const body = (
      await app.inject({ method: "GET", url: "/api/search?q=x", headers: SUBJECT })
    ).json<{ hits: unknown[]; total: { value: number } }>();
    expect(body.hits).toHaveLength(1);
    expect(body.total.value).toBe(2);
    await app.close();
  });

  it("同じアーカイブの検索前と検索後は 2 件とも返し、fga には 1 回だけ訊く", async () => {
    // 1 件は 1 時点。認可の答えはアーカイブで決まるので、同じ id を 2 回訊かない。
    const checked: string[] = [];
    const app = await build({
      search: fakeSearch([
        hit(MINE, "before", "after-load"),
        hit(MINE, "after", "after-behaviors"),
      ]) as never,
      fga: {
        batchCheck: (req: { checks: { object: string }[] }) => {
          checked.push(...req.checks.map((check) => check.object));
          return fakeFga([MINE]).batchCheck(req);
        },
      } as never,
    });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x", headers: SUBJECT });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ hits: { stage: string | null }[] }>();
    expect(body.hits.map((one) => one.stage)).toEqual(["after-load", "after-behaviors"]);
    expect(checked).toEqual([`archive:${MINE}`]);
    await app.close();
  });

  it("ヒットが無ければ fga に訊きに行かない", async () => {
    // 0 件で batchCheck を投げると、OpenFGA は空の checks を拒む。
    const app = await build({
      search: fakeSearch([]) as never,
      fga: { batchCheck: () => Promise.reject(new Error("fga に触れた")) } as never,
    });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x", headers: SUBJECT });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ hits: unknown[] }>().hits).toHaveLength(0);
    await app.close();
  });

  it("身元が解けなければ 401", async () => {
    const app = await build({
      search: fakeSearch([hit(MINE, "mine")]) as never,
      fga: fakeFga([MINE]) as never,
      resolveIdentity: () => Promise.resolve(undefined),
    });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("q が無ければ 400", async () => {
    const app = await build({
      search: fakeSearch([]) as never,
      fga: fakeFga([]) as never,
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/search", headers: SUBJECT })).statusCode,
    ).toBe(400);
    await app.close();
  });
});
