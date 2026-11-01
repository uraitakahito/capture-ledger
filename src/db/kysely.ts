/**
 * Kysely の client を作る。
 *
 * `DATABASE_URL` の接続文字列から作った `pg.Pool` を、Kysely の
 * `PostgresDialect` と `CamelCasePlugin` で包む。plugin が TS 側の camelCase の
 * 識別子 (`urlHash`、`createdAt`) を DB 側の snake_case (`url_hash`、
 * `created_at`) へ写す。
 *
 * クエリのログは、`module: "kysely"` を binding した child logger として
 * このプロジェクトの pino に橋渡しする。エラーは常に出し、成功したクエリは
 * root logger が `debug` 以下のときだけ出す。
 *
 * 返す client は下にある pool を所有する —— pool を終わらせるには client の
 * `.destroy()` を呼ぶこと (migrator-runner がそうしている)。呼ぶ側が別途
 * `pool.end()` を呼んではいけない。
 */
import pg from "pg";
import type { LogEvent } from "kysely";
import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import { createChildLogger } from "../logger.js";
import type { Database } from "./database.js";

const kyselyLogger = createChildLogger({ module: "kysely" });

const kyselyLog = (event: LogEvent): void => {
  if (event.level === "error") {
    kyselyLogger.error(
      { sql: event.query.sql, durationMs: event.queryDurationMillis, err: event.error },
      "Query error",
    );
  } else if (kyselyLogger.isLevelEnabled("debug")) {
    kyselyLogger.debug(
      { sql: event.query.sql, durationMs: event.queryDurationMillis },
      "Query executed",
    );
  }
};

/**
 * 列名を写す plugin。**jsonb の中の鍵は写さない** (`maintainNestedObjectKeys`)。
 *
 * 既定の plugin は結果の object を再帰的に辿り、入れ子の鍵まで camelCase に直す。列名のための仕組みが
 * データの鍵に及ぶと、`crawls.variables` と `crawls.secrets` の鍵 (スクリプトが宣言した名前。`api_token` の
 * ように `_` を含む) が `apiToken` に化けて、スクリプトが読む名前と食い違う (試験の代役で実測)。
 * `scripts.options` の鍵 (運用で付けた設定) も同じ。この repo が jsonb に書く鍵は、自分で付けた物
 * (camelCase) と、利用者が付けた物 (そのまま返すべき物) の 2 種類しか無いので、写す理由が無い。
 *
 * 試験の代役 (test/recording-db.ts) も同じ plugin を使うこと —— 違うと、代役では通る鍵が本物で化ける。
 */
export const columnNamePlugin = (): CamelCasePlugin =>
  new CamelCasePlugin({ maintainNestedObjectKeys: true });

export const createKyselyClient = (databaseUrl: string): Kysely<Database> => {
  const dialect = new PostgresDialect({
    pool: new pg.Pool({ connectionString: databaseUrl }),
  });
  return new Kysely<Database>({
    dialect,
    plugins: [columnNamePlugin()],
    log: kyselyLog,
  });
};
