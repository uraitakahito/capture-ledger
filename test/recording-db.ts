/**
 * DB を立てずに、Kysely が **実際に組んだ** SQL を記録する代役。
 *
 * 手書きの代役 (`routes-crawls.test.ts` の fakeDb) は Kysely の鎖を真似るので、列の名前を
 * 間違えても、絞り込みを書き忘れても緑のまま —— 経路しか見ていない。こちらは本物の
 * Kysely (と、`createKyselyClient` と同じ CamelCasePlugin) に SQL を組ませ、実行の直前で
 * 取り上げる。Postgres は要らない。
 *
 * 返す行は、問い合わせが来た順に `results` から 1 つずつ取る (尽きたら空)。`begin` /
 * `commit` / `rollback` も記録するので、トランザクションの境目も見える。
 *
 * 見られないもの: 制約 (NOT NULL・CHECK・ユニーク) と、SQL が Postgres で本当に通るか。
 * それは CI の Postgres に当てる検査の仕事。
 */
import {
  CamelCasePlugin,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type { Database } from "../src/db/database.js";

export interface RecordedQuery {
  sql: string;
  parameters: readonly unknown[];
}

export const recordingDb = (
  results: readonly (readonly object[])[] = [],
): { db: Kysely<Database>; queries: RecordedQuery[] } => {
  const queries: RecordedQuery[] = [];
  const pending = [...results];

  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      // 代役なので、返す行の形は呼ぶ側の申告どおりに扱う。
      return Promise.resolve({ rows: [...(pending.shift() ?? [])] as unknown as R[] });
    },
    streamQuery(): AsyncIterableIterator<never> {
      throw new Error("recordingDb は streamQuery に対応していない");
    },
  };
  const mark = (sql: string) => (): Promise<void> => {
    queries.push({ sql, parameters: [] });
    return Promise.resolve();
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: mark("begin"),
    commitTransaction: mark("commit"),
    rollbackTransaction: mark("rollback"),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
  return { db, queries };
};
