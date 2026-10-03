"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useState } from "react";
import type { BreakerEvent } from "@core/scenarios";
import { RULES } from "@core/types";
import { spring } from "../motion";
import { Chip, Empty, Icon, button, shortId, time } from "../ui";

/** How many decisions show before the reader asks for the rest. */
const FOLD = 8;

/** One session stamp. Lit when the session holds that kind of data; the dot and the hidden text carry it without color. */
export function Stamp({ kind, on }: { kind: "untrusted" | "secret"; on: boolean }) {
  const lit = kind === "untrusted" ? "border-untrusted/40 bg-untrusted/15 text-untrusted" : "border-secret/40 bg-secret/15 text-secret";
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium ${on ? lit : "border-line text-muted/85"}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full border border-current ${on ? "bg-current" : ""}`} />
      {kind}
      <span className="sr-only">{on ? " held" : " not held"}</span>
    </span>
  );
}

// Sentence case on purpose: the shared DecisionBadge prints capitals and speaks the catalog gateway's vocabulary.
function Verdict({ decision }: { decision: BreakerEvent["decision"] }) {
  const allow = decision === "allow";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${
        allow ? "border-allow/40 bg-allow/10 text-allow" : "border-deny/50 bg-deny/10 text-deny"
      }`}
    >
      <Icon name={allow ? "check" : "x"} className="h-3 w-3" />
      {allow ? "Allowed" : "Denied"}
    </span>
  );
}

function Stamps({ when, flags }: { when: string; flags: BreakerEvent["flags_before"] }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="w-10 text-[11px] text-muted">{when}</dt>
      <dd className="flex gap-1">
        <Stamp kind="untrusted" on={flags.hasUntrusted} />
        <Stamp kind="secret" on={flags.hasSecret} />
      </dd>
    </div>
  );
}

/** Memoized: a refresh that brings nothing new hands over the same array and leaves every row alone. */
export const DecisionLog = memo(function DecisionLog({ events }: { events: BreakerEvent[] }) {
  const still = useReducedMotion();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, FOLD);

  return (
    <>
      {events.length === 0 && <Empty>No decisions yet. Run a scenario above.</Empty>}
      {/* The list stays mounted while empty, so the first decision of a run slides in like every later one. */}
      <ol id="breaker-decision-log" className={events.length ? "space-y-2" : undefined}>
        <AnimatePresence initial={false}>
          {shown.map((e) => {
            const denied = e.decision === "deny";
            return (
              <motion.li
                key={e.id}
                layout={!still}
                initial={still ? false : { opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={spring}
                className={`grid gap-x-4 gap-y-2 rounded-lg border bg-raised p-3 lg:grid-cols-[8.5rem_minmax(0,1fr)_auto] ${
                  denied ? "border-deny/50" : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs text-muted lg:flex-col">
                  <time dateTime={e.created_at}>{time(e.created_at)}</time>
                  <span title={e.session_id}>session {shortId(e.session_id)}</span>
                </div>

                <div className="min-w-0">
                  <code className="block whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">{e.sql}</code>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <Verdict decision={e.decision} />
                    <code className="break-all font-mono text-xs">{e.rule}</code>
                    {e.error_code && <Chip tone="hold">Ran and failed with SQLSTATE {e.error_code}</Chip>}
                  </div>
                  {/* An allowed row needs no sentence: the badge already says it. */}
                  {denied && <p className="mt-1.5 text-sm text-deny">{e.reason || RULES[e.rule]}</p>}
                </div>

                <dl className="flex flex-wrap gap-x-4 gap-y-1.5 lg:flex-col lg:items-end">
                  <Stamps when="Before" flags={e.flags_before} />
                  <Stamps when="After" flags={e.flags_after} />
                </dl>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>
      {events.length > FOLD && (
        <button
          type="button"
          aria-expanded={all}
          aria-controls="breaker-decision-log"
          onClick={() => setAll(!all)}
          className={`mt-3 ${button.quiet}`}
        >
          {all ? `Show the newest ${FOLD} only` : `Show all ${events.length} decisions`}
        </button>
      )}
    </>
  );
});
