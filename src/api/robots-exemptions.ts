/**
 * robots.txt の例外のエンドポイント (`046`・t-6bc6)。登録した行は、次に起こす段からクロールに効く
 * (`exemptions/dispatch.ts`・`047`)。取り消しも同じ —— もう起こした段には効かない。
 *
 * | エンドポイント | 誰が | 返すもの |
 * | --- | --- | --- |
 * | `GET /api/robots-exemptions` | 名乗りの組織のうち、始めてよい (`can_submit`) 組織の者 | その組織の行 (効いている・切れた・取り消した) と、行ごとの 24 時間で外した枚数 |
 * | `POST /api/robots-exemptions` | 本文の `orgId` の admin (人だけ) | 登録した行 (201) |
 * | `POST /api/robots-exemptions/:id/revoke` | その行の組織の admin (人だけ) | 取り消した行 (200) |
 *
 * 取り消しも POST にする (capture-workbench の中継の書き込みは POST だけ。`api/schedules.ts` と同じ)。
 *
 * ## 登録と取り消しは、人の admin だけ
 *
 * 行は「robots.txt が断っていても撮る」を許す。だから `can_submit` (始めてよい者) より狭く、組織の関係 `admin` を
 * 直に訊く (`isOrganizationAdmin`。保存された tuple だけで決まる)。さらに 2 つを、admin を訊く前に断る。
 *
 *   - **機械の主体** (client credentials のトークン): 例外を足すのは人の判断で、道具に任せない。狭い scope
 *     (`crawl.start`) は門 (`api/scope.ts`) が先に断り、ここは広い scope の機械を断る
 *   - **ヘッダで名乗る経路** (`CAPTURE_LEDGER_DEV_IDENTITY=1`): 主体そのものが呼び手の申告で、そのポートに届く者は
 *     admin の主体を名乗れる。admin の検査が申告で満たせてしまう。名乗りの経路は `server.ts` が deps で渡す
 *
 * 断りの 403 は、訳を決まった句で返す (名乗りは通っているので、何が足りないかを言ってよい。画面が句を訳す)。
 *
 * ## 在ることを漏らさない
 *
 * 取り消しで、呼び手の名乗りの組織に無い行は 404 (無い行と同じ答え)。自分の組織の行で admin でない時だけ 403。
 *
 * ## 本文の検査
 *
 * schema は欄の型と知らない鍵だけを見て、`required` を書かない (`CRAWL_BODY_SCHEMA` と同じ訳: schema の検査は
 * 名乗りより先に走るので、書くと名乗らない `{}` が 401 でなく 400 になる)。中身は名乗りと admin を見た後に
 * `checkExemption` が見て、欄の名前と訳を返す。
 */
import type { OpenFgaClient } from "@openfga/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Database } from "../db/database.js";
import {
  createExemption,
  exemptionState,
  getExemption,
  listExemptions,
  revokeExemption,
  type ExemptionRow,
} from "../exemptions/store.js";
import { checkExemption, type ExemptionRequest } from "../exemptions/validate.js";
import { createChildLogger } from "../logger.js";
import { isOrganizationAdmin, submittableOrganizations, unauthorized } from "./authorization.js";
import type { Identity, IdentityResolver } from "./identity.js";

const log = createChildLogger({ module: "api" });

export interface RobotsExemptionsRouteDeps {
  db: Kysely<Database>;
  fga: OpenFgaClient;
  resolveIdentity: IdentityResolver;
  /** どの名乗り方で起きたか (`selectIdentity` の `mode`)。ヘッダの経路では、登録と取り消しを断る。 */
  identityMode: "jwt" | "header" | "deny";
  now: () => Date;
}

interface CreateBody extends ExemptionRequest {
  orgId?: string;
}

/** 断りの句。capture-workbench が訳す鍵にするので、字を変える時は向こうの訳の表と揃える。 */
const MACHINE = { error: "machine identities cannot manage robots exemptions" } as const;
const HEADER = { error: "robots exemptions are not available with header identities" } as const;
const NOT_ADMIN = { error: "not an organization admin" } as const;

/** 行 1 つの答え。一覧・登録・取り消しで同じ形にする。 */
const answerOf = (row: ExemptionRow, now: Date) => ({
  id: row.id,
  orgId: row.orgId,
  host: row.host,
  pathPattern: row.pathPattern,
  scope: row.scope,
  appliesTo: row.appliesTo,
  userAgent: row.userAgent,
  reason: row.reason,
  dailyLimit: row.dailyLimit,
  linkLimit: row.linkLimit,
  createdBy: row.createdBy,
  createdByName: row.createdByName,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  revokedBy: row.revokedBy,
  revokedByName: row.revokedByName,
  state: exemptionState(row, now),
});

export const registerRobotsExemptionsRoute = (
  app: FastifyInstance,
  deps: RobotsExemptionsRouteDeps,
): void => {
  const { db, fga, resolveIdentity, identityMode } = deps;

  /**
   * 書き込みの手前の 3 つ: 名乗り (401)・機械の主体 (403)・ヘッダの経路 (403)。通らなければ答えを送って null を返す。
   * admin は、組織が決まってから呼ぶ側が訊く (登録は本文の組織、取り消しは行の組織)。
   */
  const human = async (request: FastifyRequest, reply: FastifyReply): Promise<Identity | null> => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      await unauthorized(reply);
      return null;
    }
    if (identity.machine === true) {
      await reply.code(403).send(MACHINE);
      return null;
    }
    if (identityMode !== "jwt") {
      await reply.code(403).send(HEADER);
      return null;
    }
    return identity;
  };

  /** 呼び手が始めてよい組織の行だけ。そういう組織が無ければ 200 の空 (`GET /api/schedules` と同じ答え方)。 */
  app.get("/api/robots-exemptions", async (request, reply) => {
    const identity = await resolveIdentity(request);
    if (!identity) return unauthorized(reply);

    const now = deps.now();
    const rows = await listExemptions(db, await submittableOrganizations(fga, identity), now);
    return reply.code(200).send({
      // `usedLast24h` は、この行で 24 時間の内に robots.txt を外した頁の数 (`daily_limit` と比べる数。外して撮りに行き、
      // 撮れなかった頁も含む)。一覧だけが持つ
      exemptions: rows.map((row) => ({ ...answerOf(row, now), usedLast24h: row.usedLast24h })),
    });
  });

  app.post<{ Body: CreateBody }>(
    "/api/robots-exemptions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            orgId: { type: "string" },
            host: { type: "string" },
            pathPattern: { type: "string" },
            scope: { type: "string" },
            appliesTo: { type: "string" },
            userAgent: { type: "string" },
            reason: { type: "string" },
            expiresAt: { type: "string" },
            dailyLimit: { type: "integer" },
            linkLimit: { type: "integer" },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = await human(request, reply);
      if (identity === null) return reply;

      // 組織は本文で名指させる (名乗りの 1 つ目に頼らない)。名乗りに無い組織は、admin を訊かずに同じ句で断る
      const { orgId = "", ...fields } = request.body;
      if (!identity.organizations.includes(orgId)) return reply.code(403).send(NOT_ADMIN);
      if (!(await isOrganizationAdmin(fga, identity.subject, orgId))) {
        return reply.code(403).send(NOT_ADMIN);
      }

      const now = deps.now();
      const checked = checkExemption(fields, now);
      if (checked.kind === "invalid") {
        return reply.code(400).send({ error: checked.problem, field: checked.field });
      }

      const created = await createExemption(
        db,
        {
          orgId,
          ...checked.exemption,
          createdBy: identity.subject,
          // 名は表示の物で、無いことがある (`config/identity.ts`)。無い人の登録も受け、null のまま残す。
          // WACZ の申告の `grantedBy` (1 字以上) は、名が無ければ主体の ID (`created_by`) を書く (`exemptions/dispatch.ts`)。
          ...(identity.name !== undefined && { createdByName: identity.name }),
        },
        now,
      );
      if (created.kind === "overlap") {
        return reply.code(409).send({
          error: "an active robots exemption already covers this host and path pattern",
          id: created.id,
        });
      }
      if (created.kind === "user-agent-mismatch") {
        return reply.code(409).send({
          error: "active robots exemptions for this host use a different user agent",
          userAgent: created.userAgent,
        });
      }
      log.info(
        {
          subject: identity.subject,
          exemptionId: created.row.id,
          orgId,
          host: created.row.host,
          pathPattern: created.row.pathPattern,
        },
        "Robots exemption created",
      );
      return reply.code(201).send(answerOf(created.row, now));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/robots-exemptions/:id/revoke",
    {
      schema: {
        params: {
          type: "object",
          // bigint の連番。18 桁までにして、列の型に収まらない数を SQL まで運ばない
          properties: { id: { type: "string", pattern: "^[1-9][0-9]{0,17}$" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const identity = await human(request, reply);
      if (identity === null) return reply;

      const notFound = () => reply.code(404).send({ error: "not found" });
      const current = await getExemption(db, request.params.id);
      // 名乗りの組織に無い行は、無い行と同じ答え (在ることを漏らさない)
      if (current === undefined || !identity.organizations.includes(current.orgId)) {
        return notFound();
      }
      if (!(await isOrganizationAdmin(fga, identity.subject, current.orgId))) {
        return reply.code(403).send(NOT_ADMIN);
      }

      const now = deps.now();
      const revoked = await revokeExemption(
        db,
        current.id,
        { subject: identity.subject, ...(identity.name !== undefined && { name: identity.name }) },
        now,
      );
      if (revoked.kind === "not-found") return notFound();
      if (revoked.kind === "already-revoked") {
        return reply.code(409).send({ error: "robots exemption is already revoked" });
      }
      if (revoked.kind === "expired") {
        return reply.code(409).send({ error: "robots exemption has already expired" });
      }
      log.info(
        { subject: identity.subject, exemptionId: revoked.row.id, orgId: revoked.row.orgId },
        "Robots exemption revoked",
      );
      return reply.code(200).send(answerOf(revoked.row, now));
    },
  );
};
