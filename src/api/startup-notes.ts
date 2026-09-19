/**
 * API が起動したときに言うこと。**設定が足りなければ、ここで名指しする。**
 *
 * クロールには、この repo の `.env` に 4 行が要る (capture-scheduler の `windmill:bootstrap` が
 * 出す)。そのうち `CAPTURE_LEDGER_API_HOST=0.0.0.0` と `CAPTURE_LEDGER_OIDC_ISSUER` が欠けても
 * API は普通に起き、以前の起動ログは、欠けていても揃っていても同じ 3 行だった ——
 * `DEV_IDENTITY` の警告は JWT の設定でも出て、listening の行はポートしか書かなかった。
 * 2026-09-19 と 20 に、この 2 行が効いていない API で段の報告が届かず、気づけたのは
 * capture-scheduler の doctor だけだった。
 *
 * だから最後の 1 行で、待ち受け・名乗り方・段の報告を受けられるかを言う
 * (`crawl level reports: ready | blocked | off`)。受けられないなら、その前の warn が
 * 足りない行を名指しする。
 *
 * 入出力を持たない。立っているもの (`StartupFacts`) を受け取り、言うこと (`Note`) を返す。
 * log に出すのは `server.ts`。
 */

export interface StartupFacts {
  /** 待ち受けるアドレス (`CAPTURE_LEDGER_API_HOST`)。 */
  host: string;
  port: number;
  /** `selectIdentity` が選んだ名乗り方。 */
  identity: { mode: "jwt"; issuer: string } | { mode: "header" | "deny" };
  /** `CAPTURE_LEDGER_DEV_IDENTITY=1` が立っているか。JWT の設定では無視される。 */
  devIdentity: boolean;
  /** クロールの口 (webhook の 2 行) が在るか。 */
  crawls: boolean;
  /** 受け口 (sink の 2 行) が在るか。 */
  sink: boolean;
  /** 検索の口が在るか。 */
  search: boolean;
}

export interface Note {
  level: "info" | "warn";
  msg: string;
  /** log の構造化した欄。最後の行だけが持つ。 */
  fields?: Record<string, unknown>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * この Mac の中からしか届かないアドレスか。コンテナからは届かない —— コンテナから host の
 * ポートを叩くと、127.0.0.1 で待つプロセスには refused になる (実測)。
 *
 * picker (`picker.ts`) も、この判定で「外に出ている」を画面に出す。起動ログと画面で判定が
 * 割れないように、ここ 1 か所に置く。
 */
export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

const DEV_HEADER_TRUSTED =
  "CAPTURE_LEDGER_DEV_IDENTITY=1 — callers are trusted on the X-Capture-ledger-Subject header. " +
  "Never enable this outside local development.";

const identityLabel = (identity: StartupFacts["identity"]): string => {
  if (identity.mode === "jwt") return `JWT (${identity.issuer})`;
  return identity.mode === "header" ? "dev header" : "none";
};

export const startupNotes = (facts: StartupFacts): Note[] => {
  const { host, port, identity } = facts;
  const loopback = isLoopback(host);
  const notes: Note[] = [];

  // ① 名乗り方。ヘッダの警告は、ヘッダが実際に効いているときだけ出す。
  if (identity.mode === "header") notes.push({ level: "warn", msg: DEV_HEADER_TRUSTED });
  if (identity.mode === "deny") {
    notes.push({
      level: "warn",
      msg:
        "No identity is configured — every request is refused (401). " +
        "Set CAPTURE_LEDGER_OIDC_ISSUER (JWT) or CAPTURE_LEDGER_DEV_IDENTITY=1 (dev header)",
    });
  }
  if (identity.mode === "jwt" && facts.devIdentity) {
    notes.push({
      level: "info",
      msg: "CAPTURE_LEDGER_DEV_IDENTITY=1 is ignored — CAPTURE_LEDGER_OIDC_ISSUER takes precedence",
    });
  }

  // ② ヘッダを信じる API を、外に出していないか。OIDC の行だけを外してヘッダに切り替えると、
  //    クロール用の CAPTURE_LEDGER_API_HOST=0.0.0.0 が残る。picker はトークンを受けるので、
  //    picker のために切り替える必要は無い。
  if (identity.mode === "header" && !loopback) {
    notes.push({
      level: "warn",
      msg:
        `The dev header is trusted on ${host}:${String(port)} — anyone who can reach this port ` +
        "can act as any user. Set CAPTURE_LEDGER_API_HOST=127.0.0.1, or keep " +
        "CAPTURE_LEDGER_OIDC_ISSUER (the picker takes a token)",
    });
  }

  // ③ コンテナから届くか。段の報告も、受け口への PUT も、コンテナから来る。
  const fromContainers = [
    ...(facts.crawls ? ["crawl level reports"] : []),
    ...(facts.sink ? ["artifact uploads (sink)"] : []),
  ];
  const unreachable = fromContainers.length > 0 && loopback;
  if (unreachable) {
    notes.push({
      level: "warn",
      msg:
        `Containers cannot reach this API: it listens on ${host}, and ` +
        `${fromContainers.join(" and ")} come from containers. Set CAPTURE_LEDGER_API_HOST=0.0.0.0`,
    });
  }

  // ④ 段の報告を受けるか。flow は Bearer の JWT で報告する。
  const refused = facts.crawls && identity.mode !== "jwt";
  if (refused) {
    notes.push({
      level: "warn",
      msg:
        "Crawl level reports will be refused (401): the flow reports with a Bearer JWT, " +
        `but identity is ${identityLabel(identity)}. Set CAPTURE_LEDGER_OIDC_ISSUER`,
    });
  }

  // ⑤ 最後の 1 行。docs と capture-ledger の外の道具は、この行の ready / blocked を目印にする。
  const reports = !facts.crawls ? "off" : unreachable || refused ? "blocked" : "ready";
  notes.push({
    level: "info",
    msg:
      `Archive API listening on ${host}:${String(port)} — identity: ${identityLabel(identity)}; ` +
      `crawl level reports: ${reports}`,
    fields: {
      host,
      port,
      identity: identity.mode,
      ...(identity.mode === "jwt" && { issuer: identity.issuer }),
      crawls: facts.crawls,
      sink: facts.sink,
      search: facts.search,
      crawlLevelReports: reports,
    },
  });
  return notes;
};
