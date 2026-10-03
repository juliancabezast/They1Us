// Relative imports on purpose (no "@/" alias): core/test/demo.test.ts loads this file with vitest, which has no alias.
import { clearReplaySessions, createRunLimiter, failed, logFailure, sameOrigin, type RunLimiter } from "./breaker-api";
import { pool } from "./db";
import { ATTACKER_EMAIL } from "./fixtures";
import { DEMO_RUNTIME, forbidden, operatorFrom } from "./operator";
import { runAttackReplay } from "./runs";
import type { EventRow, TicketRow } from "./types";

// POST /api/demo/run: the whole Live demo in one request. The data is synthetic, so every run starts
// from nothing: the previous history is deleted, then the same attack is replayed twice on the server.

/** What each of the two replay routes answers (src/lib/replay-api.ts). */
export interface Replay {
  contextId: string;
  events: EventRow[];
  ticket: TicketRow;
}

const DEMO_RUNS_PER_MINUTE = 12;

// On globalThis, like the pools: hot reload must not hand out a fresh budget or forget the run in flight.
const globals = globalThis as unknown as { demoRunLimiter?: RunLimiter; demoRunTail?: Promise<unknown> };
const demoLimiter = globals.demoRunLimiter ?? (globals.demoRunLimiter = createRunLimiter(DEMO_RUNS_PER_MINUTE));

/**
 * One demo at a time in this server process: the clear of a second request (a double click)
 * would delete the contexts the first one is still writing to.
 */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const result = (globals.demoRunTail ?? Promise.resolve()).then(fn, fn);
  globals.demoRunTail = result.catch(() => {});
  return result;
}

/** Same statement as /api/reset on the dashboard's tables, and the scripted runs of the SQL Breaker log. */
async function clearDemo(): Promise<void> {
  await pool.query(`truncate tb_events, tb_approvals, tb_sessions, tb_contexts, support_tickets`);
  await clearReplaySessions();
}

/** One replay with no pauses, answered exactly like replayResponse does. */
async function replay(mode: "sandbox" | "protected"): Promise<Replay> {
  const { contextId, runId } = await runAttackReplay(DEMO_RUNTIME, mode, 0);
  const [events, ticket] = await Promise.all([
    pool.query(`select * from tb_events where context_id = $1 order by id`, [contextId]),
    pool.query(`select id, customer_email, subject, body, reply from support_tickets where run_id = $1 and customer_email = $2`, [
      runId,
      ATTACKER_EMAIL,
    ]),
  ]);
  return { contextId, events: events.rows, ticket: ticket.rows[0] };
}

/** `limiter` is a parameter for the tests. A signed-in operator (the presenter) is never limited. */
export async function demoRunReply(request: Request, limiter: RunLimiter = demoLimiter): Promise<Response> {
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  if (operatorFrom(request) === null && !limiter.take()) return failed("Too many demo runs right now. Try again in a minute.", 429);
  try {
    const body = await oneAtATime(async () => {
      await clearDemo();
      // In this order: the protected context must be the newest one on the dashboard.
      const off = await replay("sandbox");
      const on = await replay("protected");
      return { off, on };
    });
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    logFailure("demo run", err);
    return failed("The demo could not be run.", 500);
  }
}
