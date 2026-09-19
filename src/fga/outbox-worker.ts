/**
 * `fga_outbox` に積まれた関係の tuple を OpenFGA へ配送する。
 *
 * at-least-once: 行は OpenFGA が受け入れるまで残り、重複した書き込みは成功として
 * 扱う。もう一方の道 —— 送信時に消す —— では、書き込みと更新の間にプロセスが
 * 死ぬたびに tuple を落とすことになる。そして欠けた tuple は、誰かが不当に
 * 拒まれるまで目に見えない。
 *
 * `FOR UPDATE SKIP LOCKED` のおかげで、掃き出しは同時に何本走ってもよい (タイマーで
 * 動く API プロセスと、手で叩く `capture-ledger fga:drain`)。同じ行を 2 度処理することも、
 * 互いを待たせることもない。
 */
import { sql, type Kysely } from "kysely";
import type { OpenFgaClient } from "@openfga/sdk";
import type { Database } from "../db/database.js";
import { isAlreadyInDesiredState, isUnreachable } from "./client.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "fga-outbox" });

/** OpenFGA は 1 回の書き込みを 100 tuple までに制限する。ここの batch はずっと小さい。 */
const DEFAULT_BATCH_SIZE = 100;

export interface DrainResult {
  delivered: number;
  failed: number;
  /**
   * OpenFGA に届かずに途中で止めたときの、その誤りの文。届いていれば無い。
   *
   * 届かない間は、残りの行を試しても同じ誤りが並ぶだけなので、最初の 1 行で止める ——
   * 以前は batch の全行 (最大 100) が、それぞれ stack trace つきで失敗を記録していた。
   * 止めた後ろの行は attempts を増やさず、次の掃き出しでそのまま拾われる。
   */
  unreachable?: string;
}

interface TupleKey {
  user: string;
  relation: string;
  object: string;
}

interface WritePayload {
  writes?: TupleKey[];
  deletes?: TupleKey[];
}

const isTupleKey = (value: unknown): value is TupleKey =>
  typeof value === "object" &&
  value !== null &&
  ["user", "relation", "object"].every(
    (field) => typeof (value as Record<string, unknown>)[field] === "string",
  );

const isTupleKeys = (value: unknown): value is TupleKey[] =>
  Array.isArray(value) && value.every(isTupleKey);

/**
 * outbox の 1 行の payload を解析する。
 *
 * 中身は自分で書いた JSONB だが、書いた時期と読む時期は同じとは限らない ——
 * 形を変えた配備をまたいで残っている行は、`as` で名乗らせると型が嘘になる。
 *
 * 投げるのは呼ぶ側の try の中。**1 行の失敗で batch 全体を落としてはいけない**
 * ので、既存の「その行だけ attempts を増やして lastError を残す」経路に乗せる。
 */
const parseWritePayload = (raw: unknown): WritePayload => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`outbox payload is not an object: ${typeof raw}`);
  }
  const { writes, deletes } = raw as { writes?: unknown; deletes?: unknown };
  if (writes !== undefined && !isTupleKeys(writes)) {
    throw new Error("outbox payload has a malformed `writes`");
  }
  if (deletes !== undefined && !isTupleKeys(deletes)) {
    throw new Error("outbox payload has a malformed `deletes`");
  }
  return { ...(writes && { writes }), ...(deletes && { deletes }) };
};

/**
 * outbox の 1 行分の tuple を配送する。既に在るものは許容する。
 *
 * これが `fga.write(payload)` 以上のものになっている理由: **OpenFGA の書き込みは
 * batch 全体でトランザクショナル**。中の tuple が 1 つでも既に存在すると
 * リクエスト全体が拒まれ、何も書かれない —— 新しかった tuple も含めて。だから
 * その拒否を「配送済み」と扱うと、新しいほうを黙って落とすことになり、その損失は
 * 誰かが不当に拒まれるまで目に見えない。
 *
 * これは机上の話ではない: 新しい `archive` の tuple の隣に、以前の行から来た
 * `organization → capture_job` の tuple が並んだ行は毎回これに当たる。再登録された
 * アーカイブがまさにその形を作る。
 *
 * なので: まず batch を試し (1 リクエスト・原子的・これが普通の場合)、既に在る
 * ことが **原因で** 失敗したときに限り、1 tuple ずつ再試行して新しいほうを入れる。
 * それ以外の失敗は伝播させ、その行は丸ごと再試行になる。
 */
const writePayload = async (fga: OpenFgaClient, payload: WritePayload): Promise<void> => {
  try {
    await fga.write(payload);
    return;
  } catch (cause) {
    if (!isAlreadyInDesiredState(cause)) throw cause;
  }

  for (const tuple of payload.writes ?? []) {
    try {
      await fga.write({ writes: [tuple] });
    } catch (cause) {
      if (!isAlreadyInDesiredState(cause)) throw cause;
      log.debug({ tuple }, "Tuple already present; skipping");
    }
  }
  for (const tuple of payload.deletes ?? []) {
    try {
      await fga.write({ deletes: [tuple] });
    } catch (cause) {
      // 存在しない tuple を消そうとしたときも同じ種類のエラーになり、
      // 同じく「既に望む状態」である。
      if (!isAlreadyInDesiredState(cause)) throw cause;
      log.debug({ tuple }, "Tuple already absent; skipping");
    }
  }
};

export const drainOutbox = async (
  db: Kysely<Database>,
  fga: OpenFgaClient,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<DrainResult> => {
  let delivered = 0;
  let failed = 0;
  let unreachable: string | undefined;

  // batch 全体を 1 つのトランザクションの中で走らせる。SKIP LOCKED が取った行の
  // ロックを、その行を扱っている間ずっと保つため。
  await db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("fgaOutbox")
      .select(["id", "payload", "attempts"])
      .where("processedAt", "is", null)
      .orderBy("id")
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();

    for (const row of rows) {
      try {
        await writePayload(fga, parseWritePayload(row.payload));
      } catch (cause) {
        failed += 1;
        await trx
          .updateTable("fgaOutbox")
          .set({
            attempts: row.attempts + 1,
            lastError: cause instanceof Error ? cause.message : String(cause),
          })
          .where("id", "=", row.id)
          .execute();
        // processedAt は null のままにする: その行は次の掃き出しでまた拾われる。
        if (isUnreachable(cause)) {
          unreachable = cause.message;
          log.error(
            { outboxId: row.id, attempts: row.attempts + 1, reason: cause.message },
            "OpenFGA unreachable; stopping this drain",
          );
          break;
        }
        log.error(
          { outboxId: row.id, attempts: row.attempts + 1, err: cause },
          "Outbox delivery failed; will retry",
        );
        continue;
      }

      await trx
        .updateTable("fgaOutbox")
        .set({ processedAt: sql<string>`now()` })
        .where("id", "=", row.id)
        .execute();
      delivered += 1;
    }
  });

  if (delivered > 0 || failed > 0) {
    log.info({ delivered, failed }, "Outbox drained");
  }
  return { delivered, failed, ...(unreachable !== undefined && { unreachable }) };
};
