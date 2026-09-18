import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { PICKER_DOCS_URL, registerPicker } from "../src/api/picker.js";

/**
 * picker は route が返す 1 枚の HTML。DB も OpenFGA も要らないので、route だけを立てて見る。
 * 見るのは「画面から外へ出る道」の 2 本 —— 使い方のページと replay。どちらも、壊れても
 * 画面は普通に開くので、ここで見ないと気づけない。
 */
describe("picker の画面", () => {
  const open = async (replayOrigin: string): Promise<string> => {
    const app = Fastify();
    registerPicker(app, replayOrigin);
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    await app.close();
    return response.body;
  };

  // 迷う人が居るのは docs の上ではなく、この画面の上。ここから docs へ行く道が要る。
  it("使い方のページへのリンクを、新しいタブで開く形で持つ", async () => {
    const body = await open("http://127.0.0.1:8899");
    expect(body).toContain(
      `<a href="${PICKER_DOCS_URL}" target="_blank" rel="noopener">使い方</a>`,
    );
  });

  // 行のクリックで開く先は、渡された replay の場所から組む。既定値を焼き込んでいたら、
  // REPLAY_ORIGIN を変えても古い場所を開き続ける。
  it("渡された replay の場所を、行のリンクを組む script に埋め込む", async () => {
    const body = await open("http://replay.example:9000");
    expect(body).toContain('const REPLAY_ORIGIN = "http://replay.example:9000";');
    expect(body).not.toContain("127.0.0.1:8899");
  });
});
