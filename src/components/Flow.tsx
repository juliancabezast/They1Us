import { REASONS } from "@/lib/policy";
import type { EventRow } from "@/lib/types";
import { Icon } from "./ui";

type EdgeState = "idle" | "open" | "held" | "blocked";

interface Edge {
  state: EdgeState;
  note: string;
}

/** Derives the three hops from a context's audited events. Nothing here is simulated. */
function edges(events: EventRow[]): Edge[] {
  const ran = (e: EventRow) => e.decision === "ALLOWED" || e.decision === "UNCHECKED";
  const has = (e: EventRow, label: string) => e.labels.some((l) => l.endsWith(`:${label}`)) || (label === "secret" && e.operation.startsWith("tokens."));
  const untrusted = events.filter((e) => e.operation.startsWith("tickets.list") || e.operation === "tickets.read");
  const secret = events.filter((e) => has(e, "secret"));
  const output = events.filter((e) => e.operation === "tickets.publish_reply");

  const pick = (list: EventRow[], open: string): Edge => {
    const denied = list.find((e) => e.decision === "DENIED");
    if (denied) return { state: "blocked", note: denied.reason_code };
    if (list.some(ran)) return { state: "open", note: open };
    if (list.some((e) => e.decision === "APPROVAL_REQUIRED")) return { state: "held", note: "Held for approval" };
    return { state: "idle", note: "Not attempted" };
  };
  return [pick(untrusted, "Untrusted content read"), pick(secret, "Secret read"), pick(output, "Output sent")];
}

const NODES = ["Untrusted input", "Agent context", "Protected resources", "Output"];
const EDGE_TONE: Record<EdgeState, string> = {
  idle: "text-line",
  open: "text-text",
  held: "text-hold",
  blocked: "text-deny",
};

export function Flow({ events, caption }: { events: EventRow[]; caption: string }) {
  const hops = edges(events);
  // Resources sit between context and output, so the secret hop is drawn before the output hop.
  const blocked = hops.find((h) => h.state === "blocked");
  return (
    <div>
      <ol className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] sm:items-center">
        {NODES.map((node, i) => (
          <li key={node} className="contents">
            <div className="rounded-lg border border-line bg-raised px-3 py-2.5 text-center text-sm font-medium">{node}</div>
            {i < 3 && (
              <div className={`flex items-center justify-center gap-1.5 text-xs sm:flex-col sm:gap-0.5 ${EDGE_TONE[hops[i].state]}`}>
                <span className="flex items-center gap-1 font-mono">
                  {hops[i].state === "blocked" ? <Icon name="x" /> : hops[i].state === "held" ? <Icon name="clock" /> : null}
                  <span aria-hidden="true" className="sm:hidden">↓</span>
                  <span aria-hidden="true" className="hidden sm:inline">→</span>
                </span>
                <span className="max-w-32 text-center text-[11px] leading-tight">
                  {hops[i].state === "blocked" ? "Blocked" : hops[i].note}
                </span>
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className={`mt-3 text-sm ${blocked ? "text-deny" : "text-muted"}`}>
        {blocked ? `Blocked: ${REASONS[blocked.note as keyof typeof REASONS] ?? blocked.note}` : caption}
      </p>
    </div>
  );
}
