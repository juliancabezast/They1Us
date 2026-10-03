"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SCENARIOS, type Mode, type ScenarioId } from "@core/scenarios";
import type { DashboardRun } from "@/lib/breaker-api";
import { Lane } from "../breaker/Lane";
import { BreakerReference } from "../breaker/Reference";
import { ScenarioPicker } from "../breaker/ScenarioPicker";
import { verdict } from "../breaker/verdict";
import { softSpring } from "../motion";
import { Icon, button } from "../ui";

// The API returns every step at once. The pacing is ours, so each statement can be watched.
const STEP_MS = 1100;

interface Runs {
  off: DashboardRun;
  on: DashboardRun;
}

const TONES = {
  allow: { border: "border-allow/40", icon: "text-allow" },
  hold: { border: "border-hold/50", icon: "text-hold" },
  deny: { border: "border-deny/50", icon: "text-deny" },
};

/** The request names a scenario and a mode. It never carries SQL: the statements live on the server. */
async function requestRun(scenario: ScenarioId, mode: Mode): Promise<DashboardRun> {
  const res = await fetch("/api/breaker/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario, mode }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `The backend answered ${res.status}.`);
  if (!Array.isArray(data?.steps) || !data.ticket) throw new Error("The backend returned something that is not a run.");
  return data as DashboardRun;
}

const problem = (lane: string, result: PromiseSettledResult<DashboardRun>) =>
  result.status === "rejected" ? `${lane}: ${result.reason instanceof Error ? result.reason.message : "the request failed."}` : null;

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
  const [completed, setCompleted] = useState(0);
  // Answers of a run that was replaced (another scenario, another click) are dropped.
  const latest = useRef(0);

  const total = runs ? Math.max(runs.off.steps.length, runs.on.steps.length) : 0;
  const shown = Math.min(beat, total);
  const finished = runs !== null && beat > total;
  const running = busy || (runs !== null && !finished);

  useEffect(() => {
    if (!runs || beat > total) return;
    const timer = setTimeout(
      () => {
        const next = still ? total + 1 : beat + 1;
        setBeat(next);
        if (next > total) setCompleted((n) => n + 1);
      },
      still ? 0 : beat === 0 ? 150 : STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [runs, beat, total, still]);

  const run = async () => {
    const mine = ++latest.current;
    setBusy(true);
    setError(null);
    setRuns(null);
    setBeat(0);
    setRunSeq((n) => n + 1);
    const [off, on] = await Promise.allSettled([requestRun(scenario, "unprotected"), requestRun(scenario, "protected")]);
    if (mine !== latest.current) return;
    setBusy(false);
    if (off.status === "fulfilled" && on.status === "fulfilled") {
      setRuns({ off: off.value, on: on.value });
      return;
    }
    const problems = [problem("Breaker off", off), problem("Breaker on", on)].filter(Boolean);
    setError(`The scenario did not run. ${problems.join(" ")}`);
  };

  const pick = (id: ScenarioId) => {
    if (id === scenario) return;
    latest.current++;
    setScenario(id);
    setRuns(null);
    setBeat(0);
    setBusy(false);
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
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="min-w-0 flex-1 basis-72 text-[15px] leading-snug">{current.summary}</p>
          <button type="button" disabled={running} onClick={run} className={`${button.primary} min-w-32 px-5 py-2.5`}>
            {running ? "Running..." : runs ? "Run again" : "Run scenario"}
          </button>
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

      {/* The log waits for the lanes: its rows would give the ending away while the statements are still travelling. */}
      <BreakerReference refreshKey={completed} paused={running} />
    </div>
  );
}
