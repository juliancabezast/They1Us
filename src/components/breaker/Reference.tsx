"use client";

import { useEffect, useRef, useState } from "react";
import type { BreakerEvent, BreakerLabel, BreakerState } from "@core/scenarios";
import { RULES, type Rule } from "@core/types";
import { Chip, Icon, button, time } from "../ui";
import { DecisionLog } from "./ReferenceLog";

/** The order decide() checks them in. The first one that matches refuses the statement. */
const RULE_ORDER: Rule[] = [
  "R0_OPAQUE_STATEMENT",
  "R1_PROTECTED_OBJECT",
  "R5_UNLISTED_FUNCTION",
  "R2_TRIFECTA_MIX",
  "R3_TAINTED_WRITE",
  "R6_SECRET_SINK",
  "R4_OPAQUE_IN_FLAGGED_SESSION",
  "ALLOW",
];

/** How often the log asks for news while the page is visible. Statements from other clients show up within this. */
const POLL_MS = 4000;

// The Breaker's own API (npm run breaker). The only place SQL arrives over HTTP.
const HTTP_EXAMPLE = `curl -X POST http://localhost:3150/sessions

curl -X POST http://localhost:3150/execute \\
  -H 'content-type: application/json' \\
  -d '{"sessionId":"<id>","sql":"SELECT id, subject FROM support_tickets"}'`;

const FUNCTION_EXAMPLE = `import { createSession } from "./core/src/session";
import { guardedExecute } from "./core/src/breaker";
const sessionId = await createSession("my agent");
const result = await guardedExecute(sessionId, "SELECT id, subject FROM support_tickets");`;

const MCP_EXAMPLE = "claude mcp add trifecta-breaker -e BREAKER_URL=http://127.0.0.1:3150 -- npx tsx core/src/mcp.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// The route is written by someone else and may answer anything while it is being built:
// a row the log cannot draw must become a quiet error, not a crashed page.
const isEvent = (v: unknown): v is BreakerEvent =>
  isObject(v) && typeof v.sql === "string" && typeof v.session_id === "string" && isObject(v.flags_before) && isObject(v.flags_after);

const isState = (v: unknown): v is BreakerState =>
  isObject(v) && Array.isArray(v.events) && v.events.every(isEvent) && Array.isArray(v.labels) && v.labels.every(isObject) && isObject(v.totals);

async function fetchState(signal: AbortSignal): Promise<BreakerState> {
  const res = await fetch("/api/breaker/state", { cache: "no-store", signal });
  if (!res.ok) throw new Error(`The decision log could not be loaded (HTTP ${res.status}).`);
  const body: unknown = await res.json();
  if (!isState(body)) throw new Error("The decision log came back in a shape this page cannot read.");
  return body;
}

export interface Loaded {
  /** The request this result answers. Anything else on screen means a request is still out. */
  key: string;
  /** The `refreshKey` this result answers. An older one may hold rows the server has cleared since. */
  run: number;
  data: BreakerState | null;
  /** When `data` arrived. */
  at: string | null;
  error: string | null;
}

function Block({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
        <h3 className="text-base font-semibold">{title}</h3>
        {aside}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <li className="whitespace-nowrap text-sm text-muted">
      <span className="font-mono font-semibold tabular-nums text-text">{value}</span> {label}
    </li>
  );
}

function Labels({ labels }: { labels: BreakerLabel[] }) {
  const tables = new Map<string, BreakerLabel[]>();
  for (const l of labels) {
    const table = `${l.table_schema}.${l.table_name}`;
    tables.set(table, [...(tables.get(table) ?? []), l]);
  }
  if (!tables.size) return <p className="text-sm text-muted">No column is labeled.</p>;
  return (
    <ul className="space-y-2">
      {[...tables].map(([table, columns]) => (
        <li key={table} className="rounded-lg border border-line bg-raised px-3 py-2.5">
          <code className="break-all font-mono text-[13px] font-semibold">{table}</code>
          <ul className="mt-2 space-y-1.5">
            {columns.map((c) => (
              <li key={c.column_name} className="flex items-center justify-between gap-3">
                <code className="min-w-0 break-all font-mono text-[13px] text-muted">{c.column_name}</code>
                <Chip tone={c.label}>{c.label}</Chip>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Snippet({ title, code, children }: { title: string; code: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="text-sm font-semibold">{title}</h4>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-line bg-ink p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <p className="mt-2 text-sm text-muted">{children}</p>
    </div>
  );
}

/**
 * Decision log, labels, rules and how to plug the Breaker into an agent. Refetches when `refreshKey`
 * changes, and on its own every few seconds while the page is visible and not `paused`, so statements
 * sent by other clients (the HTTP API, the MCP server, the victim app) appear without a click.
 * Every run clears the log on the server, so while `paused` (a run is on screen) and until the request
 * that follows it has answered, the rows of the run before are not shown.
 */
export function BreakerReference({ refreshKey, paused = false }: { refreshKey: number; paused?: boolean }) {
  const [manual, setManual] = useState(0);
  const [tick, setTick] = useState(0);
  const requestKey = `${refreshKey}:${manual}`;
  const [loaded, setLoaded] = useState<Loaded>({ key: "", run: refreshKey, data: null, at: null, error: null });
  // A poll never cuts off a request that is still out: on a slow network that would starve the log.
  const waiting = useRef(false);
  // The last request somebody asked for, and how many polls in a row have failed since.
  const asked = useRef("");
  const misses = useRef(0);

  useEffect(() => {
    if (paused) return;
    const poll = () => {
      if (document.visibilityState === "visible" && !waiting.current) setTick((n) => n + 1);
    };
    const timer = setInterval(poll, POLL_MS);
    // Coming back to the tab catches up at once instead of waiting for the next turn.
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [paused]);

  useEffect(() => {
    const request = new AbortController();
    // Same key as last time: nobody asked, this is the poll.
    const poll = asked.current === requestKey;
    asked.current = requestKey;
    waiting.current = true;
    fetchState(request.signal).then(
      (data) => {
        if (request.signal.aborted) return;
        waiting.current = false;
        misses.current = 0;
        // Nothing new keeps the same object, so the rows on screen are not touched at all.
        setLoaded((last) => ({
          key: requestKey,
          run: refreshKey,
          data: last.data && JSON.stringify(last.data) === JSON.stringify(data) ? last.data : data,
          at: new Date().toISOString(),
          error: null,
        }));
      },
      (err: unknown) => {
        if (request.signal.aborted) return;
        waiting.current = false;
        misses.current += 1;
        // One poll that lands while the server is clearing the log is not news: the next one is seconds away.
        if (poll && misses.current < 2) return;
        // A failed refresh keeps the last log on screen: stale decisions are still true decisions.
        // Unless a run has cleared them since: then they are gone, and showing them would be wrong.
        setLoaded((last) => ({
          ...last,
          key: requestKey,
          run: refreshKey,
          data: last.run === refreshKey ? last.data : null,
          at: last.run === refreshKey ? last.at : null,
          error: err instanceof Error ? err.message : "The decision log could not be loaded.",
        }));
      },
    );
    return () => {
      request.abort();
      waiting.current = false;
    };
  }, [requestKey, refreshKey, tick]);

  return (
    <ReferenceView
      loaded={loaded}
      loading={loaded.key !== requestKey}
      cleared={paused || loaded.run !== refreshKey}
      onRefresh={() => setManual((n) => n + 1)}
    />
  );
}

// One array for every cleared render, so the memoized log is not redrawn while a run plays.
const NO_EVENTS: BreakerEvent[] = [];

/** Everything on screen, given what the last request brought back. No fetching in here. */
export function ReferenceView({
  loaded,
  loading,
  cleared = false,
  onRefresh,
}: {
  loaded: Loaded;
  loading: boolean;
  /** A run has cleared the log on the server and the rows that replace it are not here yet. */
  cleared?: boolean;
  onRefresh: () => void;
}) {
  const { data, at } = loaded;
  // What was loaded before the clear is neither shown nor reported as a problem.
  const error = cleared ? null : loaded.error;
  const problem = error
    ? `${error} ${at ? `Showing what was loaded at ${time(at)}.` : "The rules and the setup below do not depend on it."}`
    : "";

  return (
    <div className="space-y-5">
      <Block
        title="Decision log"
        aside={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {data && !cleared && (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                <Figure value={data.totals.allowed} label="allowed" />
                <Figure value={data.totals.denied} label="denied" />
                <Figure value={data.totals.sessions} label={data.totals.sessions === 1 ? "session" : "sessions"} />
              </ul>
            )}
            <button type="button" onClick={onRefresh} disabled={loading || cleared} className={button.secondary}>
              Refresh
            </button>
          </div>
        }
      >
        {/* Only a problem is announced. The clock below moves with every refresh and would talk over the page. */}
        <p role="status" aria-live="polite" className={error ? "flex items-start gap-1.5 text-xs text-hold" : "sr-only"}>
          {error && <Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0" />}
          {problem}
        </p>
        {!error && (
          <p className="text-xs text-muted">
            {cleared
              ? "Every run starts from an empty log. The decisions of this one show up when its last statement has landed."
              : at
                ? `Updated at ${time(at)}. Statements sent through the API, the MCP server or another app show up here within seconds.`
                : "Loading the decision log."}
          </p>
        )}
        {data && (
          <div className="mt-3">
            <DecisionLog events={cleared ? NO_EVENTS : data.events} waiting={cleared} />
          </div>
        )}
      </Block>

      <Block title="Labels and rules">
        <p className="text-sm text-muted">
          Labels are kept in the Breaker&apos;s database and point at columns in the customer&apos;s database. Stamps live on the session, and
          every decision is made on the state the session would be in if the statement ran.
        </p>
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">Labeled columns</h4>
            <p className="mb-2 mt-1 text-sm text-muted">Reading a labeled column stamps the session with its label.</p>
            {data ? (
              <Labels labels={data.labels} />
            ) : (
              <p className="text-sm text-muted">{loaded.error ? "The labels come with the decision log, which could not be loaded." : "Loading the labels."}</p>
            )}
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">Rules, in the order they are checked</h4>
            <p className="mb-2 mt-1 text-sm text-muted">The first rule that matches refuses the statement. If none matches, it runs.</p>
            <ol className="space-y-2">
              {RULE_ORDER.map((rule, i) => (
                <li key={rule} className="flex gap-3 rounded-lg border border-line bg-raised px-3 py-2">
                  <span aria-hidden="true" className="mt-0.5 w-4 shrink-0 font-mono text-xs tabular-nums text-muted">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <code className={`break-all font-mono text-[13px] font-semibold ${rule === "ALLOW" ? "text-allow" : ""}`}>{rule}</code>
                    <p className="text-sm text-muted">{RULES[rule]}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </Block>

      <Block title="Use it from your own agent">
        <p className="text-sm text-muted">
          Only the Breaker holds the customer&apos;s connection string, so the agent&apos;s only path to data is through it.
        </p>
        <div className="mt-4 grid gap-5 xl:grid-cols-3">
          <Snippet title="Over HTTP" code={HTTP_EXAMPLE}>
            Start it with npm run breaker. The first call opens a clean session. The second answers 200 for allow and for deny, with the rule,
            the reason and the stamps before and after.
          </Snippet>
          <Snippet title="As a function" code={FUNCTION_EXAMPLE}>
            The same call the HTTP API makes, for an agent that runs in this codebase.
          </Snippet>
          <Snippet title="As an MCP server" code={MCP_EXAMPLE}>
            One conversation is one session. The agent gets a single tool, execute_sql, and only the Breaker&apos;s address: no database
            credentials.
          </Snippet>
        </div>
      </Block>
    </div>
  );
}
