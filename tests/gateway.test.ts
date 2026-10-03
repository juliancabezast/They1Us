// Runs against the real Postgres in DATABASE_URL (the demo Supabase project):
//   npm test
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { pool } from "../src/lib/db";
import { planChecks } from "../src/lib/explain";
import { createContext, createSession, decideApproval, guardedExecute, type AuthContext } from "../src/lib/gateway";
import { CATALOG } from "../src/lib/policy";
import { runAttackReplay, resumeWorkflow, startWorkflow } from "../src/lib/runs";
import { sandboxExecute } from "../src/lib/sandbox";

const operator: AuthContext = { role: "operator", operatorId: "test-operator" };
const created: string[] = [];

async function fresh(mode: "protected" | "sandbox" = "protected") {
  const runId = randomUUID();
  const t = await pool.query(
    `insert into support_tickets (run_id, customer_email, subject, body) values ($1, 'a@test.example', 's', 'b') returning id`,
    [runId],
  );
  const { contextId, sessionId } = await createContext(operator, { mode, kind: "test", runId });
  created.push(contextId);
  const agent: AuthContext = { role: "agent", sessionId };
  return { contextId, sessionId, agent, runId, ticketId: Number(t.rows[0].id) };
}
const state = async (contextId: string) =>
  (await pool.query(`select has_untrusted, has_secret from tb_contexts where id = $1`, [contextId])).rows[0];
const token = { service: "billing-api" };

after(async () => {
  await pool.query(`delete from support_tickets where run_id in (select run_id from tb_contexts where id = any($1))`, [created]);
  await pool.query(`delete from tb_contexts where id = any($1)`, [created]);
  await pool.end();
});

test("untrusted then secret is denied", async () => {
  const c = await fresh();
  assert.equal((await guardedExecute(c.agent, "tickets.list_open", {})).decision, "ALLOWED");
  const r = await guardedExecute(c.agent, "tokens.read_integration", token);
  assert.deepEqual([r.decision, r.reason, r.rows.length], ["DENIED", "SECRET_AFTER_UNTRUSTED", 0]);
});

test("secret then untrusted is denied", async () => {
  const c = await fresh();
  assert.equal((await guardedExecute(c.agent, "tokens.read_integration", token)).decision, "ALLOWED");
  const r = await guardedExecute(c.agent, "tickets.list_open", {});
  assert.deepEqual([r.decision, r.reason], ["DENIED", "UNTRUSTED_AFTER_SECRET"]);
});

test("one operation that introduces both labels is denied on a clean context", async () => {
  const c = await fresh();
  // Labels are not exclusive: mark a ticket column as secret too.
  await pool.query(`insert into tb_column_labels values ('support_tickets', 'body', 'secret')`);
  try {
    const r = await guardedExecute(c.agent, "tickets.list_open", {});
    assert.deepEqual([r.decision, r.reason], ["DENIED", "BOTH_LABELS_IN_ONE_OPERATION"]);
    assert.deepEqual(await state(c.contextId), { has_untrusted: false, has_secret: false });
  } finally {
    await pool.query(`delete from tb_column_labels where table_name = 'support_tickets' and column_name = 'body' and label = 'secret'`);
  }
});

test("two concurrent incompatible reads are never both allowed", async () => {
  for (let i = 0; i < 5; i++) {
    const c = await fresh();
    const results = await Promise.all([
      guardedExecute(c.agent, "tickets.list_open", {}),
      guardedExecute(c.agent, "tokens.read_integration", token),
    ]);
    assert.equal(results.filter((r) => r.decision === "ALLOWED").length, 1);
    const s = await state(c.contextId);
    assert.notEqual(s.has_untrusted && s.has_secret, true);
  }
});

test("a new session id does not clean the context", async () => {
  const c = await fresh();
  await guardedExecute(c.agent, "tickets.list_open", {});
  const other: AuthContext = { role: "agent", sessionId: await createSession(c.contextId) };
  assert.equal((await guardedExecute(other, "tokens.read_integration", token)).reason, "SECRET_AFTER_UNTRUSTED");
  const forged: AuthContext = { role: "agent", sessionId: randomUUID() };
  assert.equal((await guardedExecute(forged, "tokens.read_integration", token)).reason, "UNKNOWN_SESSION");
});

test("the agent cannot open a context for itself", async () => {
  const c = await fresh();
  await assert.rejects(createContext(c.agent, { mode: "protected", kind: "test", runId: c.runId }));
});

test("state survives a reconnect: it lives in Postgres, not in the process", async () => {
  const c = await fresh();
  await guardedExecute(c.agent, "tickets.list_open", {});
  const second = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
  const row = (await second.query(`select has_untrusted from tb_contexts where id = $1`, [c.contextId])).rows[0];
  await second.end();
  assert.equal(row.has_untrusted, true);
});

test("a failed execution does not return the context to clean", async () => {
  const c = await fresh();
  await pool.query(`revoke select on support_tickets from tb_executor`);
  try {
    assert.equal((await guardedExecute(c.agent, "tickets.list_open", {})).decision, "EXECUTION_FAILED");
  } finally {
    await pool.query(`grant select on support_tickets to tb_executor`);
  }
  assert.equal((await state(c.contextId)).has_untrusted, true);
  assert.equal((await guardedExecute(c.agent, "tokens.read_integration", token)).decision, "DENIED");
});

test("unknown operations and tampered parameters are denied", async () => {
  const c = await fresh();
  const cases: [string, unknown, string][] = [
    ["sql.execute", { sql: "select * from integration_tokens" }, "UNKNOWN_OPERATION"],
    ["constructor", {}, "UNKNOWN_OPERATION"],
    ["tokens.read_integration", { service: "billing-api' or '1'='1" }, "INVALID_PARAMS"],
    ["tickets.read", { ticketId: "1; drop table support_tickets" }, "INVALID_PARAMS"],
    ["tickets.list_open", { run_id: randomUUID() }, "INVALID_PARAMS"],
    ["tickets.publish_reply", { ticketId: c.ticketId, content: "x", protection: false }, "INVALID_PARAMS"],
    ["tickets.publish_reply", { ticketId: 999999999, content: "x" }, "OUT_OF_SCOPE"],
  ];
  for (const [op, params, reason] of cases) {
    const r = await guardedExecute(c.agent, op, params);
    assert.deepEqual([op, r.decision, r.reason], [op, "DENIED", reason]);
  }
});

test("a write from an untrusted context waits for approval and publishes nothing", async () => {
  const c = await fresh();
  await guardedExecute(c.agent, "tickets.list_open", {});
  const r = await guardedExecute(c.agent, "tickets.publish_reply", { ticketId: c.ticketId, content: "hello" });
  assert.equal(r.decision, "APPROVAL_REQUIRED");
  const reply = (await pool.query(`select reply from support_tickets where id = $1`, [c.ticketId])).rows[0].reply;
  assert.equal(reply, null);
});

test("a context that holds a secret cannot publish at all", async () => {
  const c = await fresh();
  await guardedExecute(c.agent, "tokens.read_integration", token);
  const r = await guardedExecute(c.agent, "tickets.publish_reply", { ticketId: c.ticketId, content: "hello" });
  assert.deepEqual([r.decision, r.reason], ["DENIED", "SECRET_CONTEXT_OUTPUT"]);
});

async function pending(content = "hello") {
  const c = await fresh();
  await guardedExecute(c.agent, "tickets.list_open", {});
  const r = await guardedExecute(c.agent, "tickets.publish_reply", { ticketId: c.ticketId, content });
  return { ...c, content, approvalId: r.approvalId! };
}

test("the agent cannot approve its own request", async () => {
  const p = await pending();
  assert.deepEqual(await decideApproval(p.agent, p.approvalId, "approve"), { ok: false, reason: "AGENT_CANNOT_APPROVE" });
  const r = await guardedExecute(p.agent, "tickets.publish_reply", { ticketId: p.ticketId, content: p.content, approvalId: p.approvalId });
  assert.equal(r.reason, "APPROVAL_PENDING");
});

test("changing the content after approval invalidates it", async () => {
  const p = await pending();
  await decideApproval(operator, p.approvalId, "approve");
  const r = await guardedExecute(p.agent, "tickets.publish_reply", { ticketId: p.ticketId, content: "something else", approvalId: p.approvalId });
  assert.deepEqual([r.decision, r.reason], ["DENIED", "APPROVAL_MISMATCH"]);
});

test("an approval from another context is not accepted", async () => {
  const p = await pending();
  await decideApproval(operator, p.approvalId, "approve");
  const other = await fresh();
  await guardedExecute(other.agent, "tickets.list_open", {});
  const r = await guardedExecute(other.agent, "tickets.publish_reply", { ticketId: other.ticketId, content: p.content, approvalId: p.approvalId });
  assert.equal(r.reason, "APPROVAL_NOT_FOUND");
});

test("an expired approval is denied", async () => {
  const p = await pending();
  await decideApproval(operator, p.approvalId, "approve");
  await pool.query(`update tb_approvals set expires_at = now() - interval '1 minute' where id = $1`, [p.approvalId]);
  const r = await guardedExecute(p.agent, "tickets.publish_reply", { ticketId: p.ticketId, content: p.content, approvalId: p.approvalId });
  assert.equal(r.reason, "APPROVAL_EXPIRED");
});

test("a rejected approval is denied", async () => {
  const p = await pending();
  await decideApproval(operator, p.approvalId, "reject");
  const r = await guardedExecute(p.agent, "tickets.publish_reply", { ticketId: p.ticketId, content: p.content, approvalId: p.approvalId });
  assert.equal(r.reason, "APPROVAL_REJECTED");
});

test("an approval is single use and a retry does not publish twice", async () => {
  const p = await pending();
  await decideApproval(operator, p.approvalId, "approve");
  const args = { ticketId: p.ticketId, content: p.content, approvalId: p.approvalId };
  const first = await guardedExecute(p.agent, "tickets.publish_reply", args);
  assert.deepEqual([first.decision, first.executionResult], ["ALLOWED", "published"]);
  const retry = await guardedExecute(p.agent, "tickets.publish_reply", args);
  assert.deepEqual([retry.decision, retry.reason], ["DENIED", "APPROVAL_ALREADY_USED"]);
  const published = await pool.query(
    `select count(*)::int as n from tb_events where context_id = $1 and execution_result = 'published'`,
    [p.contextId],
  );
  assert.equal(published.rows[0].n, 1);
  // Approval does not clear the labels.
  assert.equal((await state(p.contextId)).has_untrusted, true);
});

test("the legitimate workflow completes with human approval", async () => {
  const w = await startWorkflow(operator, 0);
  created.push(w.contextId);
  assert.ok(w.approvalId);
  assert.equal((await decideApproval(operator, w.approvalId, "approve")).ok, true);
  const done = await resumeWorkflow(w.approvalId);
  assert.deepEqual([done?.decision, done?.executionResult], ["ALLOWED", "published"]);
  const reply = await pool.query(`select reply from support_tickets where run_id = $1 and reply is not null`, [w.runId]);
  assert.equal(reply.rowCount, 1);
  assert.match(reply.rows[0].reply, /Northwind Traders Inc/);
});

test("attack replay: the sandbox leaks the fictitious token, the gateway does not", async () => {
  const sandbox = await runAttackReplay(operator, "sandbox", 0);
  const guarded = await runAttackReplay(operator, "protected", 0);
  created.push(sandbox.contextId, guarded.contextId);
  const reply = async (runId: string) =>
    (await pool.query(`select reply from support_tickets where run_id = $1 and customer_email = 'attacker@evil.example'`, [runId])).rows[0].reply;
  assert.match(await reply(sandbox.runId), /DEMO_ONLY_NOT_A_REAL_TOKEN_7F3A/);
  assert.equal(await reply(guarded.runId), null);
  const decisions = (await pool.query(`select decision from tb_events where context_id = $1 order by id`, [guarded.contextId])).rows.map((r) => r.decision);
  assert.deepEqual(decisions, ["ALLOWED", "DENIED", "APPROVAL_REQUIRED"]);
});

test("the unprotected executor is unreachable outside a sandbox context", async () => {
  const c = await fresh("protected");
  await assert.rejects(sandboxExecute(c.sessionId, "tokens.read_integration", token));
  const s = await fresh("sandbox");
  assert.equal((await guardedExecute(s.agent, "tokens.read_integration", token)).reason, "WRONG_MODE");
});

test("the audit trail and approvals never contain a secret value", async () => {
  const dump = await pool.query(
    `select (select coalesce(string_agg(e::text, ' '), '') from tb_events e) || (select coalesce(string_agg(a::text, ' '), '') from tb_approvals a) as text`,
  );
  assert.doesNotMatch(dump.rows[0].text, /DEMO_ONLY_NOT_A_REAL_TOKEN/);
});

test("denials are audited with reason, state and correlation id", async () => {
  const c = await fresh();
  await guardedExecute(c.agent, "tickets.list_open", {});
  const r = await guardedExecute(c.agent, "tokens.read_integration", token);
  const e = (await pool.query(`select * from tb_events where correlation_id = $1`, [r.correlationId])).rows[0];
  assert.equal(e.decision, "DENIED");
  assert.equal(e.reason_code, "SECRET_AFTER_UNTRUSTED");
  assert.deepEqual(e.state_before, { untrusted: true, secret: false });
  assert.deepEqual(e.state_after, { untrusted: true, secret: false });
  assert.ok(e.policy_version && e.duration_ms !== null);
});

test("the executor role cannot touch policy, audit or approvals", async () => {
  const client = await pool.connect();
  try {
    for (const table of ["tb_events", "tb_column_labels", "tb_approvals", "tb_contexts"]) {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE tb_executor");
      await assert.rejects(client.query(`select 1 from ${table} limit 1`), /permission denied/);
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
});

test("diagnostic: every catalog declaration covers what Postgres plans to touch", async () => {
  const checks = await planChecks();
  for (const op of CATALOG.values()) {
    assert.deepEqual([op.id, checks[op.id].undeclared], [op.id, []]);
  }
});
