// Relative imports on purpose (no "@core" or "@/" alias): core/test/web.test.ts loads this file with vitest, which has no alias.
import { control, customer, CUSTOMER_SCHEMA } from "../../core/src/db";
import { runScenario } from "../../core/src/runner";
import { MODES, SCENARIO_IDS, type BreakerState, type Mode, type ScenarioId, type ScenarioRun } from "../../core/src/scenarios";
import { forbidden, operatorFrom } from "./operator";

// Shared by the dashboard routes under /api/breaker (run, state, reset). Nothing here takes SQL
// from a request: a run is named by a scenario id and a mode, and the statements come from
// core/src/scenarios.ts. Two databases: bookkeeping only through `control` (Breaker DB), the
// customer's tables only through `customer` (Customer DB). Never one statement or transaction across both.

export const failed = (message: string, status: number) => Response.json({ error: message }, { status });

/**
 * State-changing dashboard requests must come from this site's own pages: the Origin header has to equal
 * this server's origin as a whole (scheme, host and port), not only its host.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    // Behind a TLS proxy the request itself arrives as http: the proxy says which scheme the browser used.
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
    const scheme = forwarded || new URL(request.url).protocol.slice(0, -1);
    return new URL(origin).origin === new URL(`${scheme}://${host}`).origin;
  } catch {
    return false;
  }
}

/**
 * The body as text, or null when it is larger than `max` bytes. Counted while reading, so a body
 * without a Content-Length (chunked) is cut off at the cap too, and never parsed.
 */
export async function readBody(request: Request, max: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Only the two known keys are read, and only values from the closed lists pass. Everything else in the body is ignored. */
export function parseRunRequest(body: unknown): { scenario: ScenarioId; mode: Mode } | null {
  if (typeof body !== "object" || body === null) return null;
  const { scenario, mode } = body as Record<string, unknown>;
  const s = SCENARIO_IDS.find((id) => id === scenario);
  const m = MODES.find((id) => id === mode);
  return s && m ? { scenario: s, mode: m } : null;
}

const RUNS_PER_MINUTE = 40;

export interface RunLimiter {
  /** true when the run may start. The slot is taken by the same call. */
  take(now?: number): boolean;
}

/**
 * At most `limit` runs per window, counted in this server process. Check and reservation are one
 * synchronous step, so a burst of requests cannot all pass the check before any of them is counted.
 * Only requests to the dashboard's run route take slots: sessions opened through the Breaker API,
 * the MCP server, the CLI or the tests cannot use the budget up.
 */
export function createRunLimiter(limit = RUNS_PER_MINUTE, windowMs = 60_000): RunLimiter {
  const taken: number[] = [];
  return {
    take(now = Date.now()) {
      while (taken.length && taken[0] <= now - windowMs) taken.shift();
      if (taken.length >= limit) return false;
      taken.push(now);
      return true;
    },
  };
}

// On globalThis, like the pools: hot reload must not hand out a fresh budget.
const globals = globalThis as unknown as { breakerRunLimiter?: RunLimiter };
const runLimiter = globals.breakerRunLimiter ?? (globals.breakerRunLimiter = createRunLimiter());

/** What the run route answers: a ScenarioRun without anything that works as a credential. */
export type DashboardRun = ScenarioRun & {
  /** true when ticket.reply is only a preview, because the caller is not the operator. */
  replyRedacted: boolean;
};

/** Same cut as left(id::text, 8) in breakerState(), so a run can be matched with its rows in the log. */
export const shortSessionId = (id: string) => id.slice(0, 8);

/** How much of a reply a caller who is not the operator may see. */
const PREVIEW_CHARS = 12;
/** A reply made only of the seed's fictitious values (core/sql/customer/002_seed.sql). Those are published in the repo: not secrets. */
const FICTITIOUS_REPLY = /^DEMO_ONLY_NOT_A_REAL_TOKEN_[0-9A-Z]{1,16}(, DEMO_ONLY_NOT_A_REAL_TOKEN_[0-9A-Z]{1,16})*$/;

/**
 * The run as this caller may see it. The reply of an unprotected run carries whatever the agent copied out of
 * the secret-labeled columns, so only the operator gets it in full. Everybody else gets a preview, unless the
 * reply is nothing but the seed's fictitious tokens. The session id is cut for everyone: a full id is all the
 * Breaker API asks for to act on a session, and the dashboard only needs it to tell sessions apart.
 */
export function forCaller(run: ScenarioRun, operator: boolean): DashboardRun {
  const reply = run.ticket.reply;
  const full = operator || reply === null || FICTITIOUS_REPLY.test(reply);
  // Never more than half of it: a short value must not fit inside its own preview.
  const preview = (text: string) => `${text.slice(0, Math.min(PREVIEW_CHARS, Math.floor(text.length / 2)))}…`;
  return {
    ...run,
    sessionId: shortSessionId(run.sessionId),
    ticket: { id: run.ticket.id, reply: full || reply === null ? reply : preview(reply) },
    replyRedacted: !full,
  };
}

/** A run request is { scenario, mode }: a few dozen bytes. */
const RUN_BODY_BYTES = 4_096;

interface RunDeps {
  run: (scenario: ScenarioId, mode: Mode) => Promise<ScenarioRun>;
  limiter: RunLimiter;
}

/**
 * POST /api/breaker/run. The request names a scripted scenario; it never carries SQL.
 * `deps` exists for the tests (a limiter of their own, a run that does not need the databases).
 */
export async function runReply(request: Request, deps: RunDeps = { run: runScenario, limiter: runLimiter }): Promise<Response> {
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  const text = await readBody(request, RUN_BODY_BYTES).catch(() => "");
  if (text === null) return failed("Request body too large.", 413);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: answered below like any other body that does not name a run.
  }
  const run = parseRunRequest(body);
  if (!run) return failed("Expected { scenario: A to F, mode: protected | unprotected }.", 400);

  // The presenter signs in as operator and is never locked out by what other visitors do.
  const operator = operatorFrom(request) !== null;
  if (!operator && !deps.limiter.take()) return failed("Too many demo runs right now. Try again in a minute.", 429);
  try {
    return Response.json(forCaller(await deps.run(run.scenario, run.mode), operator), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    logFailure("run", err);
    return failed("The scenario could not be run.", 500);
  }
}

/** Only the scenario is read, and only a value from the closed list passes. Everything else in the body is ignored. */
export function parseDemoRequest(body: unknown): { scenario: ScenarioId } | null {
  if (typeof body !== "object" || body === null) return null;
  const s = SCENARIO_IDS.find((id) => id === (body as Record<string, unknown>).scenario);
  return s ? { scenario: s } : null;
}

/**
 * Removes the sessions of earlier scripted runs from the Breaker log (their events go with them: on delete cascade).
 * Only label "replay:…": sessions opened through the HTTP API or the MCP server are other people's live sessions.
 * The 4 seconds protect a run that is in flight right now (another visitor's, or a test's): a protected run
 * whose session vanished would fail, and a scripted run answers in well under a second. It must stay shorter
 * than the shortest run on screen (one refused statement, about 6 seconds), or the run before stays in the log.
 * Customer tickets are not touched: the runner removes its own.
 */
export async function clearReplaySessions(): Promise<void> {
  await control.query(`delete from breaker.sessions where label like 'replay:%' and created_at < now() - interval '4 seconds'`);
}

interface DemoDeps extends RunDeps {
  clear: () => Promise<void>;
}

/**
 * POST /api/breaker/demo. One scenario, both modes, on a log cleared of earlier replays: the data is
 * synthetic and every demo starts clean, so no operator sign-in. Same checks as runReply; it never carries SQL.
 * `deps` exists for the tests.
 */
export async function breakerDemoReply(
  request: Request,
  deps: DemoDeps = { run: runScenario, limiter: runLimiter, clear: clearReplaySessions },
): Promise<Response> {
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  const text = await readBody(request, RUN_BODY_BYTES).catch(() => "");
  if (text === null) return failed("Request body too large.", 413);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: answered below like any other body that does not name a scenario.
  }
  const demo = parseDemoRequest(body);
  if (!demo) return failed("Expected { scenario: A to F }.", 400);

  const operator = operatorFrom(request) !== null;
  // One slot for the pair: the limit counts requests, like the run route.
  if (!operator && !deps.limiter.take()) return failed("Too many demo runs right now. Try again in a minute.", 429);
  try {
    await deps.clear();
    // Each run files its own ticket and opens its own session, so the two cannot step on each other.
    const [off, on] = await Promise.all([deps.run(demo.scenario, "unprotected"), deps.run(demo.scenario, "protected")]);
    return Response.json(
      { off: forCaller(off, operator), on: forCaller(on, operator) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    logFailure("demo", err);
    return failed("The scenario could not be run.", 500);
  }
}

const EVENT_LIMIT = 60;
const SESSION_LIMIT = 20;

/**
 * Breaker DB only. One statement, so a poll holds one control connection for one round trip:
 * the pool has three and guardedExecute needs one per statement it is judging. Built as JSON in
 * Postgres, so bigint ids arrive as numbers and timestamps as ISO strings.
 * Session ids leave as their first 8 characters only: this endpoint is public, and a full session id is the
 * one thing the Breaker API asks for to run statements in (and stamp) somebody else's session.
 */
export async function breakerState(): Promise<BreakerState> {
  const { rows } = await control.query(
    `select
       (select coalesce(json_agg(l order by l.table_schema, l.table_name, l.column_name), '[]'::json)
          from (select table_schema, table_name, column_name, label from breaker.column_labels) l) as labels,
       (select coalesce(json_agg(e order by e.id desc), '[]'::json)
          from (select id, left(session_id::text, 8) as session_id, sql, relations, is_write, decision, rule, reason,
                       flags_before, flags_after, error_code, created_at
                  from breaker.events order by id desc limit $1) e) as events,
       (select coalesce(json_agg(s order by s.created_at desc, s.id), '[]'::json)
          from (select left(s0.id::text, 8) as id, s0.label, s0.has_untrusted, s0.has_secret, s0.created_at
                  from breaker.sessions s0 order by s0.created_at desc, s0.id limit $2) s) as sessions,
       (select json_build_object(
                 'allowed', count(*) filter (where decision = 'allow'),
                 'denied', count(*) filter (where decision = 'deny'))
          from breaker.events) as decisions,
       (select count(*)::int from breaker.sessions) as session_count`,
    [EVENT_LIMIT, SESSION_LIMIT],
  );
  const { labels, events, sessions, decisions, session_count } = rows[0];
  return {
    labels,
    events,
    sessions,
    totals: { allowed: Number(decisions.allowed), denied: Number(decisions.denied), sessions: session_count },
  };
}

type Db = typeof control;

/** One group of statements in one transaction on one database. */
async function inTransaction(db: Db, statements: string[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    // Truncate and delete wait for statements in flight. Give up instead of holding a connection forever.
    await client.query("set local lock_timeout = '5s'");
    for (const statement of statements) await client.query(statement);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * core/sql/breaker/003_reset.sql on the Breaker DB and core/sql/customer/003_reset.sql on the Customer DB.
 * Two databases, so two independent transactions: one failing does not undo the other, and both are
 * attempted before the failure is reported.
 */
export async function resetBreaker(): Promise<void> {
  const tickets = `${CUSTOMER_SCHEMA}.support_tickets`;
  const results = await Promise.allSettled([
    inTransaction(control, [`truncate breaker.events`, `delete from breaker.sessions`]),
    inTransaction(customer, [`delete from ${tickets} where id > 3`, `update ${tickets} set reply = null`]),
  ]);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected) throw rejected.reason;
}

/**
 * Server log only, and never the error object: a pg error carries the statement and its values.
 * A database error is logged by SQLSTATE alone unless it is class 42 (syntax and access errors,
 * whose text only names objects): any other class can quote row data in its message.
 */
export const logFailure = (where: string, err: unknown) => {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const sqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const detail =
    sqlState && !sqlState.startsWith("42") ? `SQLSTATE ${sqlState}` : err instanceof Error ? err.message : "unknown error";
  console.error(`[breaker] ${where}: ${detail}`);
};
