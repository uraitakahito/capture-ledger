/**
 * 単体試験から実 DNS を締め出す。Vitest は setupFiles、node --test は --import で読ませる。
 *
 * 引いてよいのは、RFC 6761 が答えを決めている名前だけ:
 *   - IP リテラル（引かない）と localhost（§6.3。OS の hosts が答える）
 *   - *.invalid（§6.4。網に聞かずに「無い」と答える）
 * ほかの名前は「無い」と答えたうえで記録し、その試験を afterEach で赤にする。lookup の中で
 * 投げて知らせないのは、呼んだ側が lookup の失敗を握りつぶすことがあるから（browserhive の
 * checkCaptureAddress は引けない名前を通す）。答えが要る試験は、試験の中で
 * vi.mock("node:dns/promises") を使って差し込む。
 *
 * 同じファイルを 6 repo に置く（browserhive・capture-ledger・capture-scheduler・capture-fixtures・
 * dashboard・wacz-validator）。直すときは 6 つとも直す。
 */
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";

type Lookup = (this: unknown, host: string, ...rest: unknown[]) => unknown;
interface State {
  refused: string[];
  installed: boolean;
}

// Vitest は試験ファイルごとに setup を読み直すので、状態は process に 1 つだけ持つ
// （Symbol.for は読み直しをまたいで同じ鍵を返す）。
const scope = globalThis as unknown as Record<symbol, State | undefined>;
const state = (scope[Symbol.for("crawler.no-dns")] ??= { refused: [], installed: false });

/** "pass" は本物の lookup に渡す。"nxdomain" は網に聞かずに「無い」と答える。 */
const decide = (host: string): "pass" | "nxdomain" | "refuse" => {
  if (isIP(host) !== 0) return "pass";
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost") return "pass";
  if (name === "invalid" || name.endsWith(".invalid")) return "nxdomain";
  return "refuse";
};

const notFound = (host: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: host,
  });

if (!state.installed) {
  state.installed = true;
  // dns.lookup は callback の形（net・http・fetch はこちらを通る）。
  const callbackApi = dns as unknown as { lookup: Lookup };
  const callbackLookup = callbackApi.lookup;
  callbackApi.lookup = function lookup(host, ...rest) {
    const verdict = decide(host);
    if (verdict === "pass") return callbackLookup.call(this, host, ...rest);
    if (verdict === "refuse") state.refused.push(host);
    process.nextTick(rest.at(-1) as (error: Error) => void, notFound(host));
    return {};
  };
  // dns/promises の lookup（browserhive の src はこちらを import する）。
  for (const api of new Set([dnsPromises, dns.promises]) as Set<unknown>) {
    const promiseApi = api as { lookup: Lookup };
    const promiseLookup = promiseApi.lookup;
    promiseApi.lookup = function lookup(host, ...rest) {
      const verdict = decide(host);
      if (verdict === "pass") return promiseLookup.call(this, host, ...rest);
      if (verdict === "refuse") state.refused.push(host);
      return Promise.reject(notFound(host));
    };
  }
  // import { lookup } from "node:dns/promises" の側にも、差し替えを届かせる。
  syncBuiltinESMExports();
}

const { afterEach } = process.env["VITEST"] ? await import("vitest") : await import("node:test");
afterEach(() => {
  const names = state.refused.splice(0);
  if (names.length > 0) {
    throw new Error(
      `単体試験が実 DNS を引いた: ${[...new Set(names)].join(", ")} —— 答えは試験の中で差し込む（vi.mock("node:dns/promises")）`,
    );
  }
});
