/**
 * 道具 (src/tools/) 用の環境変数の読み口と、生成した値の書き口。
 *
 * 読み口 (`optional`) は `src/config/read-env.ts` のものを、そのまま配る。src と同じ
 * 1 つの実装なので、「src では既定値、道具では空文字」という差は生まれない。
 *
 * 空文字を「無い」と同じに扱うのは POSIX の `${VAR:-word}` 側の意味。
 * `??` は `${VAR-word}` 側 (未設定のときだけ既定値) なので、ここでは使わない。
 *
 * 書き口 (`upsertEnvLocal`) が触るのは `.env.local` だけ。**`.env` は人のもので、
 * 機械は書かない** —— 道具が人の書いた行を並べ替えたり消したりすると、次に何が
 * 起きたのか追えなくなる。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./root.js";

export { optional } from "../config/read-env.js";

/**
 * 道具が読む環境変数。`guardEnv` の検査対象そのもの。
 *
 * どれも既定値を持つ。必須のものは無いので、required との区別は要らない。
 */
export const SCRIPT_ENV = [
  "CAPTURE_LEDGER_FGA_API_URL",
  "CAPTURE_LEDGER_FGA_API_TOKEN",
  "CAPTURE_LEDGER_FGA_STORE_NAME",
  "CAPTURE_LEDGER_FGA_IMAGE",
  "CAPTURE_LEDGER_FGA_DATASTORE_URI",
] as const;

/**
 * 「空で設定されている」変数を起動時に落とす。`src/config/env.ts` の同名の
 * 関数と対になっている。
 *
 * 空文字は無害ではない。既定値を持つ変数が空で設定されていると、読み口に
 * よっては既定値を失ったまま進み、ずっと後の無関係な場所で壊れる。
 * 行ごと消せば既定値が効くので、**空文字は「無い」より悪い**。
 *
 * module body で呼ぶこと。道具はどれもトップレベルで env を読むので、
 * 関数の中から呼ぶ形にすると間に合わない。
 */
export const guardEnv = () => {
  const blank = SCRIPT_ENV.filter((name) => process.env[name] === "");
  if (blank.length === 0) return;
  process.stderr.write(
    `空で設定されている環境変数:\n${blank.map((name) => `  - ${name}`).join("\n")}\n\n` +
      "  値を書くか、行ごと消すこと。空文字は既定値を潰します。\n" +
      "  .env.example では、生の空行を書いてよいのは必須の変数だけです。\n",
  );
  process.exit(1);
};

/**
 * 生成した値の置き場。**手で書くファイルではない**（手で書くのは `.env`）。
 *
 * node には `--env-file-if-exists=.env` の **後に** 渡してあるので、同じ名前が
 * 両方に在れば、こちらが勝つ（実測: 後に渡したほうが勝つ）。だから道具は
 * `.env` を書き換えずに値を渡せる —— 人の書いたファイルに機械が手を入れない。
 */
export const ENV_LOCAL = ".env.local";

const ENV_LOCAL_HEADER = `# capture-ledger の道具が書くファイル。**手で書かない**（手で書くのは .env）。
#
# node は --env-file-if-exists=.env の後にこれを読むので、名前が重なればこちらが勝つ。
# 書くのは pnpm run fga:deploy・connect・search:connect。消してよい —— どれも作り直せる。
`;

/**
 * `.env.local` に `名前=値` を書き足す（同じ名前が在れば、その行を置き換える）。
 *
 * 他の行は順番ごと保つ。生成物とはいえ複数の道具が書くので、ある道具がほかの道具の
 * 行を消してはいけない（`fga:deploy`・`connect`・`search:connect` は互いの値を知らない）。
 *
 * 書き換えるのは **この repo の中だけ**。他の repo の `.env` に書きに行く道具は
 * 作らない —— 走らせた repo の外が変わるのは予想に反する。
 */
export const upsertEnvLocal = (values: Record<string, string>) => {
  const path = resolve(ROOT, ENV_LOCAL);
  const before = existsSync(path) ? readFileSync(path, "utf8") : ENV_LOCAL_HEADER;
  const lines = before.split("\n");
  const added: string[] = [];
  const updated: string[] = [];

  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z_0-9]+$/.test(name)) throw new Error(`環境変数の名前として書けない: ${name}`);
    // 値の改行は、次の行を黙って別の変数に変えてしまう。名前ごと消える形なので落とす。
    if (/[\r\n]/.test(value)) throw new Error(`${name} の値に改行が入っている`);
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at === -1) {
      // 末尾の空行の前ではなく、中身の最後に足す。
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${name}=${value}`);
      added.push(name);
    } else {
      if (lines[at] !== `${name}=${value}`) updated.push(name);
      lines[at] = `${name}=${value}`;
    }
  }

  writeFileSync(path, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return { path, added, updated };
};
