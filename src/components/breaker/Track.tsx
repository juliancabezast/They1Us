"use client";

import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { useEffect } from "react";
import type { StepResult } from "@core/scenarios";
import type { Stage } from "@core/types";
import { bouncy, glide } from "../motion";
import { Icon } from "../ui";
import { DatabaseIcon } from "./icons";

/** The four checks a statement passes on its way to the customer's Postgres, in order, and the database each one asks. */
const GATES: { label: string; where?: string }[] = [
  { label: "Pre-check" },
  { label: "EXPLAIN", where: "customer database" },
  { label: "Labels", where: "Breaker database" },
  { label: "Policy" },
];
// Labels are only looked up: nothing is ever refused at that gate.
const STOP_GATE: Record<Stage, number> = { precheck: 0, explain: 1, policy: 3 };
export const gateName = (stage: Stage | null): string => GATES[STOP_GATE[stage ?? "policy"]].label;

// Column widths in fr: a short run-up, the four gates, and Postgres (wider, it shows the row count).
const COLUMNS = [0.5, 1, 1, 1, 1, 1.5];
const TEMPLATE = COLUMNS.map((w) => `minmax(0, ${w}fr)`).join(" ");
const TOTAL = COLUMNS.reduce((a, b) => a + b, 0);
/** The center of every column, as a fraction of the track width. */
const CENTER = COLUMNS.map((w, i) => (COLUMNS.slice(0, i).reduce((a, b) => a + b, 0) + w / 2) / TOTAL);
const POSTGRES = CENTER[CENTER.length - 1];
// A refused packet stops just short of its gate, then recoils. The recoil stays clear of the gate before it.
const SHORT_OF_GATE = 0.04;
const RECOIL = 0.07;

function Gate({
  label,
  where,
  at,
  t,
  state,
  guarded,
  still,
}: {
  label: string;
  /** The database this check asks, when it asks one. */
  where?: string;
  at: number;
  t: MotionValue<number>;
  state: "idle" | "passed" | "refused";
  guarded: boolean;
  still: boolean;
}) {
  // Lights up at the moment the packet crosses it, on the compositor.
  const lit = useTransform(t, [at - 0.01, at + 0.02], [0, 1]);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <span
        className={`relative flex h-6 w-6 items-center justify-center rounded-md border border-line bg-panel ${
          guarded ? "" : "border-dashed"
        }`}
      >
        {state === "passed" && (
          <motion.span
            style={{ opacity: lit }}
            className="absolute -inset-px flex items-center justify-center rounded-md border border-allow/50 bg-allow/15 text-allow"
          >
            <Icon name="check" className="h-3 w-3" />
          </motion.span>
        )}
        {state === "refused" && (
          <motion.span
            initial={still ? false : { scale: 0.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={bouncy}
            className="absolute -inset-px flex items-center justify-center rounded-md border border-deny bg-deny/15 text-deny"
          >
            <Icon name="x" className="h-3 w-3" />
            {!still && (
              <motion.span
                initial={{ scale: 1, opacity: 0.6 }}
                animate={{ scale: 2.6, opacity: 0 }}
                transition={{ duration: 0.7, ease: "easeOut" }}
                className="absolute inset-0 rounded-md border-2 border-deny"
              />
            )}
          </motion.span>
        )}
      </span>
      <span
        className={`text-center text-[10px] leading-tight sm:text-[11px] ${
          state === "refused" ? "font-semibold text-deny" : guarded ? "text-muted" : "text-muted opacity-80"
        }`}
      >
        {label}
        {where && <span className="block text-[10px] font-normal text-muted">{where}</span>}
      </span>
    </div>
  );
}

function Postgres({ step, arrived, guarded, still }: { step: StepResult | null; arrived: boolean; guarded: boolean; still: boolean }) {
  const reached = arrived && step !== null && step.outcome !== "deny";
  const failed = reached && (step.outcome === "failed" || step.errorCode !== null);
  const tone = !reached
    ? "border-line text-muted"
    : failed
      ? "border-hold/60 bg-hold/15 text-hold"
      : guarded
        ? "border-allow/50 bg-allow/15 text-allow"
        : "border-muted text-text";
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      {/* The opaque backing hides the rail behind the tinted mark. */}
      <span className="rounded-md bg-panel">
        <motion.span
          key={reached ? "reached" : "waiting"}
          initial={reached && !still ? { scale: 0.6 } : false}
          animate={{ scale: 1 }}
          transition={bouncy}
          className={`flex h-6 min-w-6 items-center justify-center whitespace-nowrap rounded-md border px-1.5 font-mono text-[11px] font-medium ${tone}`}
        >
          {!reached ? (
            <DatabaseIcon />
          ) : failed ? (
            <Icon name="alert" className="h-3 w-3" />
          ) : step.rowCount === null ? (
            <Icon name="check" className="h-3 w-3" />
          ) : (
            `${step.rowCount} ${step.rowCount === 1 ? "row" : "rows"}`
          )}
        </motion.span>
      </span>
      <span className={`text-center text-[10px] leading-tight sm:text-[11px] ${reached ? "text-text" : "text-muted"}`}>
        Customer&apos;s Postgres
      </span>
    </div>
  );
}

/**
 * The road one statement takes: four gates, then the customer's Postgres. The packet rides it with
 * transforms only. Mount it fresh (new key) when the statement is sent.
 */
export function Track({
  step,
  guarded,
  arrived,
  still,
  onArrive,
}: {
  /** null while the statement is at rest. */
  step: StepResult | null;
  /** false in the lane without the Breaker: the gates are drawn, but nothing checks. */
  guarded: boolean;
  /** The packet has reached Postgres, or the gate that refused it. */
  arrived: boolean;
  /** Reduced motion: show where things ended, without a travelling packet. */
  still: boolean;
  /** Must be stable: it is called once, when the packet arrives. */
  onArrive: (n: number) => void;
}) {
  const n = step?.n ?? 0;
  const stop = step?.outcome === "deny" ? STOP_GATE[step.stoppedAt ?? "policy"] : null;
  const end = step === null ? 0 : stop === null ? POSTGRES : CENTER[stop + 1] - SHORT_OF_GATE;

  const t = useMotionValue(still ? end : 0);
  const opacity = useMotionValue(0);
  const scale = useMotionValue(0.4);
  const x = useTransform(t, (v) => `${v * 100}%`);

  useEffect(() => {
    if (n === 0 || still) return;
    let cancelled = false;
    const run = async () => {
      animate(opacity, 1, { duration: 0.12 });
      animate(scale, 1, bouncy);
      if (stop === null) {
        // Nothing in the way without the Breaker, so it gets there sooner.
        await animate(t, end, { duration: guarded ? 0.8 : 0.5, ease: glide });
        if (cancelled) return;
        onArrive(n);
        animate(scale, 2.2, { duration: 0.3 });
        animate(opacity, 0, { duration: 0.3 });
      } else {
        // Runs into the gate, recoils, and gives up.
        await animate(t, end, { duration: 0.32 + 0.1 * stop, ease: [0.5, 0, 0.9, 0.6] });
        if (cancelled) return;
        onArrive(n);
        await animate(t, end - RECOIL, { type: "spring", stiffness: 200, damping: 13 });
        if (!cancelled) animate(opacity, 0, { duration: 0.4 });
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [n, still, stop, end, guarded, t, opacity, scale, onArrive]);

  return (
    <div aria-hidden="true" className="relative mt-3">
      <span
        className={`absolute left-0 top-3 block ${guarded ? "h-px bg-line" : "h-0 border-t border-dashed border-line"}`}
        style={{ right: `${(1 - POSTGRES) * 100}%` }}
      />
      <div className="relative grid" style={{ gridTemplateColumns: TEMPLATE }}>
        <span />
        {GATES.map(({ label, where }, i) => (
          <Gate
            key={label}
            label={label}
            where={where}
            at={CENTER[i + 1]}
            t={t}
            guarded={guarded}
            still={still}
            state={
              !guarded || step === null
                ? "idle"
                : stop === null || i < stop
                  ? "passed"
                  : i === stop && arrived
                    ? "refused"
                    : "idle"
            }
          />
        ))}
        <Postgres step={step} arrived={arrived} guarded={guarded} still={still} />
      </div>
      {step !== null && !still && (
        // The wrapper is as wide as the track and parked to its left, so translating it by
        // a percentage of itself places the dot without measuring and without overflowing right.
        <motion.span style={{ x }} className="pointer-events-none absolute right-full top-3 block h-0 w-full">
          <motion.span
            style={{ opacity, scale, boxShadow: "0 0 14px 1px var(--text)" }}
            className="absolute -right-1.5 -top-1.5 block h-3 w-3 rounded-full bg-text"
          />
        </motion.span>
      )}
    </div>
  );
}
