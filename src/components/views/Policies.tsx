import { APPROVAL_TTL_MINUTES } from "@/lib/policy";
import { Chip, Icon, Panel } from "../ui";
import type { ViewProps } from "./props";

export function Policies({ state }: ViewProps) {
  const labelOf = (column: string) => state.labels.filter((l) => `${l.table_name}.${l.column_name}` === column).map((l) => l.label);
  return (
    <div className="space-y-5">
      <Panel title="Policy" aside={<code className="font-mono text-[11px] text-muted">version {state.policyVersion}</code>}>
        <p className="text-sm text-muted">
          Read only. The catalog and rules live in versioned server code; the agent, the browser and this dashboard cannot change them.
          Every event and approval records the version it was decided under, and an approval from another version is refused.
        </p>
        <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          {[
            "A context can never hold secret and untrusted data together.",
            "The state after the operation is what gets judged, not only the state before.",
            "A context that read untrusted content needs human approval to send anything out.",
            "A context that holds a secret cannot send anything out.",
            `Approvals are bound to context, operation, recipient, exact text and policy version, expire after ${APPROVAL_TTL_MINUTES} minutes and work once.`,
            "Anything outside the catalog is refused before it runs.",
          ].map((rule) => (
            <li key={rule} className="flex gap-2 rounded-lg border border-line bg-raised px-3 py-2">
              <Icon name="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
              {rule}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Column labels">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-muted">
            <tr><th className="pb-2 font-medium">Column</th><th className="pb-2 font-medium">Label</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {state.labels.map((l) => (
              <tr key={`${l.table_name}.${l.column_name}.${l.label}`}>
                <td className="py-2 font-mono text-[13px]">{l.table_name}.{l.column_name}</td>
                <td className="py-2"><Chip tone={l.label}>{l.label}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Operation catalog" aside={<span className="text-[11px] text-muted">The only things an agent can ask for</span>}>
        <div className="space-y-3">
          {state.catalog.map((op) => (
            <article key={op.id} className="rounded-lg border border-line bg-raised p-3">
              <header className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-sm font-semibold">{op.id}</code>
                <Chip>v{op.version}</Chip>
                {op.destination ? <Chip tone="hold">sends to: {op.destination}</Chip> : <Chip>returns to agent only</Chip>}
                {op.plan &&
                  (op.plan.covered ? (
                    <Chip tone="allow"><Icon name="check" className="h-3 w-3" /> Postgres plan matches declaration</Chip>
                  ) : (
                    <Chip tone="deny"><Icon name="alert" className="h-3 w-3" /> Plan touches undeclared: {op.plan.undeclared.join(", ")}</Chip>
                  ))}
              </header>
              <p className="mt-1.5 text-sm text-muted">{op.description}</p>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-line bg-ink p-2.5 font-mono text-xs leading-relaxed">{op.sql}</pre>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {op.reads.map((c) => {
                  const labels = labelOf(c);
                  return <Chip key={c} tone={labels.includes("secret") ? "secret" : labels.includes("untrusted") ? "untrusted" : "neutral"}>reads {c}</Chip>;
                })}
                {op.writes.map((c) => <Chip key={c} tone="hold">writes {c}</Chip>)}
              </div>
            </article>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          The plan check is a diagnostic: EXPLAIN (never ANALYZE) plans each fixed statement and compares the columns with the declaration.
          Authorization never depends on it.
        </p>
      </Panel>
    </div>
  );
}
