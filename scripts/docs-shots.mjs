#!/usr/bin/env node
/**
 * docs の「アーカイブを見る (picker)」に載せる、画面の絵を撮り直す。
 *
 * docs-site/src/assets/picker/ の PNG は全部この script の生成物で、手で撮った絵は 1 枚も無い。
 * 絵は画面の書き写しで、**書き写しは腐る** —— だから撮ったときの画面のソース
 * (`src/api/picker.ts`) の sha256 を shots-manifest.json に控え、`scripts/check-doc-refs.mjs` が
 * 「いまのソースと控えが一致すること」を CI で検める。**画面を変えたら、この script を回し直す
 * こと。** capture-scheduler の管理画面のページ (compose の pin と manifest の版) と同じ考え方で、
 * こちらは自分たちの画面なので、比べるのはソースのハッシュになる。
 *
 * ## スタックは要らない
 *
 * 立てるのは **本物の画面** (ビルド済みの registerPicker) と、**見本データを返す代役の
 * `/api/archives` と `/api/me`** だけ。DB も OpenFGA も replay も issuer も要らない。見本データ
 * なので、実データにはなかなか現れない状態 (「欠けあり」) も写せる。
 *
 * 画面は API の名乗り方で変わるので、名乗り方ごとに 1 組ずつ立てる (開発用ヘッダ・127.0.0.1／
 * JWT／名乗りの設定なし／開発用ヘッダ・0.0.0.0)。画面に渡す待ち受けは画面に出す値で、代役が
 * 実際に待つのは 127.0.0.1 の空きポート。
 *
 * 代役が真似るのは「誰か」と「起こした本人か、同じ組織の一員か」だけ。本物は issuer の署名を
 * 検め、OpenFGA の can_view に訊く。ヘッダの設定はヘッダだけ、JWT の設定は Bearer だけを見る
 * ところは本物と同じ (トークンは見本の 1 本だけが alice・acme として通る)。応答の形は本物
 * (`src/api/routes.ts` の GET /api/archives、`src/api/me.ts`) に合わせてある。形が変われば、それを
 * 描く `src/api/picker.ts` も変わるので、上の sha256 の検査が撮り直しを求める。
 *
 * ## 誰が撮っても同じ絵にする
 *
 *   - 見た目はライトモードに固定する。picker は `color-scheme: light dark` なので、OS がダーク
 *     モードだと入力欄だけが黒く写る (実際にそう写った)。
 *   - 言語は ja-JP、時間帯は Asia/Tokyo、見本データの日時は固定。「いつ」の列は
 *     `toLocaleString()` なので、どれが欠けても表記が変わる。
 *   - 注釈は番号だけ。説明の文は各言語のページの表に書くので、英日で同じ PNG を使える。
 *   - 撮る前に、その状態でしか出ない文字が画面に在ることを確かめる。無ければ撮らずに落ちる ——
 *     違う状態の絵を、正しい名前で保存しないため。
 *
 *   pnpm run docs:shots        # CI では走らせない。初回だけ先に:
 *   ./node_modules/.bin/puppeteer browsers install chrome
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import puppeteer from "puppeteer";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = "src/api/picker.ts";
const BUILT = resolve(ROOT, "dist/api/picker.js");
const OUT = resolve(ROOT, "docs-site/src/assets/picker");
// 幅は docs の本文幅 (約 630px) に近づけてある。広く撮ると、縮められて画面の中の文字が読めなくなる
// (最初は 1040 で撮って、そうなった)。
const VIEWPORT = { width: 800, height: 700, deviceScaleFactor: 2 };
const EMULATION = { lang: "ja-JP", timezone: "Asia/Tokyo", colorScheme: "light" };

if (!existsSync(BUILT)) {
  console.error(
    "dist/api/picker.js が無い。`pnpm run docs:shots` から走らせること (先に build する)。",
  );
  process.exit(1);
}
const { registerPicker } = await import(BUILT);

// 見本データ。`owner` と `org` は代役だけが使い、応答には載せない (本物の応答にも無い)。
// alice と acme は、画面の入力例 (placeholder) と同じ名前にしてある。
const FIXTURES = [
  {
    sourceUrl: "https://example.com/",
    capturedAt: "2026-09-19T01:12:40.000Z",
    labels: ["daily"],
    waczComplete: true,
    owner: "alice",
    org: "acme",
  },
  {
    sourceUrl: "https://example.com/pricing",
    capturedAt: "2026-09-19T01:12:31.000Z",
    labels: ["daily"],
    waczComplete: true,
    owner: "alice",
    org: "acme",
  },
  {
    sourceUrl: "https://example.org/annual-report",
    capturedAt: "2026-09-18T01:12:22.000Z",
    labels: [],
    waczComplete: false,
    owner: "carol",
    org: "acme",
  },
  {
    sourceUrl: "https://example.net/news",
    capturedAt: "2026-09-17T09:30:05.000Z",
    labels: ["news"],
    waczComplete: true,
    owner: "bob",
    org: "beta",
  },
].map((row, index) => ({
  id: `00000000-0000-4000-8000-00000000000${String(index)}`,
  taskId: `00000000-0000-4000-9000-00000000000${String(index)}`,
  objectKey: `sample-${String(index)}.wacz`,
  ...row,
}));

const REPLAY_ORIGIN = "http://127.0.0.1:8899";
/** 見本のトークン。代役だけが知っていて、alice・acme として通す。 */
const SAMPLE_TOKEN = "sample-token-alice-acme";
/** 画面に出すだけ。取りには行かない。 */
const ISSUER = "http://127.0.0.1:9099";
const LOOPBACK = { host: "127.0.0.1", port: 7070 };
const LAN = { host: "0.0.0.0", port: 7070 };

/** 名乗り方ごとの「誰か」。通らなければ undefined (本物は 401)。 */
const IDENTIFY = {
  header: (request) => {
    const subject = String(request.headers["x-capture-ledger-subject"] ?? "");
    if (subject === "") return undefined;
    const organizations = String(request.headers["x-capture-ledger-organizations"] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    return { subject, organizations };
  },
  jwt: (request) =>
    request.headers.authorization === `Bearer ${SAMPLE_TOKEN}`
      ? { subject: "alice", organizations: ["acme"] }
      : undefined,
  deny: () => undefined,
};

/** 本物の画面と代役の API を 1 組立てる。 */
const stand = async (identity, listen) => {
  const app = Fastify();
  registerPicker(app, { replayOrigin: REPLAY_ORIGIN, identity, listen });
  const identify = IDENTIFY[identity.mode];
  app.get("/api/archives", (request, reply) => {
    const me = identify(request);
    if (me === undefined) return reply.code(401).send({ error: "unauthenticated" });
    // 2 ページ目は無い。「さらに読む」を押しても何も増えない、を本物と同じ形で返す。
    if (request.query.before !== undefined) return reply.send({ archives: [] });
    const archives = FIXTURES.filter(
      (a) => a.owner === me.subject || me.organizations.includes(a.org),
    ).map(({ owner: _owner, org: _org, ...archive }) => archive);
    return reply.send({ archives });
  });
  app.get("/api/me", (request, reply) => {
    const me = identify(request);
    if (me === undefined) return reply.code(401).send({ error: "unauthenticated" });
    return reply.send({ ...me, canSubmit: true });
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, origin: `http://127.0.0.1:${String(app.server.address().port)}` };
};

const stands = {
  header: await stand({ mode: "header" }, LOOPBACK),
  jwt: await stand({ mode: "jwt", issuer: ISSUER }, LAN),
  deny: await stand({ mode: "deny" }, LOOPBACK),
  exposed: await stand({ mode: "header" }, LAN),
};

const browser = await puppeteer.launch({ args: [`--lang=${EMULATION.lang}`] });
const shots = [];
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.emulateTimezone(EMULATION.timezone);
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: EMULATION.colorScheme }]);
  await page.goto(`${stands.header.origin}/`, { waitUntil: "networkidle0" });
  mkdirSync(OUT, { recursive: true });

  /** その状態でしか出ない文字を待つ。無ければ撮らずに落ちる。 */
  const expectText = (text) =>
    page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 10_000 }, text);

  const bottomOf = (selector) =>
    page.evaluate((s) => {
      const rect = document.querySelector(s).getBoundingClientRect();
      return Math.ceil(rect.bottom + scrollY);
    }, selector);

  /** 名乗りを入れて「読み込む」を押し、その状態でしか出ない文字を待つ。 */
  const load = async (subject, organizations, expected) => {
    for (const [id, value] of [
      ["subject", subject],
      ["orgs", organizations],
    ]) {
      await page.$eval(`#${id}`, (el) => {
        el.value = "";
      });
      if (value !== "") await page.type(`#${id}`, value);
    }
    await page.click("#reload");
    await page.waitForFunction(
      (text) => document.querySelector("#out").innerText.includes(text),
      { timeout: 10_000 },
      expected,
    );
  };

  /** 見本の 3 行 (alice か acme に当たる) が出ていること。 */
  const expectRows = async () => {
    const rows = await page.$$eval("tr.row", (trs) => trs.length);
    if (rows !== 3)
      throw new Error(`一覧は 3 行のはず (alice か acme に当たる見本) だが ${String(rows)} 行`);
  };

  /** 枠と番号を画面に足す。説明の文は足さない (英日で同じ絵を使うため)。 */
  const annotate = (targets) =>
    page.evaluate((list) => {
      document.getElementById("docs-shots-annotations")?.remove();
      const layer = document.createElement("div");
      layer.id = "docs-shots-annotations";
      layer.style.cssText =
        "position:absolute;left:0;top:0;width:0;height:0;z-index:99999;pointer-events:none";
      for (const { selector, n, pad = 3, inset, badgeDx = 0 } of list) {
        const full = document.querySelector(selector).getBoundingClientRect();
        const r = inset
          ? {
              left: full.left + inset.left,
              top: full.top + inset.top,
              width: full.width - inset.left - inset.right,
              height: full.height - inset.top - inset.bottom,
            }
          : full;
        const x = r.left + scrollX - pad;
        const y = r.top + scrollY - pad;
        const box = document.createElement("div");
        box.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;border:2px solid #6c5ce7;border-radius:8px;box-sizing:border-box`;
        const badge = document.createElement("div");
        badge.textContent = String(n);
        badge.style.cssText = `position:absolute;left:${x - 13 + badgeDx}px;top:${y - 13}px;width:26px;height:26px;border-radius:13px;background:#6c5ce7;color:#fff;font:700 15px/26px -apple-system,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35)`;
        layer.append(box, badge);
      }
      document.body.append(layer);
    }, targets);

  const shoot = async (name, top, bottom) => {
    await page.screenshot({
      path: resolve(OUT, name),
      clip: { x: 0, y: top, width: VIEWPORT.width, height: bottom - top },
      captureBeyondViewport: true,
    });
    shots.push(name);
  };

  // 緑のヘッダは 01 と 02 にだけ写す。03 と 04 は入力欄から下を切り出す。
  const BELOW_HEADER = 96;

  // 02: 開いた直後。まだ何も訊いていない。
  await page.waitForFunction(() =>
    document.querySelector("#out").innerText.includes("subject を入れて"),
  );
  await shoot("02-initial.png", 0, (await bottomOf("#out")) + 16);

  // 03: 見本のどの行にも当たらない名乗り → 空。
  await load("dave", "", "見えるアーカイブが無い");
  await shoot("03-empty.png", BELOW_HEADER, (await bottomOf("#out")) + 16);

  // 04: subject が空 → 401。
  await load("", "acme", "401");
  await shoot("04-unauthenticated.png", BELOW_HEADER, (await bottomOf("#out")) + 16);

  // 01: 一覧。番号はページの表 (画面の部品) の行と同じ順。
  await load("alice", "acme", "欠けあり");
  await expectRows();
  await annotate([
    { selector: "#subject", n: 1 },
    { selector: "#orgs", n: 2 },
    { selector: "#reload", n: 3 },
    { selector: "thead th:nth-child(1)", n: 4 },
    { selector: "thead th:nth-child(2)", n: 5 },
    { selector: "tbody tr.row:nth-child(1) td:nth-child(3)", n: 6 },
    { selector: "tbody tr.row:nth-child(3) td:nth-child(4)", n: 7 },
    { selector: "#more", n: 8 },
    // footer は画面の左端から始まるので、番号を内側へ寄せる (外に置くと切れる)。
    { selector: "footer", n: 9, inset: { left: 12, right: 12, top: -6, bottom: 34 }, badgeDx: 14 },
  ]);
  await shoot("01-list.png", 0, (await bottomOf("footer")) - 18);

  // 05: JWT の設定。見本のトークンを貼って読み込み、誰として見ているかが出た一覧。
  await page.goto(`${stands.jwt.origin}/`, { waitUntil: "networkidle0" });
  await expectText("トークンを貼って「読み込む」");
  await page.type("#token", SAMPLE_TOKEN);
  await page.click("#reload");
  await expectText("alice（acme）として見ている");
  await expectRows();
  // 下の「さらに読む」は写さない (01 と違い、番号を付けないので要らない)。
  await shoot("05-jwt.png", 0, (await bottomOf("#out")) + 10);

  // 06: 名乗りの設定が無い。注意だけで、欄も「読み込む」も無い。
  await page.goto(`${stands.deny.origin}/`, { waitUntil: "networkidle0" });
  await expectText("全員 401");
  await shoot("06-no-identity.png", 0, (await bottomOf("#notice")) + 16);

  // 07: 開発用ヘッダの設定を 0.0.0.0 で待たせている。画面の上の注意。
  await page.goto(`${stands.exposed.origin}/`, { waitUntil: "networkidle0" });
  await expectText("同じネットワークの誰もが、誰にでもなれる");
  await shoot("07-header-exposed.png", 0, (await bottomOf(".who")) + 16);
} finally {
  await browser.close();
  for (const { app } of Object.values(stands)) await app.close();
}

// manifest は撮った条件の控え。**手で書かない** —— sha256 を手で写すと、検査が嘘になる。
// 撮った時刻は入れない: 何も変えずに撮り直しても、差分が出ないようにするため。
const manifest = {
  source: SOURCE,
  sourceSha256: createHash("sha256")
    .update(readFileSync(resolve(ROOT, SOURCE)))
    .digest("hex"),
  viewport: VIEWPORT,
  emulation: EMULATION,
  shots: [...shots].sort(),
};
writeFileSync(resolve(OUT, "shots-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `✓ ${String(shots.length)} 枚を撮った → docs-site/src/assets/picker/ (${SOURCE} の sha256 ${manifest.sourceSha256.slice(0, 12)}…)`,
);
