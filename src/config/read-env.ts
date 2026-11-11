/**
 * 環境変数を読む関数。**import しても何も起きない。** env.ts は import されただけで
 * guardEnv が走るので、道具 (src/tools/) はこちらを読む。src は env.ts の re-export から読む。
 *
 * どちらも空文字を「無い」と同じに扱う。POSIX の `${VAR:-word}` 側の意味で、
 * `??` (`${VAR-word}` 側) は使わないこと —— この repo では読む関数をこちらに
 * 揃えてある。
 *
 * 名前を変えるなら `src/tools/check-env.ts` の PATTERNS も直すこと。あちらは読み取りを
 * この名前で探す。
 */
export const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
};

export const optional = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};
