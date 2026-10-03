"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FIXTURES } from "@/lib/fixtures";
import { CATALOG } from "@/lib/policy";
import type { EventRow, TicketRow } from "@/lib/types";
import { bouncy, softSpring, spring } from "./motion";
import { Stage, type HopState } from "./tour/Stage";
import { Chip, DecisionBadge, Icon, button } from "./ui";

const TICKET = FIXTURES[2];
const STEP_MS = 1900;

interface Run {
  events: EventRow[];
  ticket: TicketRow;
  protected: boolean;
}

// What the tour says at each moment. One line, pointing at what just happened.
const NARRATION = {
  start: "A stranger is about to file a support ticket. Anyone can.",
  ticket:
    "Hidden inside the ticket: instructions aimed at the agent, not at a human.",
  off: [
    "The agent reads the tickets. The hidden instruction comes along.",
    "It obeys: it reads the integration token.",
    "It writes the token into the reply. The attacker just reads their own ticket.",
  ],
  leaked:
    "Nothing was hacked. The agent was simply allowed to hold both things at once.",
  armed: "Same ticket, same agent, same three operations. Run it again.",
  on: [
    "The read is allowed, and the context is now marked: it holds untrusted content.",
    "Blocked. A context that holds untrusted content cannot read a secret.",
    "The reply waits for a human to approve the exact text. Nothing leaves.",
  ],
  contained: "The injection still happened. The leak did not.",
};

const STEPS = ["Ticket", "Leak", "Breaker", "Contained"];

/** "Click here": a label with an arrow that bobs toward its target. */
function Pointer({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.span
      aria-hidden="true"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, y: [0, -7, 0] }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{
        y: { duration: 1.1, repeat: Infinity, ease: "easeInOut" },
        default: bouncy,
      }}
      className={`pointer-events-none flex flex-col items-end ${className}`}
    >
      <span className="whitespace-nowrap rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-on-brand shadow-lg shadow-black/30">
        {children}
      </span>
      <span className="mr-6 h-0 w-0 border-x-8 border-t-8 border-x-transparent border-t-brand" />
    </motion.span>
  );
}

/** A guided, five-click walk through the attack replay. Every result shown comes from the backend. */
export function LiveDemo() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [submitted, setSubmitted] = useState(false);
  const [breakerOn, setBreakerOn] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spotlight, setSpotlight] = useState(false);

  // First visit of the session: dim the page and point at the demo.
  useEffect(() => {
    const t = setTimeout(
      () =>
        !window.sessionStorage.getItem("tb-demo-seen") && setSpotlight(true),
      600,
    );
    return () => clearTimeout(t);
  }, []);
  const dismissSpotlight = () => {
    setSpotlight(false);
    window.sessionStorage.setItem("tb-demo-seen", "1");
  };
  useEffect(() => {
    if (!spotlight) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && dismissSpotlight();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spotlight]);

  // Real results, revealed one operation at a time so each one can be explained.
  useEffect(() => {
    if (!run || shown >= run.events.length) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(
      () => setShown(still ? run.events.length : shown + 1),
      still ? 0 : shown === 0 ? 150 : STEP_MS,
    );
    return () => clearTimeout(t);
  }, [run, shown]);

  const runAgent = async () => {
    setBusy(true);
    setError(null);
    setRun(null);
    setShown(0);
    try {
      // Two different server paths. There is no flag that turns the gateway off.
      const res = await fetch(
        breakerOn ? "/api/runs/attack" : "/api/sandbox/attack",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pace: false }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Run failed");
      setRun({ ...data, protected: breakerOn });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setSubmitted(false);
    setBreakerOn(false);
    setRun(null);
    setShown(0);
    setError(null);
  };

  const finished = run !== null && shown >= run.events.length;
  const playing = busy || (run !== null && !finished);
  const leaked = finished && !run.protected;
  const contained = finished && run.protected;
  const armed = breakerOn && (!run || !run.protected) && !playing;
  const events = run?.events.slice(0, shown) ?? [];
  const last = events.length - 1;

  const step =
    !submitted || (!run && !busy && !breakerOn)
      ? 0
      : contained
        ? 3
        : breakerOn
          ? 2
          : 1;
  const caption = !submitted
    ? NARRATION.start
    : playing && last >= 0
      ? NARRATION[run!.protected ? "on" : "off"][last]
      : contained
        ? NARRATION.contained
        : armed
          ? NARRATION.armed
          : leaked
            ? NARRATION.leaked
            : NARRATION.ticket;

  const hops: HopState[] = [0, 1, 2].map((i) => {
    const e = events[i];
    return !e
      ? "idle"
      : e.decision === "DENIED"
        ? "denied"
        : e.decision === "APPROVAL_REQUIRED"
          ? "held"
          : "open";
  });
  const tokenOut = run && !run.protected && last >= 2 ? run.ticket.reply : null;
  const [opened, setOpened] = useState(0);

  // One primary action at a time: the tour always knows the next click.
  const next = !submitted
    ? { label: "Submit ticket", act: () => setSubmitted(true) }
    : contained
      ? { label: "Replay", act: restart }
      : leaked && !breakerOn
        ? { label: "Turn Breaker on", act: () => setBreakerOn(true) }
        : { label: playing ? "Agent running" : "Run agent", act: runAgent };

  return (
    <>
      <AnimatePresence>
        {spotlight && (
          <motion.div
            key="dim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            onClick={dismissSpotlight}
            className="fixed inset-0 z-40 bg-black/75 backdrop-blur-[3px]"
          />
        )}
        {spotlight && (
          <Pointer key="point" className="fixed bottom-[4.6rem] right-5 z-50">
            Click here to see it live
          </Pointer>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => {
          dismissSpotlight();
          setOpened((n) => n + 1);
          dialog.current?.showModal();
        }}
        className={`fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full border border-allow/50 bg-panel px-4 py-2.5 text-sm font-semibold text-allow shadow-lg shadow-black/25 hover:bg-raised ${spotlight ? "tour-ring" : ""}`}
      >
        <Icon name="shield" className="h-4 w-4" />
        Live demo
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="live-demo-title"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
        className="m-auto w-[min(1120px,96vw)] max-w-none overflow-visible bg-transparent p-0 text-text max-sm:h-dvh max-sm:max-h-none max-sm:w-screen"
      >
        <MotionConfig reducedMotion="user">
          <motion.div
            key={opened}
            initial={{ opacity: 0, scale: 0.94, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={softSpring}
            className="flex h-[min(92dvh,820px)] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl shadow-black/40 max-sm:h-full max-sm:rounded-none"
          >
            <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <h2
                id="live-demo-title"
                className="flex items-center gap-2 text-base font-semibold"
              >
                <Icon name="shield" className="h-4 w-4 text-allow" /> Live demo
              </h2>
              <ol className="flex items-center gap-1.5" aria-label="Progress">
                {STEPS.map((label, i) => (
                  <li
                    key={label}
                    aria-current={i === step ? "step" : undefined}
                    className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      i === step
                        ? "bg-brand text-on-brand"
                        : i < step
                          ? "text-allow"
                          : "text-muted"
                    }`}
                  >
                    {i < step ? (
                      <Icon name="check" className="h-3 w-3" />
                    ) : (
                      <span className="font-mono">{i + 1}</span>
                    )}
                    <span className="max-sm:hidden">{label}</span>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={() => dialog.current?.close()}
                aria-label="Close"
                className="rounded-lg p-1.5 text-muted hover:text-text"
              >
                <Icon name="x" className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 sm:px-6">
              <Stage
                runKey={run ? String(run.events[0]?.id) : "none"}
                hops={hops}
                submitted={submitted}
                leaked={Boolean(tokenOut)}
                contained={contained}
              />

              {/* The narrator: one line, tied to what the stage just showed. */}
              <div
                aria-live="polite"
                className="flex min-h-14 items-center gap-3 rounded-xl border border-line bg-raised px-4 py-3"
              >
                <motion.span
                  key={step}
                  initial={{ scale: 0.5 }}
                  animate={{ scale: 1 }}
                  transition={bouncy}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand font-mono text-xs font-semibold text-on-brand"
                >
                  {step + 1}
                </motion.span>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={caption}
                    initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
                    transition={{ duration: 0.28 }}
                    className="text-base leading-snug sm:text-lg"
                  >
                    {caption}
                  </motion.p>
                </AnimatePresence>
              </div>

              {submitted && !run && !playing && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={spring}
                  className="rounded-lg border border-line bg-raised p-3"
                >
                  <p className="mb-2 flex flex-wrap items-center gap-1.5">
                    <Chip>{TICKET.customer_email}</Chip>
                    <code className="font-mono text-[11px] text-muted">
                      support_tickets.body
                    </code>
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
                    {TICKET.body.split("\n").map((line, i, all) => {
                      const start = all.findIndex((l) => l.startsWith("==="));
                      return (
                        <span
                          key={i}
                          className={
                            start >= 0 && i >= start
                              ? "tour-sweep text-deny"
                              : undefined
                          }
                        >
                          {line}
                          {"\n"}
                        </span>
                      );
                    })}
                  </pre>
                  <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-deny">
                    <span aria-hidden="true">↑</span> Injected instruction
                  </p>
                </motion.div>
              )}

              <ol className="space-y-1.5">
                <AnimatePresence initial={false}>
                  {events.map((e, i) => (
                    <motion.li
                      key={e.id}
                      layout
                      initial={{ opacity: 0, x: -24, height: 0 }}
                      animate={{ opacity: 1, x: 0, height: "auto" }}
                      transition={spring}
                      className={`overflow-hidden rounded-lg border bg-raised ${e.decision === "DENIED" ? "border-deny/50" : i === last && playing ? "border-muted" : "border-line"}`}
                    >
                      <div className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-muted">
                            {i + 1}
                          </span>
                          <code className="font-mono text-[13px]">
                            {e.operation}
                          </code>
                          <DecisionBadge decision={e.decision} />
                          {e.decision === "DENIED" && (
                            <code className="font-mono text-[11px] text-deny">
                              {e.reason_code}
                            </code>
                          )}
                        </div>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted">
                          {CATALOG.get(e.operation)?.sql}
                        </pre>
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ol>

              {tokenOut && finished && (
                <motion.p
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={bouncy}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Chip tone="deny">
                    <Icon name="alert" className="h-3 w-3" /> Token leaked
                  </Chip>
                  <code className="break-all rounded bg-deny/10 px-1.5 py-0.5 font-mono text-xs text-deny">
                    {tokenOut}
                  </code>
                </motion.p>
              )}
              {contained && (
                <motion.p
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={bouncy}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Chip tone="allow">
                    <Icon name="shield" className="h-3 w-3" /> Attack contained
                  </Chip>
                  <Link
                    href="/#audit-log"
                    onClick={() => dialog.current?.close()}
                    className="text-xs text-muted underline hover:text-text"
                  >
                    See every decision in the audit log
                  </Link>
                </motion.p>
              )}
              {error && (
                <p>
                  <Chip tone="deny">{error}</Chip>
                </p>
              )}
            </div>

            <footer className="relative flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
              <AnimatePresence>
                {!playing && (
                  <Pointer
                    key={next.label}
                    className="absolute bottom-full right-5 mb-1"
                  >
                    Click here
                  </Pointer>
                )}
              </AnimatePresence>
              <button
                type="button"
                role="switch"
                aria-checked={breakerOn}
                disabled={!submitted || playing}
                onClick={() => setBreakerOn((v) => !v)}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40 ${
                  breakerOn
                    ? "border-allow/50 bg-allow/10 text-allow"
                    : "border-deny/50 bg-deny/10 text-deny"
                } ${leaked && !breakerOn ? "tour-ring" : ""}`}
              >
                <span
                  className={`relative h-5 w-9 rounded-full ${breakerOn ? "bg-allow" : "bg-deny/60"}`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-panel transition-all ${breakerOn ? "left-[18px]" : "left-0.5"}`}
                  />
                </span>
                Breaker {breakerOn ? "on" : "off"}
              </button>
              <p className="hidden flex-1 text-xs text-muted sm:block">
                Deterministic replay on the real backend. No model judging a
                model.
              </p>
              <motion.button
                type="button"
                disabled={playing}
                onClick={next.act}
                whileTap={{ scale: 0.95 }}
                transition={bouncy}
                className={`${button.primary} ml-auto px-5 py-2.5 text-[15px] text-brand ${!playing ? "tour-ring" : ""}`}
              >
                <span className="text-on-brand">{next.label}</span>
              </motion.button>
            </footer>
          </motion.div>
        </MotionConfig>
      </dialog>
    </>
  );
}
