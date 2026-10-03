// The checkpoint between an agent and the Customer DB. Every statement is judged before anything runs.
// Two databases, never one transaction: stamps and the log live in the Breaker DB (control pool),
// the statement runs in the Customer DB (asAgent). The log survives a customer-side rollback.
import type { PoolClient } from "pg";
import { analyze, precheck } from "./analyzer";
import { asAgent, control, single } from "./db";
import { getLabels } from "./labels";
import { maskLiterals, sha256 } from "./mask";
import { decide } from "./policy";
import { isSessionId, unknownSession } from "./session";
import { ROW_CAP, RULES } from "./types";
import type { Audit, Decision, Flags, GuardResult, LabelRow, QueryFacts, Stage } from "./types";

/** The SQLSTATE of an error raised by Postgres, or null: a dropped connection has none. */
export function sqlState(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("severity" in err)) return null;
  const { code } = err as { code?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * Bookkeeping failed, so nothing ran. Database error text stays out of the message
 * (it may reach the agent): only the SQLSTATE. Our own errors pass through unchanged.
 */
function failClosed(err: unknown): Error {
  const code = sqlState(err);
  if (code === null && err instanceof Error && !("code" in err)) return err;
  return new Error(`Breaker bookkeeping failed${code ? ` (SQLSTATE ${code})` : ""}: the statement was not run.`, {
    cause: err,
  });
}

function stageOf(d: Decision, facts: QueryFacts, prechecked: boolean): Stage | null {
  switch (d.rule) {
    case "ALLOW":
      return null;
    case "R0_OPAQUE_STATEMENT":
      return prechecked ? (facts.failedAt ?? "explain") : "precheck";
    case "R1_PROTECTED_OBJECT":
      // Naming the breaker schema is refused on the text; anything else is found while planning.
      return facts.failedAt ?? "explain";
    case "R5_UNLISTED_FUNCTION":
      return "explain";
    default:
      return "policy";
  }
}

type Judged = { before: Flags; facts: QueryFacts; d: Decision; eventId: number };

// ---- Admission: how much work the Breaker takes on at once ----

/** The message of the error thrown when the Breaker is saturated. Nothing ran; the API answers 503. */
export const BUSY = "The Breaker is busy";
/** A reply never carries more than this many bytes of rows, whatever the statement produced. */
export const MAX_REPLY_BYTES = 1_000_000;

// Each pool has 3 connections and a statement in flight uses one of each, one after the other.
// Two at a time leaves a connection of each pool free for new sessions, labels and fixtures.
const MAX_IN_FLIGHT = 2;
const MAX_WAITING = 50;
// Running plus queued, per session.
const MAX_PER_SESSION = 8;

let inFlight = 0;
const waiting: (() => void)[] = [];
const sessions = new Map<string, { tail: Promise<void>; depth: number }>();

/**
 * Statements of one session run one after the other, so one session holds at most one slot;
 * all sessions together hold at most MAX_IN_FLIGHT. Whoever waits holds no database connection,
 * and the queues are bounded: past them the caller is refused at once instead of piling up.
 * (The row lock in judge() still decides between two processes; this is about not stalling.)
 */
async function admitted<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const session = sessions.get(sessionId) ?? { tail: Promise.resolve(), depth: 0 };
  if (session.depth >= MAX_PER_SESSION) throw new Error(BUSY);
  session.depth++;
  sessions.set(sessionId, session);
  const previous = session.tail;
  let done!: () => void;
  session.tail = new Promise<void>((resolve) => (done = resolve));
  try {
    await previous;
    if (inFlight < MAX_IN_FLIGHT) inFlight++;
    else if (waiting.length >= MAX_WAITING) throw new Error(BUSY);
    // The slot is handed over by whoever finishes: inFlight stays as it is.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else inFlight--;
    }
  } finally {
    done();
    if (--session.depth === 0) sessions.delete(sessionId);
  }
}

/** What stands in the log for the statement of a session that holds secret data. */
export const NOT_LOGGED = "[statement not logged: this session holds secret data]";

/** At most ROW_CAP rows and MAX_REPLY_BYTES of them: the two bounds of a reply. */
function capRows(rows: unknown[]): { rows: unknown[]; truncated: boolean } {
  const kept: unknown[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (kept.length === ROW_CAP) return { rows: kept, truncated: true };
    bytes += Buffer.byteLength(JSON.stringify(row) ?? "");
    if (bytes > MAX_REPLY_BYTES) return { rows: kept, truncated: true };
    kept.push(row);
  }
  return { rows: kept, truncated: false };
}

/**
 * One Breaker DB transaction holding the session's row lock: read the stamps, analyze,
 * decide, write the new stamps and the event, commit. Two statements of one session
 * queue here, so they cannot both pass (one reading tickets, the other reading tokens).
 */
async function judge(sessionId: string, sql: string, prechecked: boolean, labels: LabelRow[]): Promise<Judged> {
  const client: PoolClient = await control.connect();
  let broken = false;
  try {
    // A stuck holder must not hang every later statement of the session: give up and fail closed.
    await client.query("begin; set local lock_timeout = '10s'");
    const { rows } = await client.query(
      "select has_untrusted, has_secret from breaker.sessions where id = $1 for update",
      [sessionId],
    );
    if (!rows.length) throw unknownSession();
    const before: Flags = { hasUntrusted: rows[0].has_untrusted, hasSecret: rows[0].has_secret };

    // The labels came in from outside: needing a second control connection while holding this one deadlocks under load.
    // The EXPLAIN inside runs on the Customer DB, as the agent role.
    const facts = await analyze(sql, labels);
    const d = decide(before, facts);

    if (d.decision === "allow") {
      if (!prechecked) throw new Error("The analyzer allowed a statement its own precheck refuses.");
      // Stamps before execution: a statement that fails can still leak through its error.
      await client.query("update breaker.sessions set has_untrusted = $2, has_secret = $3 where id = $1", [
        sessionId,
        d.flagsAfter.hasUntrusted,
        d.flagsAfter.hasSecret,
      ]);
    }

    // A planner message (SQLSTATE class 42) quotes pieces of the agent's own SQL, literals included
    // ('x'::regclass, a syntax error next to a literal). The agent may read that back; the log never carries it.
    let logged =
      d.rule === "R0_OPAQUE_STATEMENT" && facts.failedAt === "explain" ? d.reason.replace(/"[\s\S]*"/, '"…"') : d.reason;
    let loggedSql = maskLiterals(sql);
    // Masking hides literals, not names: an alias, a number or a made-up function name is free text too.
    // A session that already holds a secret could spell it that way, so from then on its statements are
    // logged by hash, relations, rule and stamps only, and the reason is the rule's fixed sentence.
    // (The stamp is set before the statement that first reads a secret returns, so this cannot be raced.)
    if (before.hasSecret) {
      loggedSql = NOT_LOGGED;
      logged = RULES[d.rule];
    }

    // The decision is logged in the transaction that makes it: no statement runs without its event.
    const event = await client.query(
      `insert into breaker.events
         (session_id, sql, sql_sha256, relations, is_write, decision, rule, reason, flags_before, flags_after)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       returning id`,
      [
        sessionId,
        loggedSql,
        sha256(sql),
        JSON.stringify(facts.relations),
        facts.isWrite,
        d.decision,
        d.rule,
        logged,
        JSON.stringify(before),
        JSON.stringify({ hasUntrusted: d.flagsAfter.hasUntrusted, hasSecret: d.flagsAfter.hasSecret }),
      ],
    );
    await client.query("commit");
    return { before, facts, d, eventId: Number(event.rows[0].id) };
  } catch (err) {
    broken = await client.query("rollback").then(
      () => false,
      () => true,
    );
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Decides allow or deny for one statement of one session, and only then runs it.
 * Throws when the session is unknown or when bookkeeping fails: in both cases nothing ran.
 */
export async function guardedExecute(sessionId: string, sql: string): Promise<GuardResult> {
  if (!isSessionId(sessionId)) throw unknownSession();
  return admitted(sessionId, () => guarded(sessionId, sql));
}

async function guarded(sessionId: string, sql: string): Promise<GuardResult> {

  let judged: Judged;
  let cleaned: string | null;
  try {
    const pre = precheck(sql);
    cleaned = pre.ok ? pre.sql : null;
    // Before the session lock. No labels and nothing cached: this throws, and nothing runs.
    const labels = await getLabels();
    judged = await judge(sessionId, sql, pre.ok, labels);
  } catch (err) {
    throw failClosed(err);
  }

  // From here on the stamps and the event are committed and the session's lock is released.
  const { before, facts, d, eventId } = judged;
  const audit: Audit = {
    rule: d.rule,
    reason: d.reason,
    flagsBefore: before,
    flagsAfter: { hasUntrusted: d.flagsAfter.hasUntrusted, hasSecret: d.flagsAfter.hasSecret },
    stoppedAt: stageOf(d, facts, cleaned !== null),
    eventId,
  };
  if (d.decision === "deny" || cleaned === null) return { ok: false, decision: "deny", ...audit };

  // A read is asked for one row more than the cap, so Postgres stops there instead of sending
  // millions of rows for us to drop. The statement analyzed is a valid statement on its own, so it
  // cannot close this parenthesis; the line breaks keep a trailing "--" comment from swallowing it.
  // A write (RETURNING) cannot be wrapped and runs as it is.
  const statement = facts.isWrite
    ? cleaned
    : `SELECT * FROM (\n${cleaned}\n) AS breaker_capped LIMIT ${ROW_CAP + 1}`;
  try {
    // Customer DB, as the agent role, extended protocol (one statement, or Postgres answers 42601).
    // Reads run in a read-only transaction: Postgres itself refuses a write the analyzer missed.
    const result = await asAgent(!facts.isWrite, (c) => single(c, statement));
    const { rows, truncated } = capRows(result.rows);
    return {
      ok: true,
      decision: "allow",
      rows,
      // For a truncated read this is how many rows were fetched (the cap plus one), not how many exist.
      rowCount: result.rowCount ?? result.rows.length,
      truncated,
      ...audit,
    };
  } catch (err) {
    const errorCode = sqlState(err);
    // The log gets the SQLSTATE and never the message: an error can quote the data it choked on.
    try {
      await control.query("update breaker.events set error_code = $2, reason = reason || $3 where id = $1", [
        eventId,
        errorCode,
        ` Execution failed (${errorCode ? `SQLSTATE ${errorCode}` : "no SQLSTATE"}).`,
      ]);
    } catch (logErr) {
      throw failClosed(logErr);
    }
    return {
      ok: false,
      decision: "allow",
      // The session's stamps already account for whatever this statement could read.
      // Without a SQLSTATE it is a connection problem, and that text describes our infrastructure.
      error: errorCode && err instanceof Error ? err.message : "The statement could not be run.",
      errorCode,
      ...audit,
    };
  }
}
