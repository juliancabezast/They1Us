"use client";

import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { bouncy, glide } from "../motion";
import { Icon } from "../ui";

export type HopState = "idle" | "open" | "denied" | "held";
type Point = [number, number];
type Curve = [Point, Point, Point, Point];

// Layout in percentages of the stage; converted to pixels once the stage is measured.
const NODES = { ticket: [13, 50], agent: [48, 50], vault: [86, 22], out: [86, 78] } satisfies Record<string, Point>;
// Each hop runs in the direction the data would flow.
const CURVES: Curve[] = [
  [[24.5, 50], [29, 50], [32, 50], [36.5, 50]],
  [[74.5, 22], [65, 22], [69, 46], [59.5, 46]],
  [[59.5, 54], [69, 54], [65, 78], [74.5, 78]],
];
const TONES = ["var(--untrusted)", "var(--secret)", "var(--deny)"];

const bezier = (c: Curve, t: number): Point => {
  const u = 1 - t;
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1].map((a) => c.reduce((sum, p, i) => sum + k[i] * p[a], 0)) as Point;
};
const pathOf = (c: Curve) => `M ${c[0]} C ${c[1]} ${c[2]} ${c[3]}`;

/** The thing that moves: a dot riding the curve on the compositor (transform only). */
function Packet({ curve, state, color }: { curve: Curve; state: HopState; color: string }) {
  const t = useMotionValue(0);
  const opacity = useMotionValue(0);
  const scale = useMotionValue(0.4);
  const x = useTransform(t, (v) => bezier(curve, v)[0]);
  const y = useTransform(t, (v) => bezier(curve, v)[1]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      animate(opacity, 1, { duration: 0.15 });
      animate(scale, 1, bouncy);
      if (state === "open") {
        await animate(t, 1, { duration: 0.95, ease: glide });
        if (cancelled) return;
        animate(scale, 2.2, { duration: 0.35 });
        animate(opacity, 0, { duration: 0.35 });
      } else if (state === "denied") {
        // Runs into the gate, recoils, and gives up.
        await animate(t, 0.46, { duration: 0.5, ease: [0.5, 0, 0.9, 0.6] });
        if (cancelled) return;
        await animate(t, 0.16, { type: "spring", stiffness: 200, damping: 13 });
        if (!cancelled) animate(opacity, 0, { duration: 0.4 });
      } else {
        // Held: eases to a stop in front of the gate and waits there.
        await animate(t, 0.42, { duration: 0.9, ease: [0.1, 0.7, 0.2, 1] });
        if (!cancelled) animate(scale, [1, 1.25, 1], { duration: 1.6, repeat: Infinity, ease: "easeInOut" });
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [opacity, scale, state, t]);

  return (
    <motion.span
      aria-hidden="true"
      style={{ x, y, opacity, scale, background: color, boxShadow: `0 0 18px 2px ${color}` }}
      className="absolute left-0 top-0 -ml-1.5 -mt-1.5 h-3 w-3 rounded-full"
    />
  );
}

function Gate({ at, state }: { at: Point; state: "denied" | "held" }) {
  const color = state === "denied" ? "var(--deny)" : "var(--hold)";
  const delay = state === "denied" ? 0.42 : 0.7;
  return (
    <motion.span
      aria-hidden="true"
      initial={{ scale: 0, rotate: -40 }}
      animate={{ scale: 1, rotate: 0 }}
      transition={{ ...bouncy, delay }}
      style={{ left: at[0], top: at[1], color, borderColor: color }}
      className="absolute -ml-4 -mt-4 flex h-8 w-8 items-center justify-center rounded-full border-2 bg-ink"
    >
      <motion.span
        initial={{ scale: 1, opacity: 0.6 }}
        animate={{ scale: 2.6, opacity: 0 }}
        transition={{ duration: 0.8, delay: delay + 0.06, ease: "easeOut" }}
        style={{ borderColor: color }}
        className="absolute inset-0 rounded-full border-2"
      />
      <Icon name={state === "denied" ? "x" : "clock"} className="h-4 w-4" />
    </motion.span>
  );
}

function Node({
  at,
  width,
  title,
  sub,
  color,
  pulse,
  shake,
  dashed,
  children,
}: {
  at: Point;
  width: number;
  title: string;
  sub: string;
  color: string;
  pulse: boolean;
  shake?: boolean;
  dashed?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <motion.div
      // Reacts when it is the node something just arrived at (or failed to).
      animate={shake ? { x: [0, -7, 7, -5, 5, -2, 0], scale: 1 } : { x: 0, scale: pulse ? [1, 1.06, 1] : 1 }}
      transition={{ duration: 0.5, delay: 0.9, ease: "easeOut" }}
      style={{ left: at[0] - width / 2, top: at[1], y: "-50%", borderColor: color, width }}
      className={`absolute rounded-xl border bg-raised px-2 py-2 text-center shadow-lg shadow-black/10 transition-[border-color] duration-500 ${
        dashed ? "border-dashed" : ""
      }`}
    >
      <p className="text-[13px] font-semibold leading-tight">{title}</p>
      <p className="text-[11px] leading-tight text-muted">{sub}</p>
      <div className="mt-1 flex min-h-5 flex-wrap justify-center gap-1">
        <AnimatePresence mode="popLayout">{children}</AnimatePresence>
      </div>
    </motion.div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <motion.span
      layout
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }}
      transition={bouncy}
      style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
      className="rounded px-1.5 py-0.5 text-[11px] font-medium"
    >
      {children}
    </motion.span>
  );
}

export interface StageProps {
  /** Changes for every run, so each run replays its own animation. */
  runKey: string;
  hops: HopState[];
  submitted: boolean;
  leaked: boolean;
  contained: boolean;
}

/** Who holds what, and where data moves. Driven entirely by the revealed backend events. */
export function Stage({ runKey, hops, submitted, leaked, contained }: StageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const still = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const px = (p: Point): Point => [(p[0] / 100) * size.w, (p[1] / 100) * size.h];
  const curves = CURVES.map((c) => c.map(px) as Curve);
  // A refused read is a request travelling from the agent toward the vault.
  const travel = (i: number): Curve => (hops[i] === "denied" && i === 1 ? ([...curves[i]].reverse() as Curve) : curves[i]);
  const width = Math.max(92, size.w * 0.23);
  const last = hops.findLastIndex((h) => h !== "idle");
  const tainted = hops[0] !== "idle";

  return (
    <div ref={ref} className="relative h-60 overflow-hidden rounded-xl border border-line bg-ink sm:h-72">
      {size.w > 0 && (
        <>
          <svg width={size.w} height={size.h} className="absolute inset-0" aria-hidden="true">
            {curves.map((c, i) => (
              <g key={i}>
                <path
                  d={pathOf(c)}
                  fill="none"
                  strokeWidth={1.5}
                  strokeDasharray={hops[i] === "denied" || hops[i] === "held" ? "5 6" : undefined}
                  style={{
                    stroke: hops[i] === "denied" ? "var(--deny)" : hops[i] === "held" ? "var(--hold)" : "var(--line)",
                    transition: "stroke 0.5s 0.5s",
                  }}
                />
                {hops[i] === "open" && (
                  <motion.path
                    key={runKey}
                    d={pathOf(c)}
                    fill="none"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    stroke={TONES[i]}
                    initial={{ pathLength: still ? 1 : 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.95, ease: glide }}
                  />
                )}
              </g>
            ))}
          </svg>

          {!still &&
            hops.map(
              (h, i) =>
                h !== "idle" && <Packet key={`${runKey}-${i}`} curve={travel(i)} state={h} color={h === "open" ? TONES[i] : "var(--muted)"} />,
            )}
          {hops.map((h, i) => (h === "denied" || h === "held") && <Gate key={`${runKey}-gate-${i}`} at={bezier(curves[i], 0.5)} state={h} />)}

          <Node
            at={px(NODES.ticket)}
            width={width}
            title="Ticket"
            sub={submitted ? "written by a stranger" : "not filed yet"}
            color={submitted ? "var(--untrusted)" : "var(--line)"}
            dashed={!submitted}
            pulse={submitted && last < 0}
          >
            {submitted && <Tag key="u" color="var(--untrusted)">untrusted</Tag>}
          </Node>
          <Node
            at={px(NODES.agent)}
            width={width}
            title="Agent context"
            sub="what the agent holds"
            color={tainted ? "var(--untrusted)" : "var(--line)"}
            pulse={last === 0}
          >
            {tainted && <Tag key="u" color="var(--untrusted)">untrusted</Tag>}
            {hops[1] === "open" && <Tag key="s" color="var(--secret)">secret</Tag>}
          </Node>
          <Node
            at={px(NODES.vault)}
            width={width}
            title="Integration token"
            sub="integration_tokens"
            color={hops[1] === "denied" ? "var(--allow)" : "var(--secret)"}
            pulse={last === 1}
          >
            {hops[1] === "denied" ? (
              <Tag key="safe" color="var(--allow)">not reached</Tag>
            ) : (
              <Tag key="s" color="var(--secret)">secret</Tag>
            )}
          </Node>
          <Node
            at={px(NODES.out)}
            width={width}
            title="Attacker's screen"
            sub="reply on their ticket"
            color={leaked ? "var(--deny)" : contained ? "var(--allow)" : "var(--line)"}
            pulse={last === 2}
            shake={leaked && !still}
          >
            {leaked && <Tag key="leak" color="var(--deny)">token leaked</Tag>}
            {contained && <Tag key="empty" color="var(--allow)">nothing arrived</Tag>}
            {!contained && hops[2] === "held" && <Tag key="wait" color="var(--hold)">waiting for a human</Tag>}
          </Node>
        </>
      )}
    </div>
  );
}
