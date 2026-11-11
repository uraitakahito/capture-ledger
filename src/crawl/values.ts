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
 *   `f/waggle_secrets/<名前>` に結ぶ。台帳は在るかを訊くだけで、値は flow の `crawl_host` が解く。値を WARC に
 *   残すかも宣言が決める (`archive: "keep"`。省けば BrowserHive が隠す)。
 *
 * ## 宣言が決める
 *
 * 宣言が「どの名前を、どちらの種類で、どの形で」を言う。変数の宣言の正は source の `defineParams` で、
 * ts-compile-service が読み、始めるエンドポイントがこの層へ写す (`pinDeclarations`)。シークレットの宣言は `params`。
 * **宣言の無い名前は渡せない** —— 黙って通すと、綴りを間違えた変数が「渡したのに効かない」として残る。
 * 例外は宣言を読めなかったスクリプト (BH0002) が混ざるときで、何を読むかを台帳が知らないので知らない名前を
 * 400 にしない。そのクロールは flow の compile の段が BH0002 で落とすので、理由がそこに残る。
 *
 * **必須の変数が渡されているかは、ここでは見ない。** 判定は ts-compile-service の 1 か所 (BH0001) で、始めるエンドポイントが
 * 行を立てる前に訊く。シークレットの `required` はここで集める (Windmill に在るかをエンドポイントが訊く)。
 *
 * **隠すシークレットと形式の組み合わせも、ここで見る** (`formatsRefusal`)。見るのは Windmill に訊いた後の、
 * 実際に送るシークレット。
 */
import type { CaptureFormats } from "../config/capture-formats.js";
import type { CrawlScript, CrawlSecret, ParamKind, ParamSchema } from "../db/database.js";
import { VALUES_MAX } from "../scripts/store.js";
import type { DeclaredScript } from "../scripts/ts-compile.js";

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
  /** 宣言したスクリプトの id (その場の TS は `inline-<名前>`)。 */
  declaredBy: string[];
  /** 値を WARC に残すなら `"keep"`。無ければ隠す。宣言どうしで食い違えば、ここまで来ない (conflicting params)。 */
  archive?: "keep";
}

export type ValuesCheck =
  { kind: "ok"; secrets: DeclaredSecret[] } | { kind: "refused"; body: Record<string, unknown> };

interface Declaration {
  kinds: Set<ParamKind>;
  /** 宣言された値の形。JSON の字で比べる (同じ名前を別の形で宣言していれば、どちらにも合う値が無いかもしれない)。 */
  schemas: Map<string, ParamSchema>;
  /**
   * 宣言された `archive` (省いた宣言は `"hide"`)。2 つ在れば、残すか隠すかを決められない —— 片方に倒すと、
   * 残すつもりの値が消えるか、隠すつもりの値が WARC に残る。
   */
  archives: Set<"keep" | "hide">;
  required: boolean;
  declaredBy: string[];
}

/**
 * compile の答えの宣言を、行に固定する写しへ写す。変数は source の宣言が正で、シークレットは元の写しのまま。
 */
export const pinDeclarations = (
  scripts: readonly CrawlScript[],
  declarations: readonly DeclaredScript[],
): CrawlScript[] =>
  scripts.map((script) => {
    const variables = declarations.find((declared) => declared.id === script.id)?.params ?? [];
    const secrets = (script.params ?? []).filter((param) => param.kind === "secret");
    // 宣言が無く元の写しにも無いなら、鍵ごと足さない (その場の TS の行の形を変えない)
    return script.params === undefined && variables.length === 0 && secrets.length === 0
      ? script
      : { ...script, params: [...variables, ...secrets] };
  });

/** 値が形に合わないなら、人に見せる文。JSON Schema の長さは code point で数える。 */
const shapeProblem = (name: string, value: string, schema: ParamSchema): string | undefined => {
  const length = [...value].length;
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return `${name} は ${schema.enum.join("・")} のどれか`;
  }
  if (schema.minLength !== undefined && length < schema.minLength) {
    return `${name} は ${String(schema.minLength)} 字以上`;
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    return `${name} は ${String(schema.maxLength)} 字まで`;
  }
  return undefined;
};

/**
 * 頼みの変数を宣言に照らし、宣言で結ぶシークレットを集める。
 *
 * 断る順: 同じ名前を別の種類か別の形か、残すかどうかを違えて宣言している (どちらにも渡せない) → シークレットの名前を
 * 変数で渡している (記録に値が残る) → 知らない変数の名前 (宣言を読めなかったスクリプトが在れば見ない) → 値が宣言の形に
 * 合わない → シークレットが多すぎる。文は route がそのまま 400 の本文にする。
 */
export const checkValues = (
  scripts: readonly CrawlScript[],
  variables: Readonly<Record<string, string>>,
  { unreadable = false }: { unreadable?: boolean } = {},
): ValuesCheck => {
  const declared = new Map<string, Declaration>();
  for (const script of scripts) {
    for (const param of script.params ?? []) {
      const entry = declared.get(param.name) ?? {
        kinds: new Set<ParamKind>(),
        schemas: new Map<string, ParamSchema>(),
        archives: new Set<"keep" | "hide">(),
        required: false,
        declaredBy: [],
      };
      entry.kinds.add(param.kind);
      if (param.schema !== undefined) entry.schemas.set(JSON.stringify(param.schema), param.schema);
      // 変数は archive を持てない (`readParams`) ので、いつも hide。種類の違いは kinds が先に言う
      entry.archives.add(param.archive ?? "hide");
      entry.required ||= param.required;
      entry.declaredBy.push(script.id);
      declared.set(param.name, entry);
    }
  }
  const names = [...declared.keys()].sort();
  const refuse = (body: Record<string, unknown>): ValuesCheck => ({ kind: "refused", body });

  const conflicting = names.filter((name) => {
    const { kinds, schemas, archives } = declared.get(name)!;
    return kinds.size > 1 || schemas.size > 1 || archives.size > 1;
  });
  if (conflicting.length > 0) return refuse({ error: "conflicting params", names: conflicting });

  const ofKind = (kind: ParamKind): string[] =>
    names.filter((name) => declared.get(name)!.kinds.has(kind));
  const given = Object.keys(variables).sort();

  const secretNames = new Set(ofKind("secret"));
  const asVariable = given.filter((name) => secretNames.has(name));
  if (asVariable.length > 0) {
    return refuse({ error: "secrets cannot be passed as variables", names: asVariable });
  }

  if (!unreadable) {
    const variableNames = new Set(ofKind("variable"));
    const unknown = given.filter((name) => !variableNames.has(name));
    if (unknown.length > 0) return refuse({ error: "unknown variables", names: unknown });
  }

  const misfits = given.flatMap((name) => {
    const [schema] = declared.get(name)?.schemas.values() ?? [];
    const problem =
      schema === undefined ? undefined : shapeProblem(name, variables[name] ?? "", schema);
    return problem === undefined ? [] : [{ name, problem }];
  });
  if (misfits.length > 0) {
    return refuse({
      error: "invalid variables",
      names: misfits.map(({ name }) => name),
      hint: misfits.map(({ problem }) => problem).join(" / "),
    });
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
      ...(declared.get(name)!.archives.has("keep") && { archive: "keep" as const }),
    })),
  };
};

/**
 * 隠すシークレットの値を置き換えられない形式。描いた物 (PNG・WebP) と、頁の字のまま持つ物 (HTML・MHTML)。
 * BrowserHive v29.0.0 は、隠す値のある要求にこれを 1 つでも頼まれると 400 で断る。
 */
export const FORMATS_WITHOUT_REPLACEMENT = ["png", "webp", "html", "mhtml"] as const;

/**
 * 実際に送るシークレットのうち隠す物 (`archive` が `keep` でない物) が在り、この配備の形式が値を置き換えられない物を
 * 頼むなら、400 の本文。**台帳が先に断る** —— 通すと、BrowserHive が取り込みのたびに 400 で断り、全ページが失敗した
 * クロールが残る。
 *
 * 見るのは宣言ではなく、Windmill に訊いた後の行の写し (`resolveSecrets` の答え)。任意で Windmill に無いシークレットは
 * 送られないので、断る理由にならない。web storage の値 (`storageValues`) は見ない: 台帳も flow も頼まず、BrowserHive の
 * 既定は無効 (配備の環境変数で有効にすると、BrowserHive の 400 になる)。
 */
export const formatsRefusal = (
  formats: Readonly<CaptureFormats>,
  secrets: Readonly<Record<string, CrawlSecret>>,
): Record<string, unknown> | undefined => {
  const hidden = Object.entries(secrets)
    .filter(([, secret]) => secret.archive !== "keep")
    .map(([name]) => name)
    .sort();
  const asked = FORMATS_WITHOUT_REPLACEMENT.filter((format) => formats[format]);
  if (hidden.length === 0 || asked.length === 0) return undefined;
  return {
    error: "formats that cannot hide secrets",
    formats: asked,
    names: hidden,
    hint:
      `CAPTURE_LEDGER_CAPTURE_FORMATS の ${asked.join("・")} は値を置き換えられない (BrowserHive が断る)。` +
      `形式から外すか、値を WARC に残すなら宣言に archive: "keep" と書く`,
  };
};
