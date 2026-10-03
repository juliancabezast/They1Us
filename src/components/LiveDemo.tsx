"use client";

import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FIXTURES } from "@/lib/fixtures";
import { CATALOG } from "@/lib/policy";
import { BEATS, CHAPTERS, FIRST_DATA_BEAT, INJECTION_BEAT, LAST, chapterStart, holdMs, isReplays, sceneAt, type Replays, type Scene } from "./demo/timeline";
import { bouncy, glide, softSpring, spring } from "./motion";
import { Stage } from "./tour/Stage";
import { Chip, DecisionBadge, Icon, button } from "./ui";
import type { DemoLink } from "./views/props";

const TICKET = FIXTURES[2];
const SEEN_KEY = "tb-demo-seen";
const FAILED = "The demo could not be run.";
// A request that never answers must not leave the page dimmed on step 2 for ever.
const TIMEOUT_MS = 15000;
// A double click on "Run again" lands its second click on Pause or Next, which take its place.
const SETTLE_MS = 500;

type Status = "idle" | "playing" | "paused" | "ended" | "error";

// Storage can be blocked (private mode): then the first-visit pointer is simply skipped.
const seen = () => {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return true;
  }
};
const markSeen = () => {
  try {
    window.sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Nothing to remember it in; the demo still runs.
  }
};

/** "Click here": a label with an arrow that bobs toward its target. */
function Pointer({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.span
      aria-hidden="true"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, y: [0, -7, 0] }}
      transition={{ y: { duration: 1.1, repeat: Infinity, ease: "easeInOut" }, default: bouncy }}
      className={`pointer-events-none flex flex-col items-start ${className}`}
    >
      <span className="whitespace-nowrap rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-on-brand shadow-lg shadow-black/30">
        {children}
      </span>
      <span className="ml-6 h-0 w-0 border-x-8 border-t-8 border-x-transparent border-t-brand" />
    </motion.span>
  );
}

/** A status, not a control: which of the two server paths the run on screen went through. */
function BreakerStatus({ on }: { on: boolean }) {
  return (
    <motion.span
      animate={{ scale: on ? [1, 1.14, 1] : 1 }}
      transition={{ duration: 0.6, ease: glide }}
      className={`ml-auto flex items-center gap-2.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
        on ? "border-allow/50 bg-allow/10 text-allow" : "border-deny/50 bg-deny/10 text-deny"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${on ? "justify-end bg-allow" : "justify-start bg-deny/60"}`}
      >
        <motion.span layout transition={bouncy} className="h-4 w-4 rounded-full bg-panel" />
      </span>
      Breaker {on ? "on" : "off"}
    </motion.span>
  );
}

/** The attacker's ticket as plain text. `marked` sweeps a highlight over the injected block. */
function Ticket({ marked }: { marked: boolean }) {
  const lines = TICKET.body.split("\n");
  const from = lines.findIndex((l) => l.startsWith("==="));
  const to = lines.findLastIndex((l) => l.startsWith("==="));
  return (
    <div className="rounded-lg border border-line bg-raised p-3">
      <p className="mb-2 flex flex-wrap items-center gap-2">
        <Chip tone="untrusted">{TICKET.customer_email}</Chip>
        <span className="text-sm font-medium">{TICKET.subject}</span>
      </p>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
        {lines.map((line, i) => {
          const injected = marked && from >= 0 && i >= from && i <= to;
          return (
            <span key={i} className={`relative block transition-colors duration-500 ${injected ? "text-deny" : ""}`}>
              {injected && (
                <motion.span
                  aria-hidden="true"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.6, delay: 0.3 + (i - from) * 0.09, ease: glide }}
                  className="absolute inset-0 origin-left bg-deny/15"
                />
              )}
              <span className="relative">{line || " "}</span>
            </span>
          );
        })}
      </pre>
      <p className={`mt-2 flex items-center gap-1.5 text-xs font-medium text-deny transition-opacity duration-500 ${marked ? "" : "opacity-0"}`}>
        <Icon name="alert" className="h-3 w-3" /> Injected instruction
      </p>
    </div>
  );
}

/** The three operations of the run on screen. All are listed from the start; each lights up on its beat. */
function Operations({ scene }: { scene: Scene }) {
  return (
    <ol className="space-y-1.5">
      {scene.events.map((e, i) => {
        const revealed = i < scene.beat.ops;
        const denied = revealed && e.decision === "DENIED";
        return (
          <motion.li
            key={e.id}
            animate={{ opacity: revealed ? 1 : 0.4 }}
            transition={spring}
            aria-current={i === scene.beat.ops - 1 ? "step" : undefined}
            className={`rounded-lg border bg-raised px-3 py-2 transition-colors ${
              denied ? "border-deny/50" : i === scene.beat.ops - 1 ? "border-muted" : "border-line"
            }`}
          >
            <div className="flex min-h-6 flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted">{i + 1}</span>
              <code className="font-mono text-[13px]">{e.operation}</code>
              {revealed ? (
                <motion.span initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={bouncy} className="inline-flex">
                  <DecisionBadge decision={e.decision} />
                </motion.span>
              ) : (
                <span className="text-xs text-muted">Not run yet</span>
              )}
              {denied && <code className="font-mono text-[11px] text-deny">{e.reason_code}</code>}
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">{CATALOG.get(e.operation)?.sql}</pre>
          </motion.li>
        );
      })}
    </ol>
  );
}

/**
 * The Live demo: one click, then eleven beats that play by themselves inside the page.
 * One request runs both replays on the backend; every result shown is a row that request wrote.
 */
export function LiveDemo({ pending, onTaken, focus, onFocus, onData }: DemoLink) {
  const panel = useRef<HTMLElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const pauseButton = useRef<HTMLButtonElement>(null);
  // Time already spent on a beat, so Resume continues the hold instead of restarting it.
  const elapsed = useRef({ beat: -1, ms: 0 });
  const request = useRef(0);
  const settling = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refocus = useRef(false);
  const progress = useMotionValue(0);
  const still = useReducedMotion();

  const [status, setStatus] = useState<Status>("idle");
  const [index, setIndex] = useState(0);
  const [data, setData] = useState<Replays | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const [spotlight, setSpotlight] = useState(false);

  const ready = data !== null;
  const active = status === "playing" || status === "paused" || status === "ended";
  const scene = sceneAt(index, status !== "idle", data);

  const jump = (to: number) => {
    elapsed.current = { beat: -1, ms: 0 };
    progress.set(0);
    setIndex(to);
    // After a click on Next, Back or a chapter, Space must still mean Pause or Resume: the focus goes back to that button.
    if (pauseButton.current) pauseButton.current.focus({ preventScroll: true });
    else refocus.current = true;
  };

  const start = useCallback(async () => {
    markSeen();
    const id = ++request.current;
    settling.current = true;
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settling.current = false;
    }, SETTLE_MS);
    elapsed.current = { beat: -1, ms: 0 };
    progress.set(0);
    setSpotlight(false);
    setError(null);
    setData(null);
    setIndex(0);
    setRunId((n) => n + 1);
    setStatus("playing");
    onFocus(true);
    try {
      // The request leaves on the first beat; the first two beats only need the ticket.
      const res = await fetch("/api/demo/run", { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err: unknown) =>
        err instanceof DOMException && err.name === "TimeoutError" ? "late" : null,
      );
      if (res === "late") throw new Error("The backend took too long to answer.");
      if (!res) throw new Error("The backend did not answer.");
      const body: unknown = await res.json().catch(() => null);
      if (id !== request.current) return;
      if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `The backend answered ${res.status}.`);
      if (!isReplays(body)) throw new Error("The backend answered in a shape this page does not know.");
      setData(body);
      onData();
    } catch (err) {
      if (id !== request.current) return;
      const detail = (err as Error).message;
      setError(detail === FAILED ? FAILED : `${FAILED} ${detail}`);
      setStatus("error");
      onFocus(false);
    }
  }, [onData, onFocus, progress]);

  const end = () => {
    setStatus("ended");
    onFocus(false);
  };
  const back = () => {
    if (index === 0 || settling.current) return;
    jump(index - 1);
    if (status === "ended") setStatus("paused");
  };
  const next = () => {
    if (status === "ended" || settling.current) return;
    if (index === LAST) return end();
    if (index + 1 >= FIRST_DATA_BEAT && !ready) return;
    jump(index + 1);
  };
  const toggle = () => {
    if (settling.current) return;
    if (status === "playing") setStatus("paused");
    else if (status === "paused") {
      setStatus("playing");
      onFocus(true);
    }
  };
  const toChapter = (chapter: number) => {
    const to = chapterStart(chapter);
    if (!active || (to >= FIRST_DATA_BEAT && !ready)) return;
    jump(to);
    if (status === "ended") {
      setStatus("playing");
      onFocus(true);
    }
  };
  const leaveFocus = () => {
    markSeen();
    setSpotlight(false);
    onFocus(false);
    if (status === "playing") setStatus("paused");
  };

  // The clock. Each beat is held long enough to read its line, then the next one comes by itself.
  // A timer, not an animation frame: it must keep time in a tab that is not being painted.
  useEffect(() => {
    if (status !== "playing") return;
    const total = holdMs(BEATS[index].line);
    const done = elapsed.current.beat === index ? elapsed.current.ms : 0;
    const left = Math.max(0, total - done);
    const startedAt = performance.now();
    progress.set(Math.min(1, done / total));
    const bar = animate(progress, 1, { duration: left / 1000, ease: "linear" });
    const timer = setTimeout(() => {
      // The next beat shows backend results. If they are not here yet, wait: this effect runs again when they land.
      if (index + 1 >= FIRST_DATA_BEAT && !ready) return;
      if (index === LAST) {
        setStatus("ended");
        onFocus(false);
        return;
      }
      setIndex(index + 1);
    }, left);
    return () => {
      clearTimeout(timer);
      bar.stop();
      elapsed.current = { beat: index, ms: done + performance.now() - startedAt };
    };
  }, [status, index, ready, progress, onFocus]);

  // First visit of the session: dim the page and point at the button.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (seen()) return;
      setSpotlight(true);
      onFocus(true);
    }, 600);
    return () => clearTimeout(timer);
  }, [onFocus]);

  // The floating button on another view asked for a run.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      onTaken();
      start();
    }, 0);
    return () => clearTimeout(timer);
  }, [pending, onTaken, start]);

  // A new run: bring the panel into view and put the keyboard on Pause.
  useEffect(() => {
    if (runId === 0) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.current?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
    pauseButton.current?.focus({ preventScroll: true });
  }, [runId]);

  // Pause did not exist when the jump was made (Back from the end): take the focus once it does.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    pauseButton.current?.focus({ preventScroll: true });
  });

  // Never leave the page dimmed behind a demo that is gone.
  useEffect(() => () => onFocus(false), [onFocus]);

  // Keyboard, only while there is something to drive. Rebound every render so it always sees this render's state.
  useEffect(() => {
    if (status !== "playing" && status !== "paused" && !focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") {
        if (focus) leaveFocus();
        return;
      }
      if (status !== "playing" && status !== "paused") return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      } else if (e.key === " " && !target?.closest("button, a")) {
        // On a button or a link, Space keeps its native meaning (Pause holds the focus after a run starts).
        e.preventDefault();
        toggle();
      }
    };
    // In focus mode a click outside the panel (or, on the first visit, anywhere but the button) lifts the dim.
    const onClick = (e: MouseEvent) => {
      if (!focus || !(e.target instanceof Node)) return;
      if (runButton.current?.contains(e.target)) return;
      if (!spotlight && panel.current?.contains(e.target)) return;
      leaveFocus();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick, true);
    };
  });

  const waiting = active && !ready;
  const detail = !active ? null : index < FIRST_DATA_BEAT ? "ticket" : `run-${scene.beat.run}`;
  const swap = still ? { opacity: 0 } : { opacity: 0, y: 12 };

  return (
    <section ref={panel} aria-labelledby="live-demo-title" className="scroll-mt-4 rounded-xl border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <h2 id="live-demo-title" className="flex items-center gap-2 text-base font-semibold">
          <Icon name="shield" className="h-4 w-4 text-allow" /> Live demo
        </h2>
        <ol aria-label="Chapters" className="flex flex-wrap items-center gap-1">
          {CHAPTERS.map((label, c) => {
            const current = c === scene.beat.chapter;
            const done = c < scene.beat.chapter;
            return (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => toChapter(c)}
                  disabled={!active || (chapterStart(c) >= FIRST_DATA_BEAT && !ready)}
                  aria-current={current ? "step" : undefined}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-default ${
                    current ? "bg-brand text-on-brand" : done ? "text-allow hover:bg-raised" : "text-muted enabled:hover:text-text"
                  }`}
                >
                  {done ? <Icon name="check" className="h-3 w-3" /> : <span className="font-mono">{c + 1}</span>}
                  {label}
                  {done && <span className="sr-only">, done</span>}
                </button>
              </li>
            );
          })}
        </ol>
        <BreakerStatus on={scene.breakerOn} />
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-5 lg:p-5">
        {/* The diagram is the hero. Stage sets its own height, so the taller one is set from here. */}
        <div className="[&>div]:h-80 sm:[&>div]:h-96 lg:[&>div]:h-[32rem]">
          <Stage
            runKey={`${runId}-${scene.beat.run ?? "ticket"}`}
            hops={scene.hops}
            submitted={scene.submitted}
            leaked={scene.leaked}
            contained={scene.contained}
          />
        </div>

        <div className={`flex min-w-0 flex-col gap-3 ${active ? "" : "lg:justify-center"}`}>
          <motion.div layout="position" transition={softSpring} className="rounded-xl border border-line bg-raised">
            {/* The new line replaces the old one at once (no exit to wait for), so the text is never behind the beat. */}
            <div aria-live="polite" className="min-h-28 px-4 pt-4 sm:min-h-32 sm:px-5 sm:pt-5">
              <motion.p
                key={scene.beat.line}
                initial={status === "idle" ? false : still ? { opacity: 0 } : { opacity: 0, y: 12, filter: "blur(6px)" }}
                animate={still ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={still ? { duration: 0.12 } : { duration: 0.4, ease: glide }}
                className="text-xl font-semibold leading-snug sm:text-2xl"
              >
                {scene.beat.line}
              </motion.p>
            </div>

            {active && (
              <div aria-hidden="true" className="mx-4 h-1 overflow-hidden rounded-full bg-line sm:mx-5">
                <motion.div style={{ scaleX: progress }} className="h-full origin-left bg-brand" />
              </div>
            )}

            {error && (
              <p role="alert" className="mx-4 flex items-start gap-2 rounded-lg border border-deny/40 bg-deny/10 px-3 py-2 text-sm text-deny sm:mx-5">
                <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
              </p>
            )}

            {active ? (
              <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
                <p className="mr-auto text-xs text-muted">
                  <span className="font-mono tabular-nums">
                    Step {index + 1} of {BEATS.length}
                  </span>
                  {waiting && <span className="ml-2">Running both replays on the backend</span>}
                </p>
                <button type="button" onClick={back} disabled={index === 0} className={button.secondary}>
                  Back
                </button>
                {status === "ended" ? (
                  <button type="button" onClick={start} className={button.primary}>
                    Run again
                  </button>
                ) : (
                  <>
                    <button ref={pauseButton} type="button" onClick={toggle} className={`${button.secondary} min-w-20`}>
                      {status === "playing" ? "Pause" : "Resume"}
                    </button>
                    <button type="button" onClick={next} disabled={index + 1 >= FIRST_DATA_BEAT && !ready} className={button.secondary}>
                      Next
                    </button>
                  </>
                )}
              </div>
            ) : (
              // The gap above the button is where the first-visit pointer sits, so it never covers the line.
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-4 pt-12 sm:px-5 sm:pb-5">
                <span className="relative inline-flex">
                  {spotlight && <Pointer className="absolute bottom-full left-0 mb-1.5">Click here to see it live</Pointer>}
                  {spotlight && !still && (
                    <motion.span
                      aria-hidden="true"
                      initial={{ scale: 1, opacity: 0.7 }}
                      animate={{ scale: 1.35, opacity: 0 }}
                      transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
                      className="pointer-events-none absolute inset-0 rounded-lg border-2 border-brand"
                    />
                  )}
                  <motion.button
                    ref={runButton}
                    type="button"
                    onClick={start}
                    whileTap={{ scale: 0.96 }}
                    transition={bouncy}
                    className={`${button.primary} relative px-5 py-2.5 text-[15px]`}
                  >
                    {status === "error" ? "Try again" : "Run live demo"}
                  </motion.button>
                </span>
                <p className="text-sm text-muted">Plays by itself in about a minute. Every result comes from the backend.</p>
              </div>
            )}
          </motion.div>

          {detail && (
            <motion.div key={detail} initial={swap} animate={{ opacity: 1, y: 0 }} transition={spring}>
              {detail === "ticket" ? <Ticket marked={index >= INJECTION_BEAT} /> : <Operations scene={scene} />}
            </motion.div>
          )}

          {scene.token && (
            <motion.p initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={bouncy} className="flex flex-wrap items-center gap-2">
              <Chip tone="deny">
                <Icon name="alert" className="h-3 w-3" /> Token leaked
              </Chip>
              <code className="break-all rounded bg-deny/10 px-1.5 py-0.5 font-mono text-xs text-deny">{scene.token}</code>
            </motion.p>
          )}
          {scene.contained && (
            <motion.p
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={bouncy}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
            >
              <Chip tone="allow">
                <Icon name="shield" className="h-3 w-3" /> Attack contained
              </Chip>
              <a href="#audit-log" className="text-muted underline hover:text-text">
                See every decision in the audit log
              </a>
              <a href="#sql-breaker" className="text-muted underline hover:text-text">
                See the same attack as raw SQL
              </a>
            </motion.p>
          )}
        </div>
      </div>
    </section>
  );
}
