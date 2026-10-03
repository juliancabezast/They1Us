// The core end to end (plan sections 9, 11 and 15): scenarios A to F and guardedExecute against both real
// databases. Nothing is reset or truncated: only sessions and tickets opened here are asserted on, and the
// sessions are removed at the end (the runner removes its own tickets).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedExecute } from "../src/breaker";
import { CUSTOMER_SCHEMA, closePools, control, customer } from "../src/db";
import { maskLiterals, sha256 } from "../src/mask";
import { runScenario } from "../src/runner";
import { INJECTION_MARKER, SCENARIOS, SCENARIO_IDS } from "../src/scenarios";
import type { ScenarioRun } from "../src/scenarios";
import { createSession, getFlags, setFlags } from "../src/session";
import { ROW_CAP } from "../src/types";

const TICKETS = `${CUSTOMER_SCHEMA}.support_tickets`;
const READ_TICKETS = "SELECT id, subject, body FROM support_tickets";
const READ_TOKENS = "SELECT service, token FROM integration_tokens";
// Every fictitious token of the seed starts like this.
const TOKEN_PREFIX = "DEMO_ONLY_NOT_A_REAL_TOKEN";

const CLEAN = { hasUntrusted: false, hasSecret: false };
const UNTRUSTED = { hasUntrusted: true, hasSecret: false };
const SECRET = { hasUntrusted: false, hasSecret: true };

type EventRow = {
  id: string;
  sql: string;
  sql_sha256: string;
  relations: unknown;
  is_write: boolean;
  decision: string;
  rule: string;
  reason: string;
  flags_before: unknown;
  flags_after: unknown;
  error_code: string | null;
};

type Ticket = { id: string; customer_email: string; subject: string; body: string; reply: string | null };

const opened: string[] = [];
let seeded: Ticket[] = [];

async function newSession(): Promise<string> {
  const id = await createSession("test:breaker");
  opened.push(id);
  return id;
}

/** A scripted run, with its session remembered so it is removed at the end. */
async function play(...args: Parameters<typeof runScenario>): Promise<ScenarioRun> {
  const run = await runScenario(...args);
  opened.push(run.sessionId);
  return run;
}

const eventsOf = async (sessionId: string): Promise<EventRow[]> =>
  (await control.query<EventRow>("select * from breaker.events where session_id = $1 order by id", [sessionId])).rows;

const ticketExists = async (id: number): Promise<boolean> =>
  (await customer.query(`select 1 from ${TICKETS} where id = $1`, [id])).rows.length > 0;

const readSeeded = async (): Promise<Ticket[]> =>
  (
    await customer.query<Ticket>(
      `select id, customer_email, subject, body, reply from ${TICKETS} where id = any($1::bigint[]) order by id`,
      [seeded.map((t) => t.id)],
    )
  ).rows;

beforeAll(async () => {
  // The fifteen lowest ids are the seed. Tickets filed by runs (ours or anybody's) always come after them.
  const { rows } = await customer.query<Ticket>(
    `select id, customer_email, subject, body, reply from ${TICKETS} order by id limit 15`,
  );
  seeded = rows;
  expect(seeded).toHaveLength(15);
  expect(seeded.filter((t) => t.body.includes(INJECTION_MARKER))).toHaveLength(1);
});

afterAll(async () => {
  // Our own sessions only; their events go with them.
  if (opened.length) await control.query("delete from breaker.sessions where id = any($1::uuid[])", [opened]);
  await closePools();
});

describe("maskLiterals", () => {
  it("blanks literals and comments, closed or not, and keeps names", () => {
    expect(maskLiterals("UPDATE t SET reply = 'a''b' WHERE id = 7")).toBe("UPDATE t SET reply = '…' WHERE id = 7");
    expect(maskLiterals("SELECT $q$one$q$, $$two$$")).toBe("SELECT $$…$$, $$…$$");
    expect(maskLiterals("SELECT 'never closed")).toBe("SELECT '…'");
    expect(maskLiterals("SELECT $$never closed")).toBe("SELECT $$…$$");
    expect(maskLiterals("SELECT E'a\\'hidden' AS x")).toBe("SELECT E'…' AS x");
    expect(maskLiterals("SELECT 1 -- it's hidden\n, 'x'")).toBe("SELECT 1 --…\n, '…'");
    expect(maskLiterals("SELECT /* a /* b */ c */ 1")).toBe("SELECT /*…*/ 1");
    expect(maskLiterals('SELECT "it\'s a name" FROM t')).toBe('SELECT "it\'s a name" FROM t');
  });
});

describe("scenarios, protected", () => {
  it.each(SCENARIO_IDS)("scenario %s answers every step with the expected rule", async (id) => {
    const run = await play(id, "protected");
    expect(run.steps.map((s) => s.rule)).toEqual(SCENARIOS[id].steps.map((s) => s.expected));
    expect(run.steps.map((s) => s.outcome)).toEqual(
      SCENARIOS[id].steps.map((s) => (s.expected === "ALLOW" ? "allow" : "deny")),
    );
    expect(run.asExpected).toBe(true);
    expect(run.leaked).toBe(false);
    expect(run.ticket.reply).toBeNull();
    // One event per statement, whatever the answer.
    expect(await eventsOf(run.sessionId)).toHaveLength(SCENARIOS[id].steps.length);
    expect(await ticketExists(run.ticket.id)).toBe(false);
  });

  it("scenario A leaves three complete events and a session that holds untrusted only", async () => {
    const run = await play("A", "protected");
    expect(run.steps.map((s) => s.rule)).toEqual(["ALLOW", "R2_TRIFECTA_MIX", "R3_TAINTED_WRITE"]);
    expect(run.leaked).toBe(false);
    expect(run.ticket.reply).toBeNull();
    // The scripted agent found the ticket in the rows of step 1: its own, not a hardcoded id.
    expect(run.steps[2].sql.endsWith(`WHERE id = ${run.ticket.id}`)).toBe(true);

    const events = await eventsOf(run.sessionId);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.decision)).toEqual(["allow", "deny", "deny"]);
    expect(events.map((e) => e.rule)).toEqual(["ALLOW", "R2_TRIFECTA_MIX", "R3_TAINTED_WRITE"]);
    for (const e of events) {
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.sql_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.error_code).toBeNull();
    }
    expect(events.map((e) => e.flags_before)).toEqual([CLEAN, UNTRUSTED, UNTRUSTED]);
    expect(events.map((e) => e.flags_after)).toEqual([UNTRUSTED, UNTRUSTED, UNTRUSTED]);
    expect(events[0].relations).toEqual([
      { schema: CUSTOMER_SCHEMA, name: "support_tickets", scanned: true, written: false },
    ]);
    expect(events[2].is_write).toBe(true);

    expect(await getFlags(run.sessionId)).toEqual(UNTRUSTED);
    expect(await ticketExists(run.ticket.id)).toBe(false);
  });
});

describe("scenarios, unprotected", () => {
  it("scenario A leaks a token into the attacker's ticket", async () => {
    const run = await play("A", "unprotected");
    expect(run.steps.map((s) => s.outcome)).toEqual(["executed", "executed", "executed"]);
    expect(run.steps.every((s) => s.rule === null)).toBe(true);
    expect(run.asExpected).toBeNull();
    expect(run.leaked).toBe(true);
    expect(run.ticket.reply).toContain(TOKEN_PREFIX);
    // What is reported about the statement itself is masked.
    expect(JSON.stringify(run.steps)).not.toContain(TOKEN_PREFIX);
    expect(await ticketExists(run.ticket.id)).toBe(false);
  });

  it("scenario E fails: the agent role cannot drop the customer's table", async () => {
    const run = await play("E", "unprotected");
    expect(run.steps.map((s) => s.outcome)).toEqual(["failed"]);
    expect(run.steps[0].errorCode).toBe("42501");
    expect(run.leaked).toBe(false);
    const { rows } = await customer.query("select to_regclass($1) as found", [TICKETS]);
    expect(rows[0].found).not.toBeNull();
    expect(await ticketExists(run.ticket.id)).toBe(false);
  });

  it("scenario F fails: the agent role cannot reach the session stamps", async () => {
    const session = await newSession();
    await setFlags(session, UNTRUSTED);
    const run = await play("F", "unprotected");
    expect(run.steps.map((s) => s.outcome)).toEqual(["failed"]);
    // No privilege on the schema today; no such schema once the Customer DB is a separate project.
    expect(run.steps[0].errorCode).toMatch(/^(42501|3F000|42P01)$/);
    expect(await getFlags(session)).toEqual(UNTRUSTED);
    expect(await ticketExists(run.ticket.id)).toBe(false);
  });
});

describe("guardedExecute", () => {
  it("throws for an unknown session", async () => {
    await expect(guardedExecute(randomUUID(), "SELECT 1")).rejects.toThrow("Unknown session");
    await expect(guardedExecute("not-a-uuid", "SELECT 1")).rejects.toThrow("Unknown session");
  });

  it("commits the flags even when the allowed statement fails while running", async () => {
    const session = await newSession();
    const r = await guardedExecute(session, "SELECT token::int FROM integration_tokens");
    expect(r.ok).toBe(false);
    expect(r.decision).toBe("allow");
    expect(r.rule).toBe("ALLOW");
    expect(r.flagsAfter).toEqual(SECRET);
    if (r.ok || r.decision !== "allow") throw new Error("expected the error variant");
    expect(r.errorCode).toBe("22P02");
    expect(r.error.length).toBeGreaterThan(0);

    // Assume the session was exposed: the error message itself quotes the token.
    expect(await getFlags(session)).toEqual(SECRET);

    const events = await eventsOf(session);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(String(r.eventId));
    expect(events[0].decision).toBe("allow");
    expect(events[0].error_code).toBe("22P02");
    expect(events[0].flags_after).toEqual(SECRET);
    // The log gets the SQLSTATE, never the message.
    expect(JSON.stringify(events[0])).not.toContain(TOKEN_PREFIX);

    // And the stamp holds: the tickets are now out of reach.
    const next = await guardedExecute(session, READ_TICKETS);
    expect(next.decision).toBe("deny");
    expect(next.rule).toBe("R2_TRIFECTA_MIX");
  });

  it("refuses a function that is not on the allowlist, in a clean session (R5)", async () => {
    const session = await newSession();
    const r = await guardedExecute(
      session,
      "SELECT query_to_xml('select token from integration_tokens', true, true, '')",
    );
    expect(r.ok).toBe(false);
    expect(r.decision).toBe("deny");
    expect(r.rule).toBe("R5_UNLISTED_FUNCTION");
    expect(r.flagsAfter).toEqual(CLEAN);
    expect(JSON.stringify(r)).not.toContain(TOKEN_PREFIX);
    expect(await getFlags(session)).toEqual(CLEAN);
  });

  it(`caps the rows at ${ROW_CAP} and says so`, async () => {
    const session = await newSession();
    // The seed has twelve customers: 12^5 = 248 832 rows, and customers carry no label.
    const r = await guardedExecute(
      session,
      "SELECT a.id FROM customers a, customers b, customers c, customers d, customers e",
    );
    if (!r.ok) throw new Error(`expected rows, got ${r.rule}`);
    expect(r.rows).toHaveLength(ROW_CAP);
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBeGreaterThan(ROW_CAP);
    expect(r.flagsAfter).toEqual(CLEAN);

    const small = await guardedExecute(session, "SELECT id FROM customers");
    if (!small.ok) throw new Error(`expected rows, got ${small.rule}`);
    expect(small.truncated).toBe(false);
    expect(small.rows).toHaveLength(small.rowCount);
  });

  it("never stores a string literal of the statement in the log", async () => {
    const session = await newSession();
    const canary = `CANARY_${randomUUID().replace(/-/g, "")}`;
    const statements = [
      `SELECT id FROM customers WHERE name = '${canary}'`, // allowed
      `INSERT INTO customers (name, plan) VALUES ('${canary}', 'x')`, // the agent role may not write there
      `SELECT id FROM customers '${canary}'`, // syntax error next to the literal
      `SELECT '${canary}'::regclass`, // the planner quotes the literal as a name
      `SELECT '${canary}`, // never closed
      `SELECT $$${canary}`,
      `SELECT E'a\\'${canary}' FROM customers`,
      `SELECT $tag$${canary}$tag$ FROM customers /* ${canary} */`,
      `SELECT body FROM support_tickets WHERE subject = '${canary}'`, // allowed, taints the session
      `UPDATE support_tickets SET reply = '${canary}' WHERE id = 0`, // denied by policy
      `SELECT 1; SELECT '${canary}'`, // denied before the planner
    ];
    for (const sql of statements) await guardedExecute(session, sql);

    const events = await eventsOf(session);
    expect(events).toHaveLength(statements.length);
    expect(events.map((e) => e.sql_sha256)).toEqual(statements.map(sha256));
    expect(JSON.stringify(events).toLowerCase()).not.toContain(canary.toLowerCase());
    // The masked statement is still recognizable.
    expect(events[0].sql).toBe("SELECT id FROM customers WHERE name = '…'");
    expect(events[1].rule).toBe("R1_PROTECTED_OBJECT");
    // The agent got the planner's message; the log got it with the quoted part blanked.
    expect(events.slice(2, 6).map((e) => e.rule)).toEqual(Array(4).fill("R0_OPAQUE_STATEMENT"));
    expect(events[2].reason).toBe('Statement could not be analyzed (syntax error at or near "…").');
    expect(events[3].reason).toBe('Statement could not be analyzed (relation "…" does not exist).');
    expect(events[9].rule).toBe("R3_TAINTED_WRITE");
    expect(events[10].rule).toBe("R0_OPAQUE_STATEMENT");
  });

  it("lets exactly one of two concurrent statements pass, never both labels", async () => {
    for (let round = 0; round < 10; round++) {
      const session = await newSession();
      const [tickets, tokens] = await Promise.all([
        guardedExecute(session, READ_TICKETS),
        guardedExecute(session, READ_TOKENS),
      ]);
      const allowed = [tickets, tokens].filter((r) => r.decision === "allow");
      const denied = [tickets, tokens].filter((r) => r.decision === "deny");
      expect(allowed, `round ${round}`).toHaveLength(1);
      expect(denied, `round ${round}`).toHaveLength(1);
      expect(denied[0].rule).toBe("R2_TRIFECTA_MIX");

      // Exactly one label, and it is the one of the statement that passed.
      expect(await getFlags(session), `round ${round}`).toEqual(tickets.decision === "allow" ? UNTRUSTED : SECRET);
      expect(await eventsOf(session)).toHaveLength(2);
    }
  }, 120_000);
});

describe("fixtures", () => {
  it("the fifteen seeded tickets are untouched, the malicious one still without a reply", async () => {
    const now = await readSeeded();
    expect(now).toEqual(seeded);
    expect(now.find((t) => t.body.includes(INJECTION_MARKER))?.reply).toBeNull();
  });
});
