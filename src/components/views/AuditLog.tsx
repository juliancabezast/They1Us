"use client";

import { useState } from "react";
import { REASONS } from "@/lib/policy";
import { DecisionBadge, Empty, Panel, button, shortId, time } from "../ui";
import type { ViewProps } from "./props";

const select = "rounded-lg border border-line bg-raised px-2.5 py-1.5 text-sm";

export function AuditLog({ state }: ViewProps) {
  const [decision, setDecision] = useState("");
  const [session, setSession] = useState("");
  const [operation, setOperation] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const uniq = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
  const rows = state.events.filter(
    (e) => (!decision || e.decision === decision) && (!session || e.session_id === session) && (!operation || e.operation === operation),
  );

  const exportJson = () => {
    // Events are already redacted on the server: free text is a hash and a length.
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), policy_version: state.policyVersion, events: rows }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "trifecta-breaker-audit.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Panel
      title="Audit log"
      aside={
        <button type="button" onClick={exportJson} disabled={!rows.length} className={button.secondary}>
          Export JSON
        </button>
      }
    >
      <div className="flex flex-wrap gap-2">
        <label className="text-sm">
          <span className="sr-only">Decision</span>
          <select value={decision} onChange={(e) => setDecision(e.target.value)} className={select}>
            <option value="">All decisions</option>
            {uniq(state.events.map((e) => e.decision)).map((d) => <option key={d}>{d}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="sr-only">Operation</span>
          <select value={operation} onChange={(e) => setOperation(e.target.value)} className={select}>
            <option value="">All operations</option>
            {uniq(state.events.map((e) => e.operation)).map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="sr-only">Session</span>
          <select value={session} onChange={(e) => setSession(e.target.value)} className={select}>
            <option value="">All sessions</option>
            {uniq(state.events.map((e) => e.session_id)).map((s) => <option key={s} value={s}>{shortId(s)}</option>)}
          </select>
        </label>
        <span className="ml-auto self-center text-sm text-muted">{rows.length} of {state.events.length} events</span>
      </div>

      {rows.length === 0 ? (
        <Empty>{state.events.length ? "No events match these filters." : "No events yet."}</Empty>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {rows.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                aria-expanded={open === e.id}
                onClick={() => setOpen(open === e.id ? null : e.id)}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left hover:bg-raised"
              >
                <span className="w-14 font-mono text-xs text-muted">#{e.id}</span>
                <span className="w-16 font-mono text-xs text-muted">{time(e.created_at)}</span>
                <code className="w-48 font-mono text-[13px]">{e.operation}</code>
                <DecisionBadge decision={e.decision} />
                <span className="font-mono text-xs text-muted">{e.reason_code}</span>
              </button>
              {open === e.id && (
                <div className="mb-3 rounded-lg border border-line bg-raised p-3">
                  <p className="text-sm">{REASONS[e.reason_code]}</p>
                  <pre className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed text-muted">{JSON.stringify(e, null, 2)}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
