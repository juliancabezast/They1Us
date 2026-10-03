"use client";

import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SCENARIOS, type ScenarioId } from "@core/scenarios";
import type { DashboardRun } from "@/lib/breaker-api";
import { Lane } from "../breaker/Lane";
import { BreakerReference } from "../breaker/Reference";
import { ScenarioPicker } from "../breaker/ScenarioPicker";
import { verdict } from "../breaker/verdict";
import { softSpring } from "../motion";
import { Icon, button } from "../ui";

// The API returns every step of both lanes at once. The pacing is ours: each statement stays long enough to be read.
const STATEMENT_MS = 5000;
// A refusal comes with a rule and a reason, so it stays longer.
const REFUSAL_MS = 7000;
const FIRST_MS = 150;
// A statement resumed near the end of its time is not swapped out the moment the pause ends.
const RESUME_MS = 1200;

interface Runs {
  off: DashboardRun;
  on: DashboardRun;
}

/** How long beat `beat` stays on screen before the next statement is sent. */
const dwell = (runs: Runs, beat: number) =>
  beat === 0 ? FIRST_MS : runs.on.steps[beat - 1]?.outcome === "deny" ? REFUSAL_MS : STATEMENT_MS;

// How a pacing control looks while there is nothing to pace.
const CONTROL = "aria-disabled:pointer-events-none aria-disabled:opacity-40";

// Where typing happens, the keys belong to the field.
const TYPING = "input, textarea, select, [contenteditable='true']";
// A focused control keeps its own Space.
const OWN_SPACE = "button:not(:disabled), a[href], summary, [role='button'], [role='tab']";

const TONES = {
  allow: { border: "border-allow/40", icon: "text-allow" },
  hold: { border: "border-hold/50", icon: "text-hold" },
  deny: { border: "border-deny/50", icon: "text-deny" },
};

const isRun = (v: unknown): v is DashboardRun =>
  typeof v === "object" && v !== null && Array.isArray((v as DashboardRun).steps) && Boolean((v as DashboardRun).ticket);

/**
 * One request for both lanes. It names a scenario and never carries SQL: the statements live on the server,
 * which clears the rows of the previous run before it sends them.
 */
async function requestDemo(scenario: ScenarioId): Promise<Runs> {
  const res = await fetch("/api/breaker/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `The backend answered ${res.status}.`);
  if (!isRun(data?.off) || !isRun(data?.on)) throw new Error("The backend returned something that is not a run.");
  return { off: data.off, on: data.on };
}

/** The same agent sends the same SQL twice: once straight at the customer's database, once through the Breaker. */
export function SqlBreaker() {
  const still = useReducedMotion() ?? false;
  const [scenario, setScenario] = useState<ScenarioId>("A");
  const [runs, setRuns] = useState<Runs | null>(null);
  // Beat b: statements 1 to b have been sent. One beat past the last statement, both lanes have settled.
  const [beat, setBeat] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runSeq, setRunSeq] = useState(0);
  const [paused, setPaused] = useState(false);
  // Counts every moment the decision log has to be read again: a run ended, failed, or was dropped.
  const [logKey, setLogKey] = useState(0);
  // Answers of a run that was replaced (another scenario, another click) are dropped.
  const latest = useRef(0);
  // How long the statement on screen had been up when the run was paused, so resuming gives it the rest.
  const spent = useRef<{ runs: Runs | null; beat: number; ms: number }>({ runs: null, beat: 0, ms: 0 });
  const pauseButton = useRef<HTMLButtonElement>(null);

  const total = runs ? Math.max(runs.off.steps.length, runs.on.steps.length) : 0;
  const shown = Math.min(beat, total);
  const finished = runs !== null && beat > total;
  /** A run is on screen and has statements left: the only time the pacing controls and keys do anything. */
  const active = runs !== null && !finished;
  const running = busy || active;

  /** Sends the statement after beat `from`, or settles the run when there is none left. */
  const step = useCallback(
    (from: number) => {
      if (from > total) return;
      setBeat(from + 1);
      if (from + 1 > total) setLogKey((n) => n + 1);
    },
    [total],
  );

  // Reduced motion keeps this clock: reading time is not motion. Only the packets stay put.
  useEffect(() => {
    if (!runs || beat > total || paused) return;
    const before = spent.current.runs === runs && spent.current.beat === beat ? spent.current.ms : 0;
    const left = dwell(runs, beat) - before;
    const started = performance.now();
    const timer = setTimeout(() => step(beat), before > 0 ? Math.max(left, RESUME_MS) : left);
    return () => {
      clearTimeout(timer);
      spent.current = { runs, beat, ms: before + performance.now() - started };
    };
  }, [runs, beat, total, paused, step]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      // An open dialog owns the keyboard.
      if (target?.closest(TYPING) || document.querySelector("dialog[open]")) return;
      if (e.key === " ") {
        if (target?.closest(OWN_SPACE)) return;
        // Otherwise Space scrolls the page.
        e.preventDefault();
        setPaused((p) => !p);
      } else {
        e.preventDefault();
        step(beat);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, beat, step]);

  const run = async () => {
    const mine = ++latest.current;
    setBusy(true);
    setError(null);
    setRuns(null);
    setBeat(0);
    setPaused(false);
    setRunSeq((n) => n + 1);
    // The run button is disabled from here on. Focus goes to the control the reader needs next, so Space pauses.
    pauseButton.current?.focus({ preventScroll: true });
    let answer: Runs | null = null;
    let problem = "";
    try {
      answer = await requestDemo(scenario);
    } catch (err) {
      problem = err instanceof TypeError ? "The request did not reach the backend." : err instanceof Error ? err.message : "The request failed.";
    }
    if (mine !== latest.current) return;
    setBusy(false);
    if (answer) {
      setRuns(answer);
      return;
    }
    setError(`The scenario did not run. ${problem}`);
    // The server may have cleared the log before it failed.
    setLogKey((n) => n + 1);
  };

  const pick = (id: ScenarioId) => {
    if (id === scenario) return;
    latest.current++;
    // A run that is dropped halfway already cleared the log on the server.
    if (running) setLogKey((n) => n + 1);
    setScenario(id);
    setRuns(null);
    setBeat(0);
    setBusy(false);
    setPaused(false);
    setError(null);
  };

  const current = SCENARIOS[scenario];
  const result = finished && runs ? verdict(runs.off, runs.on) : null;

  // For screen readers: what the statement that was just sent ran into, in both lanes.
  const offStep = runs && shown > 0 ? runs.off.steps[shown - 1] : undefined;
  const onStep = runs && shown > 0 ? runs.on.steps[shown - 1] : undefined;
  const progress = busy
    ? `Running scenario ${scenario} with the Breaker off and on.`
    : runs && !finished && shown > 0
      ? [
          `Statement ${shown} of ${total}.`,
          offStep && `Breaker off: ${offStep.outcome === "failed" ? `failed with SQLSTATE ${offStep.errorCode ?? "unknown"}` : "executed"}.`,
          onStep && `Breaker on: ${onStep.outcome === "deny" ? `refused by ${onStep.rule}` : "allowed"}.`,
        ]
          .filter(Boolean)
          .join(" ")
      : "";

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-semibold tracking-tight">SQL Breaker</h2>
        <p className="mt-1 text-sm text-muted">
          The Breaker sits between an AI agent and the customer&apos;s database and checks every statement before it runs, so one session
          never holds both untrusted data and secrets.
        </p>
      </header>

      <div className="space-y-3">
        <ScenarioPicker value={scenario} onChange={pick} />
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <p className="min-w-0 flex-1 basis-72 text-[15px] leading-snug">{current.summary}</p>
          <div className="flex flex-col gap-2 sm:items-end">
            <button type="button" disabled={running} onClick={run} className={`${button.primary} min-w-32 px-5 py-2.5`}>
              {running ? "Running..." : runs ? "Run again" : "Run scenario"}
            </button>
            {/* aria-disabled, not disabled: the focus that lands here when a run starts must survive its end. */}
            <div role="group" aria-label="Pacing" className="flex flex-wrap gap-2">
              <button
                ref={pauseButton}
                type="button"
                aria-disabled={!active}
                onClick={() => active && setPaused(!paused)}
                className={`${button.secondary} min-w-24 ${CONTROL}`}
              >
                {/* A run stepped to its end while paused leaves nothing to resume. */}
                {active && paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                aria-disabled={!active}
                onClick={() => {
                  if (!active) return;
                  step(beat);
                  // Space must keep meaning Pause or Resume, not "next" again.
                  pauseButton.current?.focus({ preventScroll: true });
                }}
                className={`${button.secondary} ${CONTROL}`}
              >
                Next statement
              </button>
            </div>
            <p className="min-h-4 text-xs text-muted sm:text-right">
              {active && shown > 0 ? (
                `${paused ? "Paused on statement" : "Statement"} ${shown} of ${total}`
              ) : (
                <span className="hidden sm:inline">Space pauses, right arrow advances.</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-deny/40 bg-deny/10 px-3 py-2 text-sm text-deny">
          <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Lane key={`off-${scenario}-${runSeq}`} mode="unprotected" scenario={current} run={runs?.off ?? null} shown={shown} still={still} />
        <Lane key={`on-${scenario}-${runSeq}`} mode="protected" scenario={current} run={runs?.on ?? null} shown={shown} still={still} />
      </div>

      {/* The space is kept from the start, so the verdict does not push the page down when it arrives. */}
      <div aria-live="polite" className="min-h-14">
        <p className="sr-only">{progress}</p>
        <p className="sr-only">{active && paused ? "Paused." : ""}</p>
        {result && (
          <motion.p
            initial={still ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={softSpring}
            className={`flex items-start gap-3 rounded-xl border bg-panel px-4 py-3.5 text-base leading-snug sm:text-lg ${TONES[result.tone].border}`}
          >
            <Icon
              name={result.tone === "allow" ? "shield" : "alert"}
              className={`mt-0.5 h-5 w-5 shrink-0 sm:mt-1 ${TONES[result.tone].icon}`}
            />
            <span className="min-w-0">
              {result.parts.map((part, i) =>
                typeof part === "string" ? (
                  part
                ) : (
                  <code key={i} className="font-mono text-[0.9em] font-semibold [overflow-wrap:anywhere]">
                    {part.code}
                  </code>
                ),
              )}
            </span>
          </motion.p>
        )}
      </div>

      {/* The log waits for the lanes: the server has every row of the run already, and they would give the ending away. */}
      <BreakerReference refreshKey={logKey} paused={running} />
    </div>
  );
}
