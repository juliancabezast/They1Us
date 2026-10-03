import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db";
import {
  APPROVAL_TTL_MINUTES,
  CATALOG,
  POLICY_VERSION,
  ParamError,
  decide,
  labelsIntroduced,
  stateFingerprint,
  type ContextState,
  type Decision,
  type LabelRow,
  type Operation,
  type ReasonCode,
} from "./policy";

/** Built by the server from its own knowledge of the caller. Never parsed from agent input. */
export type AuthContext =
  | { role: "agent"; sessionId: string }
  | { role: "operator"; operatorId: string };

export interface GatewayResult {
  decision: Decision;
  reason: ReasonCode;
  correlationId: string;
  rows: Record<string, unknown>[];
  executionResult: string | null;
  approvalId?: string;
}

interface ContextRow {
  id: string;
  mode: "protected" | "sandbox";
  run_id: string;
  has_untrusted: boolean;
  has_secret: boolean;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** What is safe to keep in the audit trail: free text becomes a hash and a length. */
export function redact(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = k === "content" && typeof v === "string" ? { sha256: sha256(v), length: v.length } : v;
  }
  return out;
}

interface EventInput {
  correlationId: string;
  contextId: string | null;
  sessionId: string | null;
  actor: string;
  operation: string;
  decision: Decision;
  reason: ReasonCode;
  labels?: string[];
  before?: ContextState | null;
  after?: ContextState | null;
  durationMs?: number | null;
  executionResult?: string | null;
  params?: Record<string, unknown>;
}

export async function writeEvent(db: Pick<PoolClient, "query">, e: EventInput) {
  await db.query(
    `insert into tb_events (correlation_id, context_id, session_id, actor, operation, decision, reason_code,
                            labels, state_before, state_after, policy_version, duration_ms, execution_result, params)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      e.correlationId,
      e.contextId,
      e.sessionId,
      e.actor,
      e.operation.slice(0, 80),
      e.decision,
      e.reason,
      e.labels ?? [],
      e.before ? JSON.stringify(e.before) : null,
      e.after ? JSON.stringify(e.after) : null,
      POLICY_VERSION,
      e.durationMs ?? null,
      e.executionResult ?? null,
      JSON.stringify(e.params ?? {}),
    ],
  );
}

/** Only an operator can open a context. An agent cannot mint itself a clean one. */
export async function createContext(auth: AuthContext, input: { mode: "protected" | "sandbox"; kind: string; runId: string }) {
  if (auth.role !== "operator") throw new Error("only an operator can create a context");
  const ctx = await pool.query(
    `insert into tb_contexts (principal, mode, kind, run_id) values ('agent:demo', $1, $2, $3) returning id`,
    [input.mode, input.kind, input.runId],
  );
  const contextId: string = ctx.rows[0].id;
  return { contextId, sessionId: await createSession(contextId) };
}

/** A reconnect or sub-run gets a new handle onto the same context, labels included. */
export async function createSession(contextId: string): Promise<string> {
  const res = await pool.query(`insert into tb_sessions (context_id) values ($1) returning id`, [contextId]);
  return res.rows[0].id;
}

async function loadContext(client: PoolClient, sessionId: string): Promise<ContextRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;
  // The row lock is the mutual exclusion: concurrent requests on one context
  // are evaluated one at a time, each against the labels the previous one left.
  const res = await client.query(
    `select c.id, c.mode, c.run_id, c.has_untrusted, c.has_secret
       from tb_sessions s join tb_contexts c on c.id = s.context_id
      where s.id = $1 for update of c`,
    [sessionId],
  );
  return res.rows[0] ?? null;
}

async function destinationOf(client: PoolClient, ctx: ContextRow, ticketId: unknown): Promise<string | null> {
  const res = await client.query(`select customer_email from support_tickets where run_id = $1 and id = $2`, [
    ctx.run_id,
    ticketId,
  ]);
  return res.rowCount ? `ticket #${ticketId} → ${res.rows[0].customer_email}` : null;
}

/** Runs the operation's fixed statement as the least-privilege executor role. */
export async function runOperation(client: PoolClient, op: Operation, runId: string, params: Record<string, string | number>) {
  await client.query("SET LOCAL ROLE tb_executor");
  try {
    return await client.query(op.sql, op.values(runId, params));
  } finally {
    await client.query("RESET ROLE").catch(() => {});
  }
}

/**
 * The only way the agent reaches the database: a catalog operation id and
 * parameters. Authorize, decide on the resulting state, execute, and persist
 * state and audit in the same transaction before anything is returned.
 */
export async function guardedExecute(auth: AuthContext, operationId: string, rawParams: unknown): Promise<GatewayResult> {
  const correlationId = randomUUID();
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) * 100) / 100;
  const sessionId = auth.role === "agent" ? auth.sessionId : null;
  const client = await pool.connect();
  let ctx: ContextRow | null = null;

  const result = (decision: Decision, reason: ReasonCode, extra: Partial<GatewayResult> = {}): GatewayResult => ({
    decision,
    reason,
    correlationId,
    rows: [],
    executionResult: null,
    ...extra,
  });

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '8s'");
    const base = { correlationId, sessionId, actor: auth.role, operation: String(operationId) };

    const refuse = async (reason: ReasonCode, params: Record<string, unknown> = {}) => {
      const state = ctx ? { untrusted: ctx.has_untrusted, secret: ctx.has_secret } : null;
      await writeEvent(client, {
        ...base,
        contextId: ctx?.id ?? null,
        decision: "DENIED",
        reason,
        before: state,
        after: state,
        durationMs: elapsed(),
        params,
      });
      await client.query("COMMIT");
      return result("DENIED", reason);
    };

    if (auth.role !== "agent") return await refuse("NOT_AN_AGENT");
    ctx = await loadContext(client, auth.sessionId);
    if (!ctx) return await refuse("UNKNOWN_SESSION");
    if (ctx.mode !== "protected") return await refuse("WRONG_MODE");

    const op = CATALOG.get(operationId);
    if (!op) return await refuse("UNKNOWN_OPERATION");

    let params: Record<string, string | number>;
    try {
      params = op.parse(rawParams);
    } catch (err) {
      if (err instanceof ParamError) return await refuse("INVALID_PARAMS");
      throw err;
    }
    const safeParams = redact(params);

    const labels: LabelRow[] = (await client.query(`select table_name, column_name, label from tb_column_labels`)).rows;
    const introduced = labelsIntroduced(op, labels);
    const before: ContextState = { untrusted: ctx.has_untrusted, secret: ctx.has_secret };

    let destination: string | null = null;
    if (op.destination) {
      destination = await destinationOf(client, ctx, params.ticketId);
      if (!destination) return await refuse("OUT_OF_SCOPE", safeParams);
    }

    // An approval only counts if it matches this exact request.
    let approvalId: string | undefined;
    let approved = false;
    if (op.destination && params.approvalId) {
      const a = (
        await client.query(`select *, expires_at < now() as expired from tb_approvals where id = $1 and context_id = $2 for update`, [
          params.approvalId,
          ctx.id,
        ])
      ).rows[0];
      const problem: ReasonCode | null = !a
        ? "APPROVAL_NOT_FOUND"
        : a.status === "used"
          ? "APPROVAL_ALREADY_USED"
          : a.status === "rejected"
            ? "APPROVAL_REJECTED"
            : a.status === "pending"
              ? "APPROVAL_PENDING"
              : a.expired
                ? "APPROVAL_EXPIRED"
                : a.operation !== op.id ||
                    a.operation_version !== op.version ||
                    a.destination !== destination ||
                    a.content_sha256 !== sha256(String(params.content)) ||
                    a.policy_version !== POLICY_VERSION ||
                    a.state_fingerprint !== stateFingerprint(before)
                  ? "APPROVAL_MISMATCH"
                  : null;
      if (problem) return await refuse(problem, safeParams);
      approved = true;
      approvalId = a.id;
    }

    const verdict = decide(before, op, introduced.state, approved);
    const event = {
      ...base,
      contextId: ctx.id,
      labels: introduced.columns,
      before,
      after: verdict.after,
      params: safeParams,
    };

    if (verdict.decision === "DENIED") {
      await writeEvent(client, { ...event, decision: "DENIED", reason: verdict.reason, durationMs: elapsed() });
      await client.query("COMMIT");
      return result("DENIED", verdict.reason);
    }

    if (verdict.decision === "APPROVAL_REQUIRED") {
      // Asking twice for the same output reuses the open request.
      const content = String(params.content);
      const existing = await client.query(
        `select id from tb_approvals where context_id = $1 and operation = $2 and destination = $3
            and content_sha256 = $4 and status = 'pending' and expires_at > now()`,
        [ctx.id, op.id, destination, sha256(content)],
      );
      approvalId =
        existing.rows[0]?.id ??
        (
          await client.query(
            `insert into tb_approvals (context_id, operation, operation_version, destination, content, content_sha256,
                                       state_fingerprint, policy_version, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9)) returning id`,
            [ctx.id, op.id, op.version, destination, content, sha256(content), stateFingerprint(before), POLICY_VERSION, APPROVAL_TTL_MINUTES],
          )
        ).rows[0].id;
      await writeEvent(client, {
        ...event,
        decision: "APPROVAL_REQUIRED",
        reason: verdict.reason,
        durationMs: elapsed(),
        params: { ...safeParams, approvalId },
      });
      await client.query("COMMIT");
      return result("APPROVAL_REQUIRED", verdict.reason, { approvalId });
    }

    // Authorized. Labels are recorded even if the statement then fails:
    // an error must never leave the context looking cleaner than it is.
    const decisionMs = elapsed();
    await client.query(`update tb_contexts set has_untrusted = $2, has_secret = $3 where id = $1`, [
      ctx.id,
      verdict.after.untrusted,
      verdict.after.secret,
    ]);
    await client.query("SAVEPOINT run");
    try {
      const res = await runOperation(client, op, ctx.run_id, params);
      const executionResult = op.writes.length
        ? res.rowCount
          ? "published"
          : "noop_already_replied"
        : `returned_${res.rowCount ?? 0}_rows`;
      if (approvalId) {
        await client.query(`update tb_approvals set status = 'used', used_at = now() where id = $1`, [approvalId]);
      }
      await writeEvent(client, { ...event, decision: "ALLOWED", reason: verdict.reason, durationMs: decisionMs, executionResult });
      await client.query("COMMIT");
      return result("ALLOWED", verdict.reason, { rows: res.rows ?? [], executionResult, approvalId });
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT run");
      await writeEvent(client, {
        ...event,
        decision: "EXECUTION_FAILED",
        reason: "EXECUTION_ERROR",
        durationMs: decisionMs,
        executionResult: "error",
      });
      await client.query("COMMIT");
      return result("EXECUTION_FAILED", "EXECUTION_ERROR", { executionResult: "error" });
    }
  } catch {
    // Could not verify something. Fail closed, and audit outside the dead transaction.
    await client.query("ROLLBACK").catch(() => {});
    await writeEvent(pool, {
      correlationId,
      contextId: ctx?.id ?? null,
      sessionId,
      actor: auth.role,
      operation: String(operationId),
      decision: "DENIED",
      reason: "POLICY_UNAVAILABLE",
      durationMs: elapsed(),
    }).catch(() => {});
    return result("DENIED", "POLICY_UNAVAILABLE");
  } finally {
    client.release();
  }
}

/** Operator-only. The agent's credentials can never reach a successful branch here. */
export async function decideApproval(auth: AuthContext, approvalId: string, action: "approve" | "reject") {
  const correlationId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const a = (
      await client.query(`select *, expires_at < now() as expired from tb_approvals where id = $1 for update`, [approvalId])
    ).rows[0];
    const event = {
      correlationId,
      contextId: a?.context_id ?? null,
      sessionId: auth.role === "agent" ? auth.sessionId : null,
      actor: auth.role,
      operation: "approvals.decide",
      params: { approvalId, action },
    };
    const fail = async (reason: ReasonCode) => {
      await writeEvent(client, { ...event, decision: "DENIED", reason });
      await client.query("COMMIT");
      return { ok: false as const, reason };
    };
    if (auth.role !== "operator") return await fail("AGENT_CANNOT_APPROVE");
    if (!a) return await fail("APPROVAL_NOT_FOUND");
    if (a.status !== "pending") return await fail(a.status === "rejected" ? "APPROVAL_REJECTED" : "APPROVAL_ALREADY_USED");
    if (a.expired) return await fail("APPROVAL_EXPIRED");

    const status = action === "approve" ? "approved" : "rejected";
    await client.query(`update tb_approvals set status = $2, decided_by = $3, decided_at = now() where id = $1`, [
      approvalId,
      status,
      auth.operatorId,
    ]);
    await writeEvent(client, {
      ...event,
      operation: a.operation,
      decision: action === "approve" ? "APPROVED" : "REJECTED",
      reason: action === "approve" ? "OPERATOR_APPROVED" : "OPERATOR_REJECTED",
    });
    await client.query("COMMIT");
    return { ok: true as const, status };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
