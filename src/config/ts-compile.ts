/**
 * 型の検査のクライアントを、env から作る。**API の起動時に読む** (`src/api/server.ts`)。クライアントそのものは
 * `src/scripts/ts-compile.ts` で、env を読まないので道具からも使える。
 */
import { optional } from "./env.js";
import { tsCompileAt, type TsCompile } from "../scripts/ts-compile.js";

/** 既定の待ち時間。flow の compile の段は 1 回 1 秒に満たない。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 設定を読んでクライアントを作る。URL が無ければ `undefined` —— その配備に取り直しは無く、エンドポイントを出さない。
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
