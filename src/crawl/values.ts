/**
 * クロールごとの値 (変数とシークレット) を、スクリプトの宣言に照らす。
 *
 * **入出力を持たない** (`compiled.ts` と同じ立場)。この repo に DB の試験は無いので、断る条件はここに置いて
 * 単体で見る (`test/crawl-values.test.ts`)。route (`POST /api/crawls`) はこの答えをそのまま status にし、
 * シークレットが Windmill に在るかだけを別に訊く。
 *
 * ## 2 種類の値
 *
 * - **変数** はクロールの頼み (`variables`) で渡され、記録に値が残る (WACZ の `settings.variables`)。
 * - **シークレット** は頼みに欄が無い。スクリプトが宣言した名前を、Windmill の secret 変数
 *   `f/waggle_secrets/<名前>` に結ぶ。台帳は在るかを訊くだけで、値は flow の `crawl_host` が解く。
 *
 * ## 宣言が決める
 *
 * スクリプトの `params` (`024`) が「どの名前を、どちらの種類で、必ず要るか」を言う。**宣言の無い名前は渡せない**
 * —— 黙って通すと、綴りを間違えた変数が「渡したのに効かない」として残る。例外は宣言の無いその場の JS
 * (`params` を添えなかった `inline`) が混ざるとき: 何を読むかを台帳が知らないので、知らない名前を 400 にしない。
 * `params: []` と添えた物は「何も読まない」の宣言で、例外にならない。
 *
 * `required` の既定は false。無ければ渡さず、スクリプトは `undefined` を読む (既定値はソースの中)。
 * `required: true` の物が無ければ 400。
 */
import type { CrawlScript, ParamKind } from "../db/database.js";
import { isInlineId, VALUES_MAX } from "../scripts/store.js";

/**
 * シークレットの置き場。Windmill のいちばん上のフォルダ (サブフォルダは権限を継がない)。capture-scheduler の
 * git (windmill/f/waggle_secrets/ の folder.meta.yaml) が作り、`crawl_host` はこの下の path しか解かない。
 */
export const SECRETS_FOLDER = "f/waggle_secrets/";

/** 宣言の名前から、Windmill の変数の path を組む。人は名前だけ書き、path は台帳が決める。 */
export const secretPath = (name: string): string => `${SECRETS_FOLDER}${name}`;

/** 宣言で結ぶシークレット 1 つ。名前順。 */
export interface DeclaredSecret {
  name: string;
  path: string;
  /** 宣言のどれか 1 つでも required なら true。 */
  required: boolean;
  /** 宣言したスクリプトの id (その場の JS は `inline-<名前>`)。 */
  declaredBy: string[];
}

export type ValuesCheck =
  { kind: "ok"; secrets: DeclaredSecret[] } | { kind: "refused"; body: Record<string, unknown> };

interface Declaration {
  kinds: Set<ParamKind>;
  required: boolean;
  declaredBy: string[];
}

/**
 * 頼みの変数を宣言に照らし、宣言で結ぶシークレットを集める。
 *
 * 断る順: 同じ名前を別の種類で宣言している (どちらにも渡せない) → required の変数が無い → シークレットの
 * 名前を変数で渡している (記録に値が残る) → 知らない変数の名前 (宣言の無いその場の JS が在れば見ない) →
 * シークレットが多すぎる。文は route がそのまま 400 の本文にする。
 */
export const checkValues = (
  scripts: readonly CrawlScript[],
  variables: Readonly<Record<string, string>>,
): ValuesCheck => {
  const declared = new Map<string, Declaration>();
  let undeclaredInline = false;
  for (const script of scripts) {
    if (script.params === undefined) {
      if (isInlineId(script.id)) undeclaredInline = true;
      continue;
    }
    for (const param of script.params) {
      const entry = declared.get(param.name) ?? {
        kinds: new Set<ParamKind>(),
        required: false,
        declaredBy: [],
      };
      entry.kinds.add(param.kind);
      entry.required ||= param.required;
      entry.declaredBy.push(script.id);
      declared.set(param.name, entry);
    }
  }
  const names = [...declared.keys()].sort();
  const refuse = (body: Record<string, unknown>): ValuesCheck => ({ kind: "refused", body });

  const conflicting = names.filter((name) => declared.get(name)!.kinds.size > 1);
  if (conflicting.length > 0) return refuse({ error: "conflicting params", names: conflicting });

  const ofKind = (kind: ParamKind): string[] =>
    names.filter((name) => declared.get(name)!.kinds.has(kind));
  const given = Object.keys(variables).sort();

  const missing = ofKind("variable").filter(
    (name) => declared.get(name)!.required && !(name in variables),
  );
  if (missing.length > 0) return refuse({ error: "missing variables", names: missing });

  const secretNames = new Set(ofKind("secret"));
  const asVariable = given.filter((name) => secretNames.has(name));
  if (asVariable.length > 0) {
    return refuse({ error: "secrets cannot be passed as variables", names: asVariable });
  }

  if (!undeclaredInline) {
    const variableNames = new Set(ofKind("variable"));
    const unknown = given.filter((name) => !variableNames.has(name));
    if (unknown.length > 0) return refuse({ error: "unknown variables", names: unknown });
  }

  if (secretNames.size > VALUES_MAX) {
    return refuse({ error: "too many secrets", count: secretNames.size, max: VALUES_MAX });
  }

  return {
    kind: "ok",
    secrets: [...secretNames].map((name) => ({
      name,
      path: secretPath(name),
      required: declared.get(name)!.required,
      declaredBy: declared.get(name)!.declaredBy,
    })),
  };
};
