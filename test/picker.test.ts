import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  PICKER_DOCS_URL,
  registerPicker,
  replaywebHref,
  type PickerOptions,
} from "../src/api/picker.js";

/**
 * picker は route が返す 1 枚の HTML。DB も OpenFGA も要らないので、route だけを立てて見る。
 *
 * 見るのは 2 つ。「画面から外へ出る道」—— 使い方のページと replayweb-server。どちらも、壊れても画面は
 * 普通に開くので、ここで見ないと気づけない。もう 1 つは「名乗り方ごとの画面」—— 名乗り方を
 * 見ない画面は、JWT の設定の API で何を入れても 401 になり、原因を言わなかった (2026-09-20)。
 */
const LOOPBACK = { host: "127.0.0.1", port: 7070 };
const LAN = { host: "0.0.0.0", port: 7070 };
const HEADER: PickerOptions["identity"] = { mode: "header" };
const JWT: PickerOptions["identity"] = { mode: "jwt", issuer: "http://127.0.0.1:9099" };
const DENY: PickerOptions["identity"] = { mode: "deny" };

const open = async (options: Partial<PickerOptions> = {}): Promise<string> => {
  const app = Fastify();
  registerPicker(app, {
    replaywebServerOrigin: "http://127.0.0.1:8899",
    identity: HEADER,
    listen: LOOPBACK,
    ...options,
  });
  const response = await app.inject({ method: "GET", url: "/" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("text/html");
  await app.close();
  return response.body;
};

describe("picker の画面", () => {
  // 迷う人が居るのは docs の上ではなく、この画面の上。ここから docs へ行く道が要る。
  it("使い方のページへのリンクを、新しいタブで開く形で持つ", async () => {
    const body = await open();
    expect(body).toContain(
      `<a href="${PICKER_DOCS_URL}" target="_blank" rel="noopener">使い方</a>`,
    );
  });

  // 行のクリックで開く先は、渡された replayweb-server の場所から組む。既定値を焼き込んでいたら、
  // REPLAYWEB_SERVER_ORIGIN を変えても古い場所を開き続ける。
  it("渡された replayweb-server の場所を、行のリンクを組む script に埋め込む", async () => {
    const body = await open({ replaywebServerOrigin: "http://replayweb-server.test:9000" });
    expect(body).toContain('const REPLAYWEB_SERVER_ORIGIN = "http://replayweb-server.test:9000";');
    expect(body).not.toContain("127.0.0.1:8899");
    // 行のリンクは、下の replaywebHref と同じ関数で組む。
    expect(body).toContain("const replaywebHref = ");
    expect(body).toContain("const href = replaywebHref(REPLAYWEB_SERVER_ORIGIN, a)");
  });
});

describe("行のリンク", () => {
  const ORIGIN = "http://127.0.0.1:8899";
  const KEY = "task-a_corr-b.wacz";

  it("取り込んだ URL を撮った時刻で直に開く —— ts は UTC の 14 桁", () => {
    expect(
      replaywebHref(ORIGIN, {
        objectKey: KEY,
        sourceUrl: "https://www.apple.com/jp/",
        capturedAt: "2026-11-04T10:39:16.120Z",
      }),
    ).toBe(
      `${ORIGIN}/?source=%2Fwacz%2F${KEY}#view=replay&url=https%3A%2F%2Fwww.apple.com%2Fjp%2F&ts=20261104103916`,
    );
  });

  it("url は台帳の sourceUrl のまま —— 末尾の / が無くても足さない（replay が文書に当てる）", () => {
    const href = replaywebHref(ORIGIN, {
      objectKey: KEY,
      sourceUrl: "http://site.test",
      capturedAt: "2026-11-04T10:39:16Z",
    });
    expect(new URLSearchParams(href.slice(href.indexOf("#") + 1)).get("url")).toBe(
      "http://site.test",
    );
  });

  it("鍵は区切りごとに符号にし、その path を source の値としてもう 1 度符号にする。URL の & や # は url の所で", () => {
    const href = replaywebHref(ORIGIN, {
      objectKey: "a/b?c.wacz",
      sourceUrl: "https://site.test/search?q=a&b=1",
      capturedAt: "2026-11-04T10:39:16Z",
    });
    expect(href.slice(0, href.indexOf("#"))).toBe(`${ORIGIN}/?source=%2Fwacz%2Fa%2Fb%253Fc.wacz`);
    expect(new URLSearchParams(href.slice(href.indexOf("#") + 1)).get("url")).toBe(
      "https://site.test/search?q=a&b=1",
    );
  });

  it.each([
    ["時刻が無い", { sourceUrl: "https://site.test/" }],
    ["時刻が読めない", { sourceUrl: "https://site.test/", capturedAt: "" }],
    ["URL が無い", { capturedAt: "2026-11-04T10:39:16Z" }],
    ["URL が空", { sourceUrl: "", capturedAt: "2026-11-04T10:39:16Z" }],
  ])("%s なら、一覧を開く形のまま", (_, rest) => {
    expect(replaywebHref(ORIGIN, { objectKey: KEY, ...rest })).toBe(
      `${ORIGIN}/?source=%2Fwacz%2F${KEY}`,
    );
  });

  it("% を含む鍵も、replay の画面が source を 1 度・server が区切りごとに 1 度解くと元の鍵に戻る", () => {
    // BrowserHive はラベルを百分率の符号で鍵に入れる（`hello world` → `hello%20world`）
    const objectKey = "org/acme/2026-11/hello%20world_%E3%81%82.wacz";
    const href = replaywebHref(ORIGIN, { objectKey });
    // replay の画面（wabac）は ?source= を URLSearchParams で 1 度解き、その path を取りに行く
    const source = new URL(href).searchParams.get("source") ?? "";
    expect(source.startsWith("/wacz/")).toBe(true);
    // replayweb-server（v0.3.0）は /wacz/ の後ろを区切りごとに 1 度だけ解く
    const served = source.slice("/wacz/".length).split("/").map(decodeURIComponent).join("/");
    expect(served).toBe(objectKey);
  });
});

describe("名乗り方ごとの picker", () => {
  it("開発用ヘッダの設定では名乗りの 2 欄を出し、401 は「subject が空」と言う", async () => {
    const body = await open({ identity: HEADER });
    expect(body).toContain('id="subject"');
    expect(body).toContain('id="orgs"');
    expect(body).toContain('const MODE = "names";');
    expect(body).toContain(
      'const UNAUTHORIZED = "401 — subject が空（この API は開発用ヘッダで名乗る設定）";',
    );
    // 以前の文。JWT の設定でも同じ文を出し、原因を取り違えさせた。
    expect(body).not.toContain("DEV_IDENTITY=1 になっていない");
  });

  it("開発用ヘッダの設定で 0.0.0.0 で待つなら、誰にでもなれることを画面の上で言う", async () => {
    const body = await open({ identity: HEADER, listen: LAN });
    expect(body).toContain(
      '<p class="notice warn" id="notice">この API は 0.0.0.0:7070 で待ちながら',
    );
    expect(body).toContain("同じネットワークの誰もが、誰にでもなれる");
  });

  it("開発用ヘッダの設定でも 127.0.0.1 で待つなら、その注意は出さない", async () => {
    const body = await open({ identity: HEADER, listen: LOOPBACK });
    expect(body).not.toContain('id="notice"');
  });

  it("JWT の設定では名乗りの 2 欄を出さず、JWT で名乗る設定だと issuer ごと言う", async () => {
    const body = await open({ identity: JWT, listen: LAN });
    expect(body).not.toContain('id="subject"');
    expect(body).not.toContain('id="orgs"');
    expect(body).toContain("この API は JWT で名乗る設定（http://127.0.0.1:9099）");
    // JWT の設定で 0.0.0.0 は正しい形 (クロールの 4 行)。ヘッダの注意は出さない。
    expect(body).not.toContain("誰にでもなれる");
  });

  it("JWT の設定ではトークンの欄と、その取り方のコマンドを出し、トークンで名乗る", async () => {
    const body = await open({ identity: JWT, listen: LAN });
    expect(body).toContain('id="token"');
    expect(body).toContain(
      'pnpm run --silent oidc:token --subject "$(whoami)" --org acme | pbcopy',
    );
    // script が送るのは Bearer だけ。名乗りの 2 欄は無いので、ヘッダの経路に落ちてはいけない。
    expect(body).toContain('const MODE = "token";');
  });

  it("JWT の設定の 401 は「このトークンは通らない」と言い、「subject が空」とは言わない", async () => {
    const body = await open({ identity: JWT, listen: LAN });
    expect(body).toContain(
      'const UNAUTHORIZED = "401 — このトークンは通らない（期限切れ・issuer を起こし直した後・別の issuer のもの）。取り直して貼る";',
    );
    expect(body).not.toContain("subject が空");
  });

  it("名乗りの設定が無ければ全員 401 だと言い、欄も「読み込む」も出さない", async () => {
    const body = await open({ identity: DENY });
    expect(body).toContain("誰の一覧も出せない（全員 401）");
    expect(body).not.toContain('id="subject"');
    expect(body).not.toContain('id="reload"');
    expect(body).not.toContain("<script>");
  });
});
