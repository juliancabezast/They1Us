"use client";

import { motion } from "motion/react";
import { useCallback, useState } from "react";
import { ATTACKER_TICKET, type Mode, type Scenario, type StepResult } from "@core/scenarios";
import type { DashboardRun } from "@/lib/breaker-api";
import { RULES } from "@core/types";
import { bouncy, spring } from "../motion";
import { Chip, Icon, shortId } from "../ui";
import { Architecture } from "./Architecture";
import { Track, gateName } from "./Track";

function Stamp({ kind, set, tracked, still }: { kind: "untrusted" | "secret"; set: boolean; tracked: boolean; still: boolean }) {
  const lit = kind === "untrusted" ? "border-untrusted/50 bg-untrusted/15 text-untrusted" : "border-secret/50 bg-secret/15 text-secret";
  return (
    <motion.span
      key={set ? "set" : "clear"}
      initial={set && !still ? { scale: 0.4 } : false}
      animate={{ scale: 1 }}
      transition={bouncy}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${
        set ? lit : `border-line text-muted ${tracked ? "" : "border-dashed"}`
      }`}
    >
      {set && <Icon name="check" className="h-3 w-3" />}
      {kind}
      <span className="sr-only">{set ? "set" : tracked ? "not set" : "not tracked"}</span>
    </motion.span>
  );
}

/** What happened to one statement, in plain words. */
function Outcome({ step, guarded }: { step: StepResult; guarded: boolean }) {
  if (step.outcome === "deny") {
    return (
      <>
        <span className="sr-only">Refused at {gateName(step.stoppedAt)}. </span>
        <code className="font-mono text-xs font-semibold text-deny">{step.rule}</code>{" "}
        {step.reason ?? (step.rule ? RULES[step.rule] : "")}
      </>
    );
  }
  if (step.outcome === "failed" || step.errorCode !== null) {
    const state = step.errorCode ? `SQLSTATE ${step.errorCode}` : "an error";
    return (
      <>
        <span className="font-medium text-hold">{guarded ? "Allowed, then failed." : "Failed."}</span>{" "}
        <span className="text-muted">
          {step.errorCode === "42501" ? `The database role itself refused it (${state}).` : `Postgres answered ${state}.`}
        </span>
      </>
    );
  }
  if (!guarded) return <span className="text-muted">Executed. Nothing checked it.</span>;

  const { flagsBefore: before, flagsAfter: after } = step;
  const stamped = [
    after?.hasUntrusted && !before?.hasUntrusted ? "untrusted" : null,
    after?.hasSecret && !before?.hasSecret ? "secret" : null,
  ].filter(Boolean);
  return (
    <>
      <span className="font-medium text-allow">Allowed.</span>{" "}
      <span className="text-muted">
        {stamped.length ? `The session is now stamped ${stamped.join(" and ")}.` : (step.reason ?? RULES.ALLOW)}
      </span>
    </>
  );
}

function StepRow({
  n,
  display,
  step,
  arrived,
  guarded,
  still,
  onArrive,
}: {
  n: number;
  /** The statement as written in the scenario, shown until the real one is sent. */
  display: string;
  step: StepResult | null;
  arrived: boolean;
  guarded: boolean;
  still: boolean;
  onArrive: (n: number) => void;
}) {
  const refused = arrived && step?.outcome === "deny";
  return (
    <li className={`rounded-lg border bg-raised px-3 py-3 ${refused ? "border-deny/50" : "border-line"}`}>
      <div className="flex items-start gap-2.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-text/5 font-mono text-[11px] text-muted">
          <span className="sr-only">Statement </span>
          {n}
        </span>
        <code className="min-w-0 font-mono text-[13px] leading-5 [overflow-wrap:anywhere]">{step?.sql ?? display}</code>
      </div>
      <Track key={step ? "sent" : "rest"} step={step} guarded={guarded} arrived={arrived} still={still} onArrive={onArrive} />
      {/* Two lines are reserved so the rows of both lanes stay level while results come in. */}
      <p className="mt-2.5 min-h-10 text-sm leading-5">
        {arrived && step && (
          <motion.span
            initial={still ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
            className="block"
          >
            <Outcome step={step} guarded={guarded} />
          </motion.span>
        )}
      </p>
    </li>
  );
}

/** The attacker's ticket, as the attacker sees it once the run is over. */
function AttackerTicket({ run, finished, still }: { run: DashboardRun | null; finished: boolean; still: boolean }) {
  const reply = finished ? (run?.ticket.reply ?? null) : null;
  const leaked = finished && run !== null && run.leaked;
  return (
    <div className="border-t border-line p-3 sm:p-4">
      <h4 className="text-sm font-semibold">What the attacker sees</h4>
      <div
        className={`mt-2 rounded-lg border p-3 ${
          leaked ? "border-deny/50 bg-deny/10" : finished && !reply ? "border-allow/40 bg-allow/10" : "border-line bg-raised"
        }`}
      >
        <p className="text-xs text-muted">
          Reply on {run ? `ticket ${run.ticket.id}` : "the ticket"} filed by {ATTACKER_TICKET.customer_email}
        </p>
        {!finished ? (
          <p className="mt-1 text-sm text-muted">No reply yet.</p>
        ) : leaked ? (
          <>
            <motion.p
              initial={still ? false : { opacity: 0 }}
              animate={still ? { opacity: 1 } : { opacity: 1, x: [0, -7, 7, -5, 5, -2, 0] }}
              transition={{ duration: 0.45, ease: "easeOut" }}
              className="mt-1 break-all font-mono text-xs leading-relaxed text-deny"
            >
              {reply}
            </motion.p>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip tone="deny">
                <Icon name="alert" className="h-3 w-3" /> {run?.replyRedacted ? "Token leaked" : "Fictitious token leaked"}
              </Chip>
              {/* The API cuts a reply that is not the seed's fictitious tokens, unless the operator asks. */}
              {run?.replyRedacted && <span className="text-xs text-muted">Preview only. Sign in as operator to see the full reply.</span>}
            </p>
          </>
        ) : reply ? (
          // Something was written, but none of it is a token.
          <p className="mt-1 break-all font-mono text-xs leading-relaxed">{reply}</p>
        ) : (
          <motion.p
            initial={still ? false : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={bouncy}
            className="mt-1 origin-left text-sm font-medium text-allow"
          >
            No reply. Nothing left the database.
          </motion.p>
        )}
      </div>
    </div>
  );
}

/** One of the two sessions of a run: the same statements, with or without the Breaker in front of the customer's database. */
export function Lane({
  mode,
  scenario,
  run,
  shown,
  still,
}: {
  mode: Mode;
  scenario: Scenario;
  /** null until the run has come back from the API. */
  run: DashboardRun | null;
  /** How many statements have been sent so far. The pacing belongs to the view. */
  shown: number;
  still: boolean;
}) {
  const guarded = mode === "protected";
  const steps = run?.steps ?? [];
  const sent = Math.min(shown, steps.length);

  // A statement counts once its packet has arrived, so stamps and outcomes never run ahead of it.
  const [landedCount, setLandedCount] = useState(0);
  const onArrive = useCallback((n: number) => setLandedCount((c) => Math.max(c, n)), []);
  const landed = still ? sent : Math.min(landedCount, sent);

  const flags = landed > 0 ? steps[landed - 1].flagsAfter : null;
  const finished = run !== null && landed >= steps.length;
  const rows = Math.max(scenario.steps.length, steps.length);

  return (
    <section aria-label={guarded ? "Breaker on" : "Breaker off"} className="min-w-0 rounded-xl border border-line bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Icon name={guarded ? "shield" : "unlock"} className={`h-4 w-4 ${guarded ? "text-allow" : "text-muted"}`} />
            {guarded ? "Breaker on" : "Breaker off"}
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            {guarded ? "Each statement is checked before it runs." : "Each statement goes straight to the customer's database."}
          </p>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>
            Session{run ? <code className="ml-1 font-mono text-[11px]">{shortId(run.sessionId)}</code> : " stamps"}
          </span>
          <Stamp kind="untrusted" set={Boolean(flags?.hasUntrusted)} tracked={guarded} still={still} />
          <Stamp kind="secret" set={Boolean(flags?.hasSecret)} tracked={guarded} still={still} />
          {!guarded && <span aria-hidden="true">not tracked</span>}
        </p>
      </header>

      <Architecture guarded={guarded} />

      <ol className="space-y-2 p-3 sm:p-4">
        {Array.from({ length: rows }, (_, i) => (
          <StepRow
            key={i}
            n={i + 1}
            display={scenario.steps[i]?.display ?? ""}
            step={i < sent ? steps[i] : null}
            arrived={i < landed}
            guarded={guarded}
            still={still}
            onArrive={onArrive}
          />
        ))}
      </ol>

      <AttackerTicket run={run} finished={finished} still={still} />
    </section>
  );
}
