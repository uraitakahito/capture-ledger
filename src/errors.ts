/**
 * 文だけで次の一手が分かるように書いた誤り。
 *
 * `fatal` (`logger.ts`) はこれを JSON の stack trace ではなく、文のまま出す。
 * 設定の欠け (`MissingEnvError`) と、届かない相手 (`FgaUnreachableError`) に使う ——
 * どちらも、stack trace を読ませても直し方には近づかない。
 */
export class ExplainedError extends Error {}
