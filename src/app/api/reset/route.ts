import { pool } from "@/lib/db";
import { requireOperator } from "@/lib/operator";

// Clears demo history. Contexts are deleted, never reset: nothing gets "cleaned".
export async function POST(request: Request) {
  const operator = requireOperator(request);
  if (operator instanceof Response) return operator;
  await pool.query(`truncate tb_events, tb_approvals, tb_sessions, tb_contexts, support_tickets`);
  return Response.json({ ok: true });
}
