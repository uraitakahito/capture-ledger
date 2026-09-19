/**
 * 撮る対象として足す URL を、コマンドの引数と標準入力から集める。
 *
 * **ここでは URL として読めるかを見ない。** それは `store.ts` が、クロールが種を読むのと
 * 同じ関数 (`parseHttpUrl`) で見る。ここで別の基準を持つと、足せた URL が撮るときに
 * 読めない、というずれが起きうる。ここがするのは、行に分けることと、重複を畳むことだけ。
 */

export type CollectResult = { kind: "ok"; urls: string[] } | { kind: "error"; message: string };

/**
 * 1 行 1 URL として読む。前後の空白を落とし、空行と `#` で始まる行は読み飛ばす。
 *
 * 改行は LF と CRLF のどちらでもよい —— 手元のファイルを流し込む道具なので、どこで
 * 書かれたファイルでも同じに読めるほうがよい。
 */
export const parseUrlLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

/**
 * 引数の並びから URL を集める。`-` は「標準入力から読む」の印。
 *
 * `-` と URL は混ぜられない —— どちらを先に足すかを、こちらが決めることになるので。
 * 同じ URL が 2 度出てきたら 1 つに畳み、最初に出た順を保つ。1 本も無ければ誤りにする。
 */
export const collectUrls = async (
  args: readonly string[],
  readStdin: () => Promise<string>,
): Promise<CollectResult> => {
  const fromStdin = args.includes("-");
  if (fromStdin && args.length > 1) {
    return {
      kind: "error",
      message: "`-` (標準入力) と URL は一緒に渡せない。どちらか一方にする",
    };
  }
  const lines = fromStdin ? parseUrlLines(await readStdin()) : args.map((arg) => arg.trim());
  const urls = [...new Set(lines.filter((line) => line !== ""))];
  if (urls.length === 0) {
    return {
      kind: "error",
      message: fromStdin ? "標準入力に URL が 1 本も無い" : "URL が 1 本も無い",
    };
  }
  return { kind: "ok", urls };
};

/** ストリームを最後まで読んで、文字列にする。 */
export const readAll = async (stream: NodeJS.ReadableStream): Promise<string> => {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return text;
};
