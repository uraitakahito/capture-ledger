/**
 * Windmill の変数に「在るか」「secret か」「いつ変わったか」を訊く窓口。**値は読まない。**
 *
 * スクリプトが宣言したシークレット (`crawl/values.ts`) は Windmill の secret 変数 `f/waggle_secrets/<名前>` に
 * 結ぶ。台帳が確かめるのは在るか・secret か・更新時刻だけで、値を解くのは flow の `crawl_host`。
 * 値を読まないので、台帳の process にも log にも DB にも値は通らない。
 *
 * ## 口と token は webhook の物を使う
 *
 * 新しい env は足さない。Windmill の口の根と workspace は `CAPTURE_LEDGER_CRAWL_WEBHOOK_URL`
 * (`<base>/api/w/<workspace>/jobs/run/f/<flow の path>`) から読み、token は `CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN`。
 * webhook を設定していない配備にはこの窓口も無く、シークレットを宣言したスクリプトのクロールは
 * 400 で止まる (そもそも flow が無いので解く者も居ない)。
 *
 * ## `decrypt_secret=false` を必ず付ける
 *
 * `variables/get/<path>` は、付けなければ secret でも `value` に平文を返す (Windmill CE v1.806.0 で実測)。
 * 付ければ `value: null` で、`is_secret`・`edited_at` だけが読める。
 *
 * ## 届かなければ投げる
 *
 * 在るかを訊けなければ `WindmillUnreachable`。route は 503 にしてクロールを始めない —— Windmill に届かない
 * なら flow も動かないので、行を立てても締める仕事が増えるだけ。
 */
import { optional } from "../config/env.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface VariableMeta {
  isSecret: boolean;
  /** Windmill が答えた `edited_at`。答えに無ければ null。 */
  editedAt: string | null;
}

export interface WindmillVariables {
  exists(path: string): Promise<boolean>;
  /** 在れば secret かと更新時刻、無ければ undefined。値は読まない。 */
  meta(path: string): Promise<VariableMeta | undefined>;
}

/** Windmill に訊けなかった (届かない・時間切れ・2xx でも 404 でもない答え)。 */
export class WindmillUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindmillUnreachable";
  }
}

/**
 * webhook の URL から、Windmill の口の根と workspace を読む。`<base>/api/w/<workspace>/jobs/run/…` の形で
 * なければ undefined。export は試験のため。
 */
export const windmillApiOf = (
  webhookUrl: string,
): { base: string; workspace: string } | undefined => {
  const matched = /^(.+?)\/api\/w\/([^/]+)\/jobs\/run\//.exec(webhookUrl);
  if (matched === null) return undefined;
  return { base: matched[1]!, workspace: matched[2]! };
};

/** 口を直に渡して窓口を作る。`createWindmillVariables` と試験が使う。 */
export const windmillVariablesAt = ({
  base,
  workspace,
  token,
  timeoutMs,
}: {
  base: string;
  workspace: string;
  token: string;
  timeoutMs: number;
}): WindmillVariables => {
  const get = async (route: string): Promise<Response> => {
    const url = `${base}/api/w/${workspace}/variables/${route}`;
    try {
      return await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WindmillUnreachable(
        `GET ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const refused = async (route: string, res: Response): Promise<WindmillUnreachable> =>
    new WindmillUnreachable(
      `GET variables/${route} → ${String(res.status)} ${(await res.text()).slice(0, 200)}`,
    );

  return {
    async exists(path) {
      const route = `exists/${path}`;
      const res = await get(route);
      if (!res.ok) throw await refused(route, res);
      // 答えは素の JSON の真偽値 (実測)。それ以外は「無い」と読まず、形が違うとして投げる
      const body: unknown = await res.json();
      if (typeof body !== "boolean") {
        throw new WindmillUnreachable(`GET variables/${route} の答えが真偽値ではない`);
      }
      return body;
    },
    async meta(path) {
      const route = `get/${path}?decrypt_secret=false`;
      const res = await get(route);
      if (res.status === 404) return undefined;
      if (!res.ok) throw await refused(route, res);
      const body = (await res.json()) as { is_secret?: unknown; edited_at?: unknown };
      return {
        isSecret: body.is_secret === true,
        editedAt: typeof body.edited_at === "string" ? body.edited_at : null,
      };
    },
  };
};

/**
 * 設定を読んで窓口を作る。webhook の設定が無いか、URL が flow の webhook の形でなければ `undefined`
 * (`createWindmillDispatcher` と同じく、起動時に 1 回だけ読む)。
 */
export const createWindmillVariables = (): WindmillVariables | undefined => {
  const url = optional("CAPTURE_LEDGER_CRAWL_WEBHOOK_URL", "");
  const token = optional("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN", "");
  if (url === "" || token === "") return undefined;
  const api = windmillApiOf(url);
  if (api === undefined) return undefined;
  const timeoutMs = Number(
    optional("CAPTURE_LEDGER_CRAWL_WEBHOOK_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)),
  );
  return windmillVariablesAt({ ...api, token, timeoutMs });
};
