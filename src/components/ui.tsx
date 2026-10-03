import type { Decision } from "@/lib/policy";

const PATHS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  clock: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z",
  alert: "M12 8v5M12 16.5v.5M10.3 3.9L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  unlock: "M8 11V7a4 4 0 017.5-2M6 11h12v9H6z",
  shield: "M12 3l7 3v5.5c0 4.3-2.9 8-7 9.5-4.1-1.5-7-5.2-7-9.5V6l7-3z",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 100 8 4 4 0 000-8z",
  moon: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
} as const;

export function Icon({ name, className = "h-3.5 w-3.5" }: { name: keyof typeof PATHS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const DECISIONS: Record<Decision, { text: string; icon: keyof typeof PATHS; tone: string }> = {
  ALLOWED: { text: "Allowed", icon: "check", tone: "border-allow/40 bg-allow/10 text-allow" },
  APPROVED: { text: "Approved", icon: "check", tone: "border-allow/40 bg-allow/10 text-allow" },
  DENIED: { text: "Denied", icon: "x", tone: "border-deny/50 bg-deny/10 text-deny" },
  REJECTED: { text: "Rejected", icon: "x", tone: "border-deny/50 bg-deny/10 text-deny" },
  APPROVAL_REQUIRED: { text: "Approval required", icon: "clock", tone: "border-hold/50 bg-hold/10 text-hold" },
  EXECUTION_FAILED: { text: "Execution failed", icon: "alert", tone: "border-hold/50 bg-hold/10 text-hold" },
  UNCHECKED: { text: "Unchecked", icon: "unlock", tone: "border-line bg-text/5 text-muted" },
};

export function DecisionBadge({ decision }: { decision: Decision }) {
  const d = DECISIONS[decision];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${d.tone}`}>
      <Icon name={d.icon} className="h-3 w-3" />
      {d.text}
    </span>
  );
}

export function Chip({ tone = "neutral", children }: { tone?: "untrusted" | "secret" | "allow" | "deny" | "hold" | "neutral"; children: React.ReactNode }) {
  const tones = {
    untrusted: "bg-untrusted/15 text-untrusted",
    secret: "bg-secret/15 text-secret",
    allow: "bg-allow/15 text-allow",
    deny: "bg-deny/15 text-deny",
    hold: "bg-hold/15 text-hold",
    neutral: "bg-text/5 text-muted",
  };
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function Panel({ title, aside, children, className = "" }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</h2>
        {aside}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-8 text-center text-sm text-muted">{children}</p>
);

export const button = {
  primary: "rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-on-brand transition-transform hover:brightness-110 active:scale-[0.97] disabled:opacity-40",
  secondary: "rounded-lg border border-line bg-raised px-3.5 py-2 text-sm font-medium hover:border-muted disabled:opacity-40",
  quiet: "rounded-lg px-3 py-2 text-sm text-muted hover:text-text disabled:opacity-40",
};

export const shortId = (id: string | null) => (id ? id.slice(0, 8) : "none");
export const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour12: false });

/** Ticket text is untrusted: rendered as plain text, with the injected block marked. */
export function TicketBody({ body }: { body: string }) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.startsWith("==="));
  const end = lines.findLastIndex((l) => l.startsWith("==="));
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
      {lines.map((line, i) => (
        <span key={i} className={start >= 0 && i >= start && i <= end ? "bg-deny/15 text-deny" : undefined}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
