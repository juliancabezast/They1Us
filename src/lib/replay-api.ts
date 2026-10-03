import { pool } from "./db";
import { DEMO_RUNTIME, forbidden, sameOrigin } from "./operator";
import { ATTACKER_EMAIL } from "./fixtures";
import { runAttackReplay } from "./runs";

const MAX_RUNS_PER_MINUTE = 30;

/** Shared by the two replay routes. Which executor runs is fixed by the route, not by the request. */
export async function replayResponse(request: Request, mode: "protected" | "sandbox") {
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  const recent = await pool.query(`select count(*)::int as n from tb_contexts where created_at > now() - interval '1 minute'`);
  if (recent.rows[0].n >= MAX_RUNS_PER_MINUTE) return forbidden("Too many demo runs right now. Try again in a minute.", 429);

  const { pace } = await request.json().catch(() => ({}));
  const { contextId, runId } = await runAttackReplay(DEMO_RUNTIME, mode, pace === false ? 0 : 700);
  const [events, ticket] = await Promise.all([
    pool.query(`select * from tb_events where context_id = $1 order by id`, [contextId]),
    pool.query(`select id, customer_email, subject, body, reply from support_tickets where run_id = $1 and customer_email = $2`, [
      runId,
      ATTACKER_EMAIL,
    ]),
  ]);
  return Response.json({ contextId, events: events.rows, ticket: ticket.rows[0] });
}
