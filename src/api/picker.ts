/**
 * WACZ を選ぶための 1 ページ。
 *
 * これまで、アーカイブを開くには鍵を自分で調べて URL を組み立てる必要があった:
 *
 *   aws s3 ls s3://browserhive/ | grep wacz
 *   open "http://127.0.0.1:8899/?source=/wacz/<key>"
 *
 * 台帳 (archives) には既に必要なものが揃っている —— source_url / labels /
 * captured_at / wacz_complete、そして replay へ渡す object_key。`GET /api/archives`
 * は OpenFGA で 1 件ずつ絞り込んだ結果を返すので、ここは **それを並べるだけ**。
 *
 * @fastify/static を入れず route から HTML を返すのは、依存を増やさないため。
 * 分割したくなるほど育ったら、そのとき入れる。
 *
 * ## 画面は API の名乗り方に合わせる
 *
 * 名乗り方 (`selectIdentity`) は 3 通りあり、以前の画面はどれでも同じだった —— 開発用ヘッダの
 * 2 欄を出し、401 には「subject が空か、DEV_IDENTITY=1 になっていない」とだけ言った。JWT の
 * 設定の API では何を入れても 401 になり、その文は原因を言わなかった (2026-09-20 に実際に
 * 止まった)。ブラウザの側では「subject が空」と「JWT の設定」を見分けられない —— どちらも
 * 401 の `{"error":"unauthenticated"}` —— ので、**名乗り方を知っている API が、HTML を出す
 * 時点で決める** (`pickerView`)。画面の script には推測させない。
 *
 * **開発用ヘッダの設定では、この画面は誰も認証しない。** resolver が `X-Capture-ledger-Subject`
 * を信じるので、subject は入力欄から来る —— 「そのポートに届く者は誰にでもなれる」という
 * 性質をそのまま映している。**画面がそれ以上に安全に見えてはいけない**ので、そう書いてある。
 *
 * 読みの経路には認可が無いことにも注意。picker が絞るのは「一覧に出すかどうか」
 * だけで、`/wacz/<key>` は鍵を知っていれば誰でも読める。閉じるなら署名付き URL
 * (`POST /api/archives/:id/url`) と CORS へ進むことになる。
 */
import type { FastifyInstance } from "fastify";
import { optional } from "../config/env.js";
import { isLoopback, type StartupFacts } from "./startup-notes.js";

/**
 * replay の場所。picker が組み立てるのは replay 内の相対パスなので、
 * bucket も資格情報もここには要らない —— 渡すのは object_key 1 つ。
 *
 * env にしてあるのは、replay を別の場所で動かす自由を残すため。replay は
 * ledger 専用ではない。
 */
export const replayOriginFromEnv = (): string => optional("REPLAY_ORIGIN", "http://127.0.0.1:8899");

/**
 * この画面の使い方のページ (公開中の docs)。
 *
 * 画面に置くのは、**迷う人が居るのは docs の上ではなく、この画面の上だから**。2 つの入力欄に
 * 何を入れるかは画面を見ても分からず、docs に書いても、ここから行く道が無ければ同じ所で止まる
 * (2026-09-19 に実際に止まった)。
 *
 * 宛先のページが在ることは `scripts/check-doc-refs.mjs` が見ている —— ページの名前を変えたら、
 * ここも直さないと CI が落ちる。
 */
export const PICKER_DOCS_URL = "https://uraitakahito.github.io/capture-ledger/ja/picker/";

export interface PickerOptions {
  /** replay の場所 (`replayOriginFromEnv`)。 */
  replayOrigin: string;
  /** API が選んだ名乗り方 (`selectIdentity`)。起動ログ (`startup-notes.ts`) と同じもの。 */
  identity: StartupFacts["identity"];
  /** API が待ち受けるアドレス。ヘッダの設定で外に出ていれば、画面の上でそう言う。 */
  listen: { host: string; port: number };
}

/** 画面に何を出すか。名乗り方と待ち受けだけで決まる。 */
export interface PickerView {
  /** 入力欄の形。`none` は欄を出さない —— 押しても必ず 401 になる欄は、出すだけ紛らわしい。 */
  form: "names" | "token" | "none";
  /** 画面の上に出す注意。 */
  notice?: { level: "warn" | "info"; text: string };
  /** 401 が返ったときの文。名乗り方ごとに、本当の原因を言う。 */
  unauthorized: string;
}

const NO_IDENTITY =
  "この API には名乗りの設定が無く、誰の一覧も出せない（全員 401）—— .env に " +
  "CAPTURE_LEDGER_OIDC_ISSUER か CAPTURE_LEDGER_DEV_IDENTITY=1 を書いて、API を起こし直す";

/** 何を出すかを決める。入出力を持たない —— HTML に組むのは `html`。 */
export const pickerView = (
  identity: PickerOptions["identity"],
  listen: PickerOptions["listen"],
): PickerView => {
  if (identity.mode === "deny") {
    return {
      form: "none",
      notice: { level: "warn", text: NO_IDENTITY },
      unauthorized: NO_IDENTITY,
    };
  }
  if (identity.mode === "jwt") {
    return {
      form: "token",
      notice: {
        level: "info",
        text: `この API は JWT で名乗る設定（${identity.issuer}）。この画面の名乗り（開発用ヘッダ）は効かない`,
      },
      unauthorized: "401 — この API は JWT で名乗る設定",
    };
  }
  return {
    form: "names",
    // 起動ログの warn と同じ判定 (isLoopback)。画面を開いた人は、起動ログを見ていないことがある。
    ...(!isLoopback(listen.host) && {
      notice: {
        level: "warn",
        text:
          `この API は ${listen.host}:${String(listen.port)} で待ちながら、名乗りをそのまま信じる —— ` +
          "同じネットワークの誰もが、誰にでもなれる。127.0.0.1 で待たせる（CAPTURE_LEDGER_API_HOST=127.0.0.1）か、" +
          "JWT の設定（CAPTURE_LEDGER_OIDC_ISSUER）に戻す",
      },
    }),
    unauthorized: "401 — subject が空（この API は開発用ヘッダで名乗る設定）",
  };
};

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

const noticeHtml = (notice: PickerView["notice"]): string =>
  notice === undefined
    ? ""
    : `<p class="notice ${notice.level}" id="notice">${escapeHtml(notice.text)}</p>`;

/** 名乗りの欄。欄を出さない画面は、一覧の置き場も script も持たない。 */
const formHtml = (view: PickerView): string => {
  if (view.form !== "names") return "";
  return `<div class="who">
    <label>subject <input id="subject" size="16" placeholder="alice"></label>
    <label>organizations <input id="orgs" size="20" placeholder="acme,beta"></label>
    <button id="reload" type="button">読み込む</button>
    <p class="why">
      この画面は誰も認証しない。開発用の resolver が <code>X-Capture-ledger-Subject</code> を
      そのまま信じるので、ここに入れた名前で見えるものが変わる ——
      <b>そのポートに届く者は、誰にでもなれる</b>。
    </p>
  </div>

  <div id="out"><p class="empty">subject を入れて「読み込む」</p></div>
  <p style="text-align:center"><button id="more" type="button" hidden>さらに読む</button></p>`;
};

const script = (replayOrigin: string, view: PickerView): string => {
  if (view.form !== "names") return "";
  return `<script>
const REPLAY_ORIGIN = ${JSON.stringify(replayOrigin)};
const UNAUTHORIZED = ${JSON.stringify(view.unauthorized)};
const $ = (id) => document.getElementById(id);
let cursor = null;

// 誰として見るかは覚えておく。毎回打ち直させると、使う気が失せる。
for (const key of ["subject", "orgs"]) {
  $(key).value = localStorage.getItem("capture-ui." + key) ?? "";
  $(key).addEventListener("change", () => localStorage.setItem("capture-ui." + key, $(key).value));
}

const headers = () => ({
  "X-Capture-ledger-Subject": $("subject").value.trim(),
  "X-Capture-ledger-Organizations": $("orgs").value.trim(),
});

/** 一覧の代わりに 1 行の文を出す。文は textContent で入れる。 */
const say = (className, text) => {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  $("out").replaceChildren(p);
};

const fmt = (iso) => new Date(iso).toLocaleString();

const rowHtml = (a) => {
  // replay へ渡すのは object_key ひとつ。bucket も資格情報も要らない ——
  // 読みは replay 自身の上流設定を通る。
  const href = REPLAY_ORIGIN + "/?source=/wacz/" + encodeURIComponent(a.objectKey);
  const labels = (a.labels ?? []).map((l) => '<span class="label">' + l + "</span>").join("");
  // 完全でない archive は開く前に分かるようにする。開いてから「本文が無い」と
  // 気づくのでは遅い。
  const complete = a.waczComplete === false ? '<span class="incomplete">欠けあり</span>' : "";
  return (
    '<tr class="row" data-href="' + href + '">' +
    '<td class="url">' + a.sourceUrl + "</td>" +
    "<td>" + fmt(a.capturedAt) + "</td>" +
    "<td>" + labels + "</td>" +
    "<td>" + complete + "</td>" +
    "</tr>"
  );
};

const render = (archives, append) => {
  if (!append && archives.length === 0) {
    say("empty", "見えるアーカイブが無い");
    return;
  }
  const rows = archives.map(rowHtml).join("");
  if (append) {
    $("out").querySelector("tbody").insertAdjacentHTML("beforeend", rows);
  } else {
    $("out").innerHTML =
      "<table><thead><tr><th>取り込んだ URL</th><th>いつ</th><th>ラベル</th><th></th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>";
  }
  for (const tr of $("out").querySelectorAll("tr.row")) {
    tr.onclick = () => window.open(tr.dataset.href, "_blank", "noopener");
  }
};

const load = async (append) => {
  const query = append && cursor ? "?before=" + encodeURIComponent(cursor) : "";
  const res = await fetch("/api/archives" + query, { headers: headers() });
  if (res.status === 401) {
    // 何が足りないかは、API の名乗り方で決まる。文はサーバが決めて埋め込んである。
    say("error", UNAUTHORIZED);
    $("more").hidden = true;
    return;
  }
  if (!res.ok) {
    say("error", res.status + " — 一覧を取れなかった");
    return;
  }
  const { archives } = await res.json();
  render(archives, append);
  // 次のページの手掛かりは、いま出した最後の行の時刻。API の契約に合わせている。
  cursor = archives.length > 0 ? archives[archives.length - 1].capturedAt : null;
  $("more").hidden = archives.length === 0;
};

$("reload").onclick = () => { cursor = null; void load(false); };
$("more").onclick = () => void load(true);
if ($("subject").value !== "") void load(false);
</script>`;
};

const html = (replayOrigin: string, view: PickerView): string => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ledger — アーカイブ</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
         background: #f6f7fb; color: #1f2330; }
  header { background: #1aa179; color: #fff; padding: 18px 24px; }
  header h1 { margin: 0; font-size: 18px; }
  header p { margin: 6px 0 0; font-size: 12.5px; opacity: .95; }
  header a { color: #fff; margin-left: 10px; }
  main { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .notice { border-radius: 10px; padding: 10px 16px; margin: 0 0 14px; font-size: 13.5px; }
  .notice.warn { background: #fdecef; border: 1px solid #f1b8c6; color: #8e1f3c; }
  .notice.info { background: #e8f2fc; border: 1px solid #b7d6f3; color: #0a4f88; }
  .who { background: #fffdf6; border: 1px solid #e8ce8f; border-radius: 10px;
         padding: 12px 16px; margin-bottom: 18px; font-size: 13.5px; }
  .who label { display: inline-block; margin-right: 14px; }
  .who input { font: inherit; padding: 3px 7px; border: 1px solid #d6d9e4; border-radius: 5px; }
  .who .why { margin: 8px 0 0; color: #8a6d1f; }
  table { width: 100%; border-collapse: collapse; background: #fff; font-size: 14px; }
  th, td { border: 1px solid #e3e6ef; padding: 8px 11px; text-align: left; vertical-align: top; }
  th { background: #f0f2f9; font-weight: 600; }
  tr.row:hover { background: #f5fdfa; cursor: pointer; }
  .url { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
  .label { display: inline-block; background: #eef0f7; border-radius: 20px;
           padding: 1px 8px; font-size: 11.5px; margin-right: 4px; }
  .incomplete { color: #b82c4c; font-weight: 600; }
  .empty, .error { padding: 30px; text-align: center; color: #5b6172; }
  .error { color: #b82c4c; }
  button { font: inherit; padding: 6px 14px; border: 1px solid #1aa179; background: #fff;
           color: #0f7a5c; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  footer { max-width: 1000px; margin: 0 auto; padding: 0 20px 40px; color: #5b6172; font-size: 12.5px; }
</style>
</head>
<body>
<header>
  <h1>アーカイブ</h1>
  <p>行をクリックすると replay で開く。新しい順・1 ページ 50 件。<a href="${PICKER_DOCS_URL}" target="_blank" rel="noopener">使い方</a></p>
</header>

<main>
  ${noticeHtml(view.notice)}
  ${formHtml(view)}
</main>

<footer>
  一覧は台帳 (<code>archives</code>) から来ていて、OpenFGA の <code>can_view</code> で
  絞り込まれている。ただし<b>絞っているのは一覧に出すかどうかだけ</b>で、
  <code>/wacz/&lt;key&gt;</code> を読む経路に認可は無い。
</footer>

${script(replayOrigin, view)}
</body>
</html>
`;

export const registerPicker = (app: FastifyInstance, options: PickerOptions): void => {
  // 名乗り方も待ち受けも起動の後は変わらないので、HTML は 1 回だけ組む。
  const page = html(options.replayOrigin, pickerView(options.identity, options.listen));
  app.get("/", (_request, reply) => reply.type("text/html; charset=utf-8").send(page));
};
