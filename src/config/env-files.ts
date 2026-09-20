/**
 * 値がどのファイルから来たのか。**起動の 1 行目に言う。**
 *
 * 実行系の script は `.env` と `.env.local` を **この順で** node に渡している
 * (`--env-file-if-exists` を 2 つ)。後に渡したほうが勝つので、同じ名前が両方に
 * 在れば `.env.local` の値が効く。分けてあるのは、`.env` を人のものにして、
 * 道具 (`pnpm run fga:deploy` と `pnpm run connect`) には生成物だけを書かせるため。
 *
 * 分けた以上、**重なりは黙ってはいけない**。`.env` を直したのに値が変わらない、
 * という形の詰まりは、直した場所が負けていると分からないまま時間が溶ける。
 * 起動時に「どちらが勝っているか」を名前で言えば、その往復は起きない。
 *
 * **名前しか見ない。値は読まない。** 出どころの説明に値は要らないし、ログに値が
 * 出れば、それは鍵がログに出るということ。node が実際に何を入れたかも見ない ——
 * 端末で渡した値は両方に勝つので、ここの表は「ファイルどうしの勝ち負け」に限る
 * (そのことは添え書きで言う)。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * node に渡してある順そのもの。**package.json の実行系 script と同じ並びで
 * なければならない** —— 逆に書くと、この行は勝ち負けを逆さまに報告する。
 */
export const ENV_FILES = [".env", ".env.local"] as const;

export interface EnvFileFacts {
  file: string;
  exists: boolean;
  /** そのファイルが宣言している名前。コメント行は数えない (node も読まない)。 */
  names: string[];
}

/**
 * `KEY=` の形で始まる行の名前。`.env.example` の検査 (`scripts/check-env.mjs`) と
 * 同じ読み方に揃えてある。
 */
const declaredNames = (source: string): string[] =>
  source
    .split("\n")
    .flatMap((line) => /^\s*(?:export\s+)?([A-Z_0-9]+)\s*=/.exec(line)?.slice(1, 2) ?? []);

/**
 * cwd から見た 2 枚を読む。**cwd を使うのは node に合わせるため** ——
 * `--env-file-if-exists` の相対パスも cwd から解かれるので、ここだけ repo の
 * root を基準にすると、別の場所から起こしたときに食い違う。
 */
export const readEnvFiles = (cwd: string = process.cwd()): EnvFileFacts[] =>
  ENV_FILES.map((file) => {
    const path = resolve(cwd, file);
    if (!existsSync(path)) return { file, exists: false, names: [] };
    return { file, exists: true, names: declaredNames(readFileSync(path, "utf8")) };
  });

/**
 * 起動時に出す 1 行。**在るファイルと、重なって勝った名前だけを言う。**
 */
export const envFilesNote = (files: EnvFileFacts[]): string => {
  const present = files.filter((f) => f.exists);
  if (present.length === 0) {
    return "config: no env file was read — every value comes from the shell";
  }
  const listed = present
    .map((f) => `${f.file} (${String(f.names.length)} name${f.names.length === 1 ? "" : "s"})`)
    .join(", ");
  // 勝ち負けは並びの後ろから決まる。**別のファイル** が後から宣言したときだけ数える ——
  // 同じファイルの中の重複も後勝ちだが、それは出どころの話ではない。
  const declaredIn = new Map<string, string>();
  const overridden = new Map<string, string>();
  for (const file of present) {
    for (const name of file.names) {
      const previous = declaredIn.get(name);
      if (previous !== undefined && previous !== file.file) overridden.set(name, file.file);
      declaredIn.set(name, file.file);
    }
  }
  if (overridden.size === 0) return `config: ${listed}`;
  const winners = [...new Set(overridden.values())].join(", ");
  return (
    `config: ${listed} — ${winners} wins for ${[...overridden.keys()].join(", ")}` +
    " (a value set in the shell beats the files)"
  );
};
