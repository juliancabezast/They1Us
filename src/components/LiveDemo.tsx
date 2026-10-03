"use client";

import { useEffect, useRef, useState } from "react";
import { FIXTURES } from "@/lib/fixtures";
import { CATALOG } from "@/lib/policy";
import type { EventRow, TicketRow } from "@/lib/types";
import { Chip, DecisionBadge, Icon, TicketBody, button } from "./ui";

const ATTACK_TICKET = FIXTURES[2];
const STEP_MS = 300;

interface Run {
  events: EventRow[];
  ticket: TicketRow;
}

/** Floating entry point to a three-click version of the attack replay, on the real backend. */
export function LiveDemo() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [submitted, setSubmitted] = useState(false);
  const [breakerOn, setBreakerOn] = useState(false);
  const [run, setRun] = useState<(Run & { protected: boolean }) | null>(null);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Real results, revealed one step at a time so the sequence is readable.
  useEffect(() => {
    if (!run || shown >= run.events.length) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setShown(still ? run.events.length : shown + 1), still ? 0 : STEP_MS);
    return () => clearTimeout(t);
  }, [run, shown]);

  const runAgent = async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    setShown(0);
    try {
      // Two different server paths. There is no flag that turns the gateway off.
      const res = await fetch(breakerOn ? "/api/runs/attack" : "/api/sandbox/attack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pace: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      setRun({ ...data, protected: breakerOn });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const replay = () => {
    setSubmitted(false);
    setBreakerOn(false);
    setRun(null);
    setShown(0);
    setError(null);
  };

  const finished = run !== null && shown >= run.events.length;

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full border border-allow/50 bg-panel px-4 py-2.5 text-sm font-semibold text-allow shadow-lg shadow-black/40 hover:bg-raised"
      >
        <Icon name="shield" className="h-4 w-4" />
        Live demo
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="live-demo-title"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
        className="m-auto w-[min(680px,100vw)] rounded-2xl border border-line bg-panel p-0 text-text max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:rounded-none"
      >
        <div className="flex max-h-[85dvh] flex-col max-sm:max-h-none max-sm:h-full">
          <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 id="live-demo-title" className="flex items-center gap-2 text-base font-semibold">
              <Icon name="shield" className="h-4 w-4 text-allow" /> Live demo
              <Chip>Deterministic replay</Chip>
            </h2>
            <button type="button" onClick={() => dialog.current?.close()} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:text-text">
              <Icon name="x" className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <section>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-mono text-xs uppercase tracking-wider text-muted">support_tickets</h3>
                {!submitted && (
                  <button type="button" onClick={() => setSubmitted(true)} className={button.primary}>
                    Submit ticket
                  </button>
                )}
              </div>
              <div className="mt-2 rounded-lg border border-line bg-raised p-3">
                {submitted ? (
                  <div className="event-in">
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      <Chip>{ATTACK_TICKET.customer_email}</Chip>
                      <Chip tone="untrusted">body · untrusted</Chip>
                      <Chip tone="deny">injected instruction</Chip>
                    </div>
                    <TicketBody body={ATTACK_TICKET.body} />
                  </div>
                ) : (
                  <Chip>No attacker ticket yet</Chip>
                )}
              </div>
            </section>

            {submitted && (
              <section>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={breakerOn}
                    disabled={busy}
                    onClick={() => setBreakerOn((v) => !v)}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm font-medium ${
                      breakerOn ? "border-allow/50 bg-allow/10 text-allow" : "border-deny/50 bg-deny/10 text-deny"
                    }`}
                  >
                    <span className={`relative h-5 w-9 rounded-full ${breakerOn ? "bg-allow" : "bg-deny/60"}`}>
                      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all ${breakerOn ? "left-[18px]" : "left-0.5"}`} />
                    </span>
                    Breaker {breakerOn ? "on" : "off"}
                  </button>
                  <button type="button" disabled={busy} onClick={runAgent} className={button.primary}>
                    {busy ? "Running" : "Run agent"}
                  </button>
                  <button type="button" onClick={replay} className={`${button.quiet} ml-auto`}>
                    Replay
                  </button>
                </div>

                {error && <p className="mt-3"><Chip tone="deny">{error}</Chip></p>}

                {run && (
                  <ol className="mt-3 space-y-2">
                    {run.events.slice(0, shown).map((e) => (
                      <li key={e.id} className={`event-in rounded-lg border bg-raised p-3 ${e.decision === "DENIED" ? "border-deny/50" : "border-line"}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-[13px]">{e.operation}</code>
                          <DecisionBadge decision={e.decision} />
                          {e.decision === "ALLOWED" && e.state_after?.untrusted && !e.state_before?.untrusted && <Chip tone="untrusted">context tainted</Chip>}
                          {e.decision === "DENIED" && <Chip tone="deny">secret read in tainted context</Chip>}
                          {e.decision === "APPROVAL_REQUIRED" && <Chip tone="hold">held for a human</Chip>}
                        </div>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted">{CATALOG.get(e.operation)?.sql}</pre>
                      </li>
                    ))}
                  </ol>
                )}

                {finished && (
                  <div className="event-in mt-3 flex flex-wrap items-center gap-2">
                    {run.ticket.reply ? (
                      <>
                        <Chip tone="deny"><Icon name="alert" className="h-3 w-3" /> Token leaked</Chip>
                        <code className="break-all rounded bg-deny/10 px-1.5 py-0.5 font-mono text-xs text-deny">{run.ticket.reply}</code>
                      </>
                    ) : (
                      <Chip tone="allow"><Icon name="shield" className="h-3 w-3" /> Attack contained</Chip>
                    )}
                    {!run.protected && <Chip>Now turn the Breaker on</Chip>}
                  </div>
                )}
              </section>
            )}
          </div>

          <footer className="border-t border-line px-5 py-3 text-xs text-muted">
            No model judging a model: a fixed catalog declares what each operation touches.
          </footer>
        </div>
      </dialog>
    </>
  );
}
