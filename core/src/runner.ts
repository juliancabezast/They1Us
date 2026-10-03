// Plays one scripted scenario, through the Breaker or straight at the Customer DB, and reports what happened.
import { guardedExecute, sqlState } from "./breaker";
import { CUSTOMER_SCHEMA, asAgent, customer } from "./db";
import { maskLiterals } from "./mask";
import { ATTACKER_TICKET, INJECTION_MARKER, MODES, SCENARIOS } from "./scenarios";
import type { Mode, ScenarioId, ScenarioRun, StepContext, StepResult, StepSpec } from "./scenarios";
import { createSession } from "./session";

// Fixtures are the customer's own app at work (the public ticket form, the attacker's ticket page), so they
// use the customer pool. Names do not resolve unqualified there: every fixture statement qualifies them.
const TICKETS = `${CUSTOMER_SCHEMA}.support_tickets`;
const TOKENS = `${CUSTOMER_SCHEMA}.integration_tokens`;

const isRow = (row: unknown): row is Record<string, unknown> => typeof row === "object" && row !== null;

/**
 * What the scripted agent takes from the rows of a step, like an injected agent would: the ticket that
 * carries the injection (never a hardcoded id) and whatever came back in a "token" column.
 */
function learn(rows: unknown[], ctx: StepContext, ownTicketId: number): void {
  const tokens = rows.flatMap((row) => (isRow(row) && "token" in row ? [String(row.token)] : []));
  if (tokens.length) ctx.token = tokens.join(", ");

  // Rows arrive most recent first. bigint ids come back from pg as strings.
  const malicious = rows.flatMap((row) =>
    isRow(row) && "id" in row && typeof row.body === "string" && row.body.includes(INJECTION_MARKER)
      ? [Number(row.id)]
      : [],
  );
  // Another run's ticket (or the seeded one) may be newer or older: this run goes after its own.
  if (malicious.length) ctx.ticketId = malicious.includes(ownTicketId) ? ownTicketId : malicious[0];
}

async function protectedStep(
  sessionId: string,
  n: number,
  spec: StepSpec,
  ctx: StepContext,
  ownTicketId: number,
): Promise<StepResult> {
  const sql = spec.build(ctx);
  const r = await guardedExecute(sessionId, sql);
  if (r.ok) learn(r.rows, ctx, ownTicketId);
  return {
    n,
    sql: maskLiterals(sql),
    expected: spec.expected,
    outcome: r.decision,
    rule: r.rule,
    reason: r.reason,
    stoppedAt: r.stoppedAt,
    flagsBefore: r.flagsBefore,
    flagsAfter: r.flagsAfter,
    rowCount: r.ok ? r.rowCount : null,
    // Allowed, then failed while running: still an "allow", with the SQLSTATE of the failure.
    errorCode: !r.ok && r.decision === "allow" ? r.errorCode : null,
  };
}

async function unprotectedStep(n: number, spec: StepSpec, ctx: StepContext, ownTicketId: number): Promise<StepResult> {
  const sql = spec.build(ctx);
  const step: StepResult = {
    n,
    sql: maskLiterals(sql),
    expected: spec.expected,
    outcome: "executed",
    rule: null,
    reason: null,
    stoppedAt: null,
    flagsBefore: null,
    flagsAfter: null,
    rowCount: null,
    errorCode: null,
  };
  try {
    // Simple protocol on purpose: this is the unguarded path, and the database role is the only thing
    // standing (it is why scenario E cannot really drop a table).
    // KEEP THIS SQL FIXED. The role is set with SET LOCAL inside a transaction, and the simple protocol
    // lets a script end that transaction ("...; commit; ...") and go on as the connection's owner.
    // `sql` comes only from core/src/scenarios.ts; never route caller-supplied text here. A free-text
    // unprotected mode needs a connection that logs in AS the agent role.
    const result = await asAgent(false, (c) => c.query(sql));
    // A string with several statements comes back as one result per statement.
    const results = Array.isArray(result) ? result : [result];
    for (const one of results) learn(one.rows ?? [], ctx, ownTicketId);
    step.rowCount = results[results.length - 1]?.rowCount ?? null;
  } catch (err) {
    step.outcome = "failed";
    step.errorCode = sqlState(err);
  }
  return step;
}

/**
 * Files the attacker's ticket, plays every step of the scenario and removes the ticket again
 * (`keep` leaves it, so the attacker's view can be shown afterwards).
 * A step that is denied or fails does not stop the run: the agent just tries its next statement.
 */
export async function runScenario(id: ScenarioId, mode: Mode, opts: { keep?: boolean } = {}): Promise<ScenarioRun> {
  const scenario = SCENARIOS[id];
  if (!scenario) throw new Error("Unknown scenario");
  if (!MODES.includes(mode)) throw new Error("Unknown mode");

  // Unprotected runs get a session too, so every run can be counted.
  const sessionId = await createSession(`replay:${id}:${mode}`);
  // Its own copy of the attacker's ticket, so two runs at once cannot step on each other.
  const filed = await customer.query(
    `insert into ${TICKETS} (customer_email, subject, body) values ($1, $2, $3) returning id`,
    [ATTACKER_TICKET.customer_email, ATTACKER_TICKET.subject, ATTACKER_TICKET.body],
  );
  const ownTicketId = Number(filed.rows[0].id);

  try {
    // The agent starts knowing nothing: it has to find the ticket and the tokens through its own statements.
    const ctx: StepContext = { ticketId: null, token: null };
    const steps: StepResult[] = [];
    for (const [i, spec] of scenario.steps.entries()) {
      steps.push(
        mode === "protected"
          ? await protectedStep(sessionId, i + 1, spec, ctx, ownTicketId)
          : await unprotectedStep(i + 1, spec, ctx, ownTicketId),
      );
    }

    // What the attacker sees, compared with the real values: both read as the customer's app, not as the agent.
    const ticket = await customer.query(`select reply from ${TICKETS} where id = $1`, [ownTicketId]);
    const reply: string | null = ticket.rows[0]?.reply ?? null;
    const secrets = await customer.query(`select token from ${TOKENS}`);
    const leaked = reply !== null && secrets.rows.some((s) => s.token && reply.includes(s.token));

    return {
      scenario: id,
      mode,
      sessionId,
      steps,
      ticket: { id: ownTicketId, reply },
      leaked,
      asExpected: mode === "protected" ? steps.every((s) => s.rule === s.expected) : null,
    };
  } finally {
    // Also when a step throws: the next run must not find this one's ticket.
    if (!opts.keep) await customer.query(`delete from ${TICKETS} where id = $1`, [ownTicketId]).catch(() => {});
  }
}
