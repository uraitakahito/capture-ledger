/**
 * ts-compile-service の `POST /compile` を呼ぶ窓口。
 *
 * **flow の compile の段と同じサービスを、同じ形で呼ぶ。** 送るのは webhook に載せたのと同じ
 * `{ id, version, phase, source, sha256, options }` の列 (`toDispatched`) なので、型で落ちた
 * クロールを送り直せば、落ちたときと同じ型の誤りが行と列で返る。クロールの行に残る失敗の文は
 * 台帳の上限の 2,000 字で切られ、最初の数件しか無い —— 全部を行と列で読むのはここだけ。
 *
 * 宛先は host の loopback (`127.0.0.1:28080`。capture-scheduler の compose が出す)。macOS 26 では
 * host の node がコンテナの subnet に TCP を張れないので、名前 (`ts-compile.capture-scheduler`) では
 * 届かない。
 */
import { optional } from "../config/env.js";
import type { CrawlScript } from "../db/database.js";

/** 既定の待ち時間。flow の compile の段は 1 回 1 秒に満たない。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** ts-compile-service に届かなかった・答えの形が違った。口はこれを 503 に訳す。 */
export class TsCompileUnreachable extends Error {
  override name = "TsCompileUnreachable";
}

/** 型の誤り 1 件 (ts-compile-service の `Diagnostic`)。`file` は `<id>.ts`。 */
export interface Diagnostic {
  file?: string;
  line?: number;
  col?: number;
  code: string;
  message: string;
}

export type CompileAnswer =
  | { ok: true; typescript: string; hostTypes: string }
  | { ok: false; typescript: string; diagnostics: Diagnostic[] };

export interface TsCompile {
  compile(scripts: readonly CrawlScript[]): Promise<CompileAnswer>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isDiagnostic = (v: unknown): v is Diagnostic =>
  isRecord(v) &&
  typeof v["code"] === "string" &&
  typeof v["message"] === "string" &&
  (v["file"] === undefined || typeof v["file"] === "string") &&
  (v["line"] === undefined || typeof v["line"] === "number") &&
  (v["col"] === undefined || typeof v["col"] === "number");

/**
 * 答えを読む。**形が違えば「通った」とも「誤りが無い」とも読まずに投げる** —— 誤った宛先
 * (同じ番号の別のサービス) が 200 を返しても、取り直しの結果として渡さない。
 */
const readAnswer = (status: number, body: unknown): CompileAnswer => {
  if (status === 200 && isRecord(body)) {
    const { typescript, hostTypes } = body;
    if (typeof typescript === "string" && typeof hostTypes === "string") {
      return { ok: true, typescript, hostTypes };
    }
  }
  if (status === 422 && isRecord(body)) {
    const { typescript, diagnostics } = body;
    if (
      typeof typescript === "string" &&
      Array.isArray(diagnostics) &&
      diagnostics.every(isDiagnostic)
    ) {
      return { ok: false, typescript, diagnostics };
    }
  }
  throw new TsCompileUnreachable(`POST /compile → ${String(status)} の答えの形が違う`);
};

/** 口を直に渡して窓口を作る。`createTsCompile` と試験が使う。 */
export const tsCompileAt = ({
  base,
  timeoutMs,
}: {
  base: string;
  timeoutMs: number;
}): TsCompile => ({
  async compile(scripts) {
    const url = `${base}/compile`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scripts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TsCompileUnreachable(
        `POST ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status !== 200 && res.status !== 422) {
      // 409 (source と sha256 が合わない) も 400 もここ。台帳が写した行を送り直しているだけなので、
      // どれも台帳とサービスの食い違いで、人が直す誤りではない
      throw new TsCompileUnreachable(
        `POST ${url} → ${String(res.status)} ${(await res.text()).slice(0, 200)}`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TsCompileUnreachable(`POST ${url} → ${String(res.status)} の答えが JSON でない`);
    }
    return readAnswer(res.status, body);
  },
});

/**
 * 設定を読んで窓口を作る。URL が無ければ `undefined` —— その配備に取り直しは無く、口を出さない。
 * **起動時に読む。** 頼まれてから「設定がありません」と言わない。
 */
export const createTsCompile = (): TsCompile | undefined => {
  const base = optional("CAPTURE_LEDGER_TS_COMPILE_URL", "");
  if (base === "") return undefined;
  const timeoutMs = Number(
    optional("CAPTURE_LEDGER_TS_COMPILE_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)),
  );
  return tsCompileAt({ base: base.replace(/\/+$/, ""), timeoutMs });
};

/**
 * 誤りの `file` (`<id>.ts`) を、送ったスクリプトの id に直す。送った id に無い file
 * (lib や受け皿の型の file) は `script` を付けずに `file` のまま残す。
 */
export const attributeDiagnostics = (
  diagnostics: readonly Diagnostic[],
  ids: readonly string[],
): (Omit<Diagnostic, "file"> & { script?: string; file?: string })[] =>
  diagnostics.map(({ file, ...rest }) => {
    const id = file?.endsWith(".ts") === true ? file.slice(0, -".ts".length) : undefined;
    if (id !== undefined && ids.includes(id)) return { script: id, ...rest };
    return { ...(file === undefined ? {} : { file }), ...rest };
  });
