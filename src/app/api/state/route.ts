import { pool } from "@/lib/db";
import { planChecks } from "@/lib/explain";
import { operatorFrom } from "@/lib/operator";
import { CATALOG, POLICY_VERSION } from "@/lib/policy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const [labels, contexts, approvals, metrics, latency] = await Promise.all([
    pool.query(`select table_name, column_name, label from tb_column_labels order by table_name, column_name, label`),
    pool.query(
      `select c.*, coalesce((select array_agg(s.id order by s.created_at) from tb_sessions s where s.context_id = c.id), '{}') as sessions
         from tb_contexts c where c.kind <> 'test' order by c.created_at desc limit 40`,
    ),
    pool.query(
      `select a.id, a.context_id, a.operation, a.destination, a.content, a.status, a.expires_at, a.created_at,
              a.expires_at < now() as expired
         from tb_approvals a join tb_contexts c on c.id = a.context_id
        where c.kind <> 'test' order by a.created_at desc limit 40`,
    ),
    pool.query(
      `select
         (select count(*)::int from tb_contexts where kind <> 'test') as contexts,
         (select count(*)::int from tb_events e join tb_contexts c on c.id = e.context_id
           where c.kind <> 'test' and c.mode = 'protected' and e.actor = 'agent'
             and e.decision in ('ALLOWED', 'DENIED', 'APPROVAL_REQUIRED', 'EXECUTION_FAILED')) as evaluated,
         (select count(*)::int from tb_events e join tb_contexts c on c.id = e.context_id
           where c.kind <> 'test' and c.mode = 'protected' and e.actor = 'agent' and e.decision = 'DENIED') as blocked,
         (select count(*)::int from tb_contexts where kind = 'workflow') as workflows,
         (select count(distinct e.context_id)::int from tb_events e join tb_contexts c on c.id = e.context_id
           where c.kind = 'workflow' and e.execution_result = 'published') as workflows_completed,
         (select count(*)::int from tb_approvals a join tb_contexts c on c.id = a.context_id
           where c.kind <> 'test' and a.status = 'pending' and a.expires_at > now()) as pending_approvals`,
    ),
    pool.query(
      `select count(*)::int as n,
              round((percentile_cont(0.5) within group (order by e.duration_ms))::numeric, 1) as p50,
              round((percentile_cont(0.95) within group (order by e.duration_ms))::numeric, 1) as p95
         from tb_events e join tb_contexts c on c.id = e.context_id
        where c.kind <> 'test' and e.duration_ms is not null`,
    ),
  ]);
  const ids = contexts.rows.map((c) => c.id);
  const runs = contexts.rows.map((c) => c.run_id);
  const [events, tickets, plans] = await Promise.all([
    pool.query(`select * from tb_events where context_id = any($1) order by id desc limit 500`, [ids]),
    pool.query(`select id, run_id, customer_email, subject, body, reply from support_tickets where run_id = any($1) order by id`, [runs]),
    planChecks().catch(() => null),
  ]);

  return Response.json({
    runtime: "Supabase Postgres",
    policyVersion: POLICY_VERSION,
    operator: Boolean(operatorFrom(request)),
    labels: labels.rows,
    catalog: [...CATALOG.values()].map((op) => ({
      id: op.id,
      version: op.version,
      description: op.description,
      reads: op.reads,
      writes: op.writes,
      destination: op.destination?.description ?? null,
      sql: op.sql,
      plan: plans?.[op.id] ?? null,
    })),
    contexts: contexts.rows,
    events: events.rows.map((e) => ({ ...e, id: Number(e.id), duration_ms: e.duration_ms === null ? null : Number(e.duration_ms) })),
    approvals: approvals.rows,
    tickets: tickets.rows.map((t) => ({ ...t, id: Number(t.id) })),
    metrics: { ...metrics.rows[0], latency: latency.rows[0] },
  });
}
