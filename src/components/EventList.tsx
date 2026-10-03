import { REASONS } from "@/lib/policy";
import type { EventRow } from "@/lib/types";
import { Chip, DecisionBadge, Empty, time } from "./ui";

export function EventList({ events, empty }: { events: EventRow[]; empty: string }) {
  if (!events.length) return <Empty>{empty}</Empty>;
  return (
    <ol className="space-y-2">
      {events.map((e, i) => (
        <li key={e.id} className={`event-in rounded-lg border bg-raised p-3 ${e.decision === "DENIED" ? "border-deny/50" : "border-line"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
            <code className="font-mono text-[13px]">{e.operation}</code>
            <DecisionBadge decision={e.decision} />
            <span className="ml-auto font-mono text-[11px] text-muted">{time(e.created_at)}</span>
          </div>
          {e.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {e.labels.map((l) => {
                const [column, label] = l.split(":");
                return (
                  <Chip key={l} tone={label === "secret" ? "secret" : "untrusted"}>
                    {column} · {label}
                  </Chip>
                );
              })}
            </div>
          )}
          <p className={`mt-2 text-sm ${e.decision === "DENIED" ? "text-deny" : "text-muted"}`}>
            <span className="font-mono text-xs">{e.reason_code}</span> · {REASONS[e.reason_code] ?? ""}
            {e.execution_result && <span className="font-mono text-xs"> · {e.execution_result}</span>}
          </p>
        </li>
      ))}
    </ol>
  );
}
