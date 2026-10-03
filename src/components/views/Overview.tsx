import type { DashboardState } from "@/lib/types";
import { ApprovalCard } from "../Approvals";
import { EventList } from "../EventList";
import { Flow } from "../Flow";
import { Empty, Panel } from "../ui";
import type { ViewProps } from "./props";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3.5">
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

export function latestProtected(state: DashboardState) {
  const ctx = state.contexts.find((c) => c.mode === "protected");
  return ctx ? { ctx, events: state.events.filter((e) => e.context_id === ctx.id).reverse() } : null;
}

export function Overview({ state, live, busy, onDecide }: ViewProps) {
  const m = state.metrics;
  const latest = latestProtected(state);
  const pending = state.approvals.filter((a) => a.status === "pending" && !a.expired);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Contexts" value={String(m.contexts)} note="In demo history" />
        <Stat label="Blocked / evaluated" value={`${m.blocked} / ${m.evaluated}`} note="Protected operations" />
        <Stat label="Tasks completed" value={`${m.workflows_completed} / ${m.workflows}`} note="Legitimate workflows" />
        <Stat label="Pending approvals" value={String(m.pending_approvals)} />
        <Stat
          label="Decision latency"
          value={m.latency.p50 === null ? "n/a" : `${m.latency.p50} ms`}
          note={m.latency.n ? `median, p95 ${m.latency.p95} ms, n=${m.latency.n}` : "No samples yet"}
        />
        <Stat label="Runtime" value={live ? "Live" : "Polling"} note={`${state.runtime} · policy ${state.policyVersion}`} />
      </div>

      <Panel title="Latest protected context">
        {latest ? (
          <Flow events={latest.events} caption={`${latest.ctx.kind} context ${latest.ctx.id.slice(0, 8)}: nothing blocked.`} />
        ) : (
          <Empty>No protected context yet. Run the attack replay from Attack Lab.</Empty>
        )}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Pending approvals">
          {pending.length ? (
            <div className="space-y-3">
              {pending.map((a) => (
                <ApprovalCard key={a.id} approval={a} operator={state.operator} busy={busy !== null} onDecide={onDecide} />
              ))}
            </div>
          ) : (
            <Empty>Nothing is waiting for a human.</Empty>
          )}
        </Panel>
        <Panel title="Recent decisions">
          <EventList events={state.events.slice(0, 6)} empty="No operations evaluated yet." />
        </Panel>
      </div>
    </div>
  );
}
