/**
 * ts-compile-service の `POST /compile` を呼ぶクライアント。
 *
 * **flow の compile の段と同じサービスを、同じ形で呼ぶ。** 送るのは webhook に載せたのと同じ
 * `{ id, version, phase, source, sha256, options }` の列 (`toDispatched`) なので、型で落ちた
 * クロールを送り直せば、落ちたときと同じ型の誤りが行と列で返る。クロールの行に残る失敗の文は
 * capture-ledger の上限の 2,000 字で切られ、最初の数件しか無い —— 全部を行と列で読むのはここだけ。
 *
 * **env を読まない** (設定からクライアントを作るのは `src/config/ts-compile.ts`)。評価の道具も同じクライアントを使う。
 *
 * 宛先は host の loopback (`127.0.0.1:28080`。capture-scheduler の compose が出す)。macOS 26 では
 * host の node がコンテナの subnet に TCP を張れないので、名前 (`ts-compile.capture-scheduler`) では
 * 届かない。
 */
import type { CrawlScript, ScriptParam } from "../db/database.js";
import { readParams } from "./store.js";

/** ts-compile-service に届かなかった・答えの形が違った。エンドポイントはこれを 503 に訳す。 */
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

/** スクリプト 1 本の変数の宣言 (source の `defineParams`)。`unreadable` は宣言を読めなかった本 (BH0002)。 */
export interface DeclaredScript {
  id: string;
  params: ScriptParam[];
  unreadable: boolean;
}

export type CompileAnswer =
  | { ok: true; typescript: string; hostTypes: string; declarations: DeclaredScript[] }
  | {
      ok: false;
      typescript: string;
      diagnostics: Diagnostic[];
      declarations: DeclaredScript[];
      /** 必須の宣言のうち、渡されなかった名前。在れば「型の誤り」ではなく、値が足りない。 */
      missingVariables: string[];
    };

export interface TsCompile {
  /** `variableNames` は渡された変数の名前。値は送らない。 */
  compile(
    scripts: readonly CrawlScript[],
    variableNames: readonly string[],
  ): Promise<CompileAnswer>;
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
 * 宣言を読む。**capture-ledger の決まりに通す** (`readParams`)。読めた名前は Windmill の変数の path (`secretPath`) や
 * 行に写るので、サービスの答えでも形の悪い名前を通さない。変数のほかは宣言できない。読めなければ undefined。
 */
const readDeclarations = (raw: unknown): DeclaredScript[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const out: DeclaredScript[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const { id, params, unreadable } = entry;
    if (typeof id !== "string" || typeof unreadable !== "boolean") return undefined;
    const read = readParams(params, { summaryRequired: false });
    if (typeof read === "string" || read.some((param) => param.kind !== "variable"))
      return undefined;
    out.push({ id, params: read, unreadable });
  }
  return out;
};

const isNames = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((name) => typeof name === "string");

/**
 * 答えを読む。**形が違えば「通った」とも「誤りが無い」とも読まずに投げる** —— 誤った宛先
 * (同じ番号の別のサービス) が 200 を返しても、取り直しの結果として渡さない。
 */
const readAnswer = (status: number, body: unknown): CompileAnswer => {
  const declarations = isRecord(body) ? readDeclarations(body["declarations"]) : undefined;
  if (status === 200 && isRecord(body) && declarations !== undefined) {
    const { typescript, hostTypes } = body;
    if (typeof typescript === "string" && typeof hostTypes === "string") {
      return { ok: true, typescript, hostTypes, declarations };
    }
  }
  if (status === 422 && isRecord(body) && declarations !== undefined) {
    const { typescript, diagnostics, missingVariables } = body;
    if (
      typeof typescript === "string" &&
      Array.isArray(diagnostics) &&
      diagnostics.every(isDiagnostic) &&
      isNames(missingVariables)
    ) {
      return { ok: false, typescript, diagnostics, declarations, missingVariables };
    }
  }
  throw new TsCompileUnreachable(`POST /compile → ${String(status)} の答えの形が違う`);
};

/** 宛先を直に渡してクライアントを作る。`createTsCompile` と試験が使う。 */
export const tsCompileAt = ({
  base,
  timeoutMs,
}: {
  base: string;
  timeoutMs: number;
}): TsCompile => ({
  async compile(scripts, variableNames) {
    const url = `${base}/compile`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scripts, variableNames }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TsCompileUnreachable(
        `POST ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status !== 200 && res.status !== 422) {
      // 409 (source と sha256 が合わない) も 400 もここ。capture-ledger が写した行を送り直しているだけなので、
      // どれも capture-ledger とサービスの食い違いで、人が直す誤りではない
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
