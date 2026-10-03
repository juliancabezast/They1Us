import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { redact, runOperation, writeEvent, type GatewayResult } from "./gateway";
import { CATALOG } from "./policy";

/**
 * The "before" half of the demo: the same catalog statements with no policy.
 * It is a separate code path, not a switch on the gateway, and it refuses any
 * context that was not created as a sandbox over synthetic fixtures.
 */
export async function sandboxExecute(sessionId: string, operationId: string, rawParams: unknown): Promise<GatewayResult> {
  const correlationId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ctx = (
      await client.query(
        `select c.id, c.mode, c.run_id, c.has_untrusted, c.has_secret
           from tb_sessions s join tb_contexts c on c.id = s.context_id where s.id = $1 for update of c`,
        [sessionId],
      )
    ).rows[0];
    if (!ctx || ctx.mode !== "sandbox") throw new Error("the unprotected executor only runs inside a sandbox context");
    const op = CATALOG.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    const params = op.parse(rawParams);
    const res = await runOperation(client, op, ctx.run_id, params);
    await writeEvent(client, {
      correlationId,
      contextId: ctx.id,
      sessionId,
      actor: "agent",
      operation: op.id,
      decision: "UNCHECKED",
      reason: "SANDBOX_NO_POLICY",
      executionResult: op.writes.length ? (res.rowCount ? "published" : "noop_already_replied") : `returned_${res.rowCount ?? 0}_rows`,
      params: redact(params),
    });
    await client.query("COMMIT");
    return { decision: "UNCHECKED", reason: "SANDBOX_NO_POLICY", correlationId, rows: res.rows ?? [], executionResult: null };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
