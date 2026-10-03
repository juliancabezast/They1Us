"use client";

import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Dim } from "@/components/demo/Dim";
import { bouncy, spring } from "@/components/motion";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Icon, button } from "@/components/ui";
import { VictimLink } from "@/components/VictimLink";
import { AttackLab } from "@/components/views/AttackLab";
import { AuditLog } from "@/components/views/AuditLog";
import { Overview } from "@/components/views/Overview";
import { LiveService } from "@/components/views/LiveService";
import { Policies } from "@/components/views/Policies";
import { Sessions } from "@/components/views/Sessions";
import { SqlBreaker } from "@/components/views/SqlBreaker";
import { supabase } from "@/lib/supabase-browser";
import type { DashboardState } from "@/lib/types";

const VIEWS = [
  ["overview", "Overview"],
  ["sql-breaker", "SQL Breaker"],
  ["live-service", "Live service"],
  ["attack-lab", "Attack Lab"],
  ["sessions", "Sessions"],
  ["policies", "Policies"],
  ["audit-log", "Audit Log"],
] as const;
type View = (typeof VIEWS)[number][0];

const post = (path: string, body: object = {}, method = "POST") =>
  fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export default function Dashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  // The Live demo lives on Overview. The page only keeps what must outlive that view:
  // a run asked for from another view, and whether the rest of the page is dimmed.
  const [demoPending, setDemoPending] = useState(false);
  const [demoFocus, setDemoFocus] = useState(false);
  const demoTaken = useCallback(() => setDemoPending(false), []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(`The backend answered ${res.status}`);
      setState(await res.json());
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash.slice(1);
      if (!VIEWS.some(([id]) => id === hash)) return;
      setView(hash as View);
      if (hash !== "overview") setDemoFocus(false);
    };
    const first = setTimeout(() => {
      fromHash();
      refresh();
    }, 0);
    window.addEventListener("hashchange", fromHash);
    // Realtime drives updates; the slow poll only covers a dropped socket.
    // The list is always replaced from the server, so a reconnect cannot duplicate events.
    const poll = setInterval(refresh, 6000);
    const channel = supabase
      .channel("breaker")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tb_events" },
        refresh,
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", fromHash);
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [refresh]);

  const act = async (name: string, requests: () => Promise<Response[]>) => {
    setBusy(name);
    setError(null);
    try {
      for (const res of await requests()) {
        if (!res.ok)
          throw new Error(
            (await res.json().catch(() => ({}))).error ??
              `Request failed (${res.status})`,
          );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const go = (id: View) => {
    setView(id);
    if (id !== "overview") setDemoFocus(false);
    window.history.replaceState(null, "", `#${id}`);
  };

  const dim = demoFocus && view === "overview";

  const props = {
    live,
    busy,
    onDecide: (id: string, action: "approve" | "reject") =>
      act("approval", async () => [
        await post(`/api/approvals/${id}`, { action }),
      ]),
    onRunAttack: () =>
      act("attack", () =>
        Promise.all([post("/api/sandbox/attack"), post("/api/runs/attack")]),
      ),
    onRunWorkflow: () =>
      act("workflow", async () => [await post("/api/runs/workflow")]),
    demo: {
      pending: demoPending,
      onTaken: demoTaken,
      focus: dim,
      onFocus: setDemoFocus,
      onData: refresh,
    },
  };

  return (
    <MotionConfig reducedMotion="user">
      <main className="w-full flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-10">
        <Dim on={dim}>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                <Icon name="shield" className="h-5 w-5 text-allow" />
                Trifecta Breaker
                <span className="font-normal text-muted">
                  Agent access, without blind trust.
                </span>
              </h1>
              <p className="mt-1 text-sm text-muted">
                Enforce data-access boundaries, control sensitive actions, and
                explain every decision.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <span
                  className={`h-2 w-2 rounded-full ${live ? "bg-allow" : "bg-muted"}`}
                />
                {live ? "Realtime connected" : "Realtime connecting"}
              </span>
              <ThemeToggle />
              {state?.operator ? (
                <>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      act("reset", async () => [await post("/api/reset")])
                    }
                    className={button.quiet}
                  >
                    Clear history
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      act("signout", async () => [
                        await post("/api/operator", {}, "DELETE"),
                      ])
                    }
                    className={button.secondary}
                  >
                    Operator · sign out
                  </button>
                </>
              ) : signingIn ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const passcode = new FormData(e.currentTarget).get(
                      "passcode",
                    );
                    act("signin", async () => [
                      await post("/api/operator", { passcode }),
                    ]).then(() => setSigningIn(false));
                  }}
                >
                  <label className="sr-only" htmlFor="passcode">
                    Operator passcode
                  </label>
                  <input
                    id="passcode"
                    name="passcode"
                    type="password"
                    autoFocus
                    placeholder="Operator passcode"
                    className="w-44 rounded-lg border border-line bg-raised px-3 py-2 text-sm"
                  />
                  <button type="submit" className={button.primary}>
                    Sign in
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setSigningIn(true)}
                  className={button.secondary}
                >
                  Operator sign-in
                </button>
              )}
              <VictimLink />
            </div>
          </header>

          <nav
            aria-label="Views"
            className="mt-5 flex gap-1 overflow-x-auto border-b border-line"
          >
            {VIEWS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => go(id)}
                aria-current={view === id ? "page" : undefined}
                className={`relative shrink-0 px-3.5 py-2.5 text-sm font-medium transition-colors ${
                  view === id ? "text-text" : "text-muted hover:text-text"
                }`}
              >
                {label}
                {view === id && (
                  <motion.span
                    layoutId="tab-underline"
                    transition={spring}
                    className="absolute inset-x-0 -bottom-px h-0.5 bg-brand"
                  />
                )}
              </button>
            ))}
          </nav>

          {error && (
            <p
              role="alert"
              className="mt-4 flex items-center gap-2 rounded-lg border border-deny/40 bg-deny/10 px-3 py-2 text-sm text-deny"
            >
              <Icon name="alert" /> {error}
            </p>
          )}
        </Dim>

        <div className="mt-5">
          {!state ? (
            loadError ? (
              <p
                role="alert"
                className="rounded-lg border border-deny/40 bg-deny/10 px-3 py-6 text-center text-sm text-deny"
              >
                Could not load the dashboard: {loadError}
              </p>
            ) : (
              <p className="py-16 text-center text-sm text-muted">
                Loading state from the backend
              </p>
            )
          ) : (
            // The next view mounts at once, with no exit to wait for: a view must never depend on an animation finishing.
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {view === "overview" ? (
                <Overview state={state} {...props} />
              ) : view === "sql-breaker" ? (
                <SqlBreaker />
              ) : view === "live-service" ? (
                <LiveService />
              ) : view === "attack-lab" ? (
                <AttackLab state={state} {...props} />
              ) : view === "sessions" ? (
                <Sessions state={state} {...props} />
              ) : view === "policies" ? (
                <Policies state={state} {...props} />
              ) : (
                <AuditLog state={state} {...props} />
              )}
            </motion.div>
          )}
        </div>

        {/* From any other view: one click goes to Overview and starts the demo there. */}
        {view !== "overview" && (
          <motion.button
            type="button"
            onClick={() => {
              go("overview");
              setDemoPending(true);
            }}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={bouncy}
            className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full border border-allow/50 bg-panel px-4 py-2.5 text-sm font-semibold text-allow shadow-lg shadow-black/25 hover:bg-raised"
          >
            <Icon name="shield" className="h-4 w-4" />
            Live demo
          </motion.button>
        )}
      </main>
    </MotionConfig>
  );
}
