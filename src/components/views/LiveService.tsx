"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import type { BreakerEvent, BreakerState } from "@core/scenarios";
import { Stage, type HopState } from "@/components/tour/Stage";
import { softSpring } from "@/components/motion";
import { Chip, Empty, Icon, time } from "@/components/ui";

// The same picture as the Live demo, but driven by what the Breaker service actually did:
// every row below is a real decision from breaker.events, written by the Victim app (Agent console
// with the Breaker on), the SQL Breaker tab, the HTTP API or the MCP server.

const POLL_MS = 3000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isEvent = (v: unknown): v is BreakerEvent => isObject(v) && typeof v.sql === "string" && typeof v.session_id === "string";
const isState = (v: unknown): v is BreakerState =>
  isObject(v) && Array.isArray(v.events) && v.events.every(isEvent) && Array.isArray(v.sessions) && isObject(v.totals);

async function fetchState(signal: AbortSignal): Promise<BreakerState> {
  const res = await fetch("/api/breaker/state", { cache: "no-store", signal });
  if (!res.ok) throw new Error(`The service could not be read (HTTP ${res.status}).`);
  const body: unknown = await res.json();
  if (!isState(body)) throw new Error("The service answered in a shape this page cannot read.");
  return body;
}

// Which part of the flow a single decision is about, so each real event lands on the right hop of the diagram.
type Kind = "ticket" | "token" | "write";
const touches = (e: BreakerEvent, name: string) => e.relations?.some((r) => r.name === name) || new RegExp(name).test(e.sql);
const kindOf = (e: BreakerEvent): Kind => (e.is_write ? "write" : touches(e, "integration_tokens") ? "token" : "ticket");
const hopState = (e?: BreakerEvent): HopState => (!e ? "idle" : e.decision === "allow" ? "open" : "denied");

const STEP_LABEL: Record<Kind, string> = {
  ticket: "Read the support tickets",
  token: "Read the integration token",
  write: "Write the reply on the ticket",
};

/** Turns one session's real events into the diagram's inputs and an ordered, readable step list. */
function derive(events: BreakerEvent[]) {
  const asc = [...events].sort((a, b) => a.id - b.id);
  const first = (k: Kind) => asc.find((e) => kindOf(e) === k);
  const hops: HopState[] = [hopState(first("ticket")), hopState(first("token")), hopState(first("write"))];
  const leaked = hops[1] === "open" && hops[2] === "open";
  const contained = !leaked && (hops[1] === "denied" || hops[2] === "denied");
  return { asc, hops, submitted: asc.length > 0, leaked, contained };
}

interface Loaded {
  data: BreakerState | null;
  at: string | null;
  error: string | null;
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <li className="whitespace-nowrap text-sm text-muted">
      <span className="font-mono font-semibold tabular-nums text-text">{value}</span> {label}
    </li>
  );
}

/** A real decision from breaker.events, shown the way the demo shows a step. */
function Decision({ n, event }: { n: number; event: BreakerEvent }) {
  const denied = event.decision === "deny";
  return (
    <motion.li
      layout
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={softSpring}
      className={`rounded-lg border bg-raised px-3 py-2.5 ${denied ? "border-deny/50" : "border-line"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{n}</span>
        <span className="text-[13px] font-semibold">{STEP_LABEL[kindOf(event)]}</span>
        <Chip tone={denied ? "deny" : "allow"}>
          <Icon name={denied ? "x" : "check"} className="h-3 w-3" />
          {denied ? "Denied" : "Allowed"}
        </Chip>
        {denied && <code className="font-mono text-[11px] text-deny">{event.rule}</code>}
      </div>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">{event.sql}</pre>
    </motion.li>
  );
}

/** The real Breaker service, drawn in the same structure as the Live demo. */
export function LiveService() {
  const [loaded, setLoaded] = useState<Loaded>({ data: null, at: null, error: null });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const tick = () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      request = new AbortController();
      fetchState(request.signal).then(
        (data) => {
          if (!request!.signal.aborted) setLoaded({ data, at: new Date().toISOString(), error: null });
          timer = setTimeout(tick, POLL_MS);
        },
        (err: unknown) => {
          // A failed poll keeps the last picture on screen: it was still a real moment.
          if (!request!.signal.aborted)
            setLoaded((last) => ({ ...last, error: err instanceof Error ? err.message : "The service could not be read." }));
          timer = setTimeout(tick, POLL_MS);
        },
      );
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
      request?.abort();
    };
  }, []);

  const { data, at, error } = loaded;
  // The session the newest decision belongs to: the one that is happening, or just happened.
  const latestSession = data?.events[0]?.session_id ?? null;
  const sessionRow = data?.sessions.find((s) => s.id === latestSession) ?? null;
  const events = latestSession ? (data?.events.filter((e) => e.session_id === latestSession) ?? []) : [];
  const { asc, hops, submitted, leaked, contained } = derive(events);
  const newestId = asc.length ? asc[asc.length - 1].id : 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Live service</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            The same picture as the Live demo, but every step here is a real decision the Breaker just made. Trigger one from the{" "}
            <Link href="/victim/admin" className="text-brand underline hover:brightness-110">
              Victim app
            </Link>{" "}
            with the Breaker on, from the SQL Breaker tab, or over the HTTP API, and it appears within a few seconds.
          </p>
        </div>
        {data && (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Figure value={data.totals.allowed} label="allowed" />
            <Figure value={data.totals.denied} label="denied" />
            <Figure value={data.totals.sessions} label={data.totals.sessions === 1 ? "session" : "sessions"} />
          </ul>
        )}
      </header>

      <p role="status" aria-live="polite" className={`flex items-center gap-1.5 text-xs ${error ? "text-hold" : "text-muted"}`}>
        {error && <Icon name="alert" className="h-3 w-3 shrink-0" />}
        {error ?? (at ? `Live. Updated at ${time(at)}.` : "Reading the service.")}
      </p>

      {submitted ? (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Session <code className="font-mono text-text">{latestSession}</code>
                {sessionRow?.label && <> · {sessionRow.label}</>}
              </p>
              <Stage runKey={`${latestSession}:${newestId}`} hops={hops} submitted={submitted} leaked={leaked} contained={contained} />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Decisions on this session</p>
              <ol className="space-y-1.5">
                {asc.map((e, i) => (
                  <Decision key={e.id} n={i + 1} event={e} />
                ))}
              </ol>
            </div>
          </div>

          <p
            className={`flex items-start gap-2 rounded-xl border bg-panel px-4 py-3 text-sm leading-snug ${
              leaked ? "border-deny/50" : contained ? "border-allow/40" : "border-line"
            }`}
          >
            <Icon
              name={leaked ? "alert" : "shield"}
              className={`mt-0.5 h-4 w-4 shrink-0 ${leaked ? "text-deny" : contained ? "text-allow" : "text-muted"}`}
            />
            <span className="min-w-0">
              {leaked
                ? "A token value reached the ticket reply. This session was not contained."
                : contained
                  ? "The injection still happened. The leak did not: the token read and the write were refused."
                  : `${asc.length} decision${asc.length === 1 ? "" : "s"} on this session so far.`}
            </span>
          </p>
        </>
      ) : (
        <div className="rounded-xl border border-line bg-panel">
          <Empty>
            No live decisions yet. Run the attack from the Victim app with the Breaker on, or run a scenario in the SQL Breaker tab, and it
            shows up here.
          </Empty>
        </div>
      )}
    </div>
  );
}
