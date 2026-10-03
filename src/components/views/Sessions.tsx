"use client";

import { useState } from "react";
import { CATALOG, REASONS, decide, labelsIntroduced } from "@/lib/policy";
import { EventList } from "../EventList";
import { Flow } from "../Flow";
import { Chip, DecisionBadge, Empty, Panel, shortId, time } from "../ui";
import type { ViewProps } from "./props";

export function Sessions({ state }: ViewProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const ctx = state.contexts.find((c) => c.id === picked) ?? state.contexts[0];
  if (!ctx) return <Panel title="Contexts"><Empty>No contexts yet. Run something from Attack Lab.</Empty></Panel>;

  const events = state.events.filter((e) => e.context_id === ctx.id).reverse();
  const current = { untrusted: ctx.has_untrusted, secret: ctx.has_secret };

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel title="Contexts">
        <ul className="space-y-1.5">
          {state.contexts.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setPicked(c.id)}
                aria-current={c.id === ctx.id}
                className={`w-full rounded-lg border px-3 py-2 text-left ${c.id === ctx.id ? "border-muted bg-raised" : "border-transparent hover:bg-raised"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <code className="font-mono text-xs">{shortId(c.id)}</code>
                  <span className="text-[11px] text-muted">{time(c.created_at)}</span>
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  <Chip>{c.kind}</Chip>
                  <Chip tone={c.mode === "sandbox" ? "deny" : "neutral"}>{c.mode}</Chip>
                  {c.has_untrusted && <Chip tone="untrusted">untrusted</Chip>}
                  {c.has_secret && <Chip tone="secret">secret</Chip>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="space-y-5">
        <Panel title={`Context ${shortId(ctx.id)}`} aside={<span className="font-mono text-[11px] text-muted">{ctx.principal}</span>}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Holds:</span>
            {ctx.has_untrusted && <Chip tone="untrusted">untrusted content</Chip>}
            {ctx.has_secret && <Chip tone="secret">secret data</Chip>}
            {!ctx.has_untrusted && !ctx.has_secret && <Chip>nothing labeled yet</Chip>}
            <span className="ml-auto text-muted">
              {ctx.sessions.length} session{ctx.sessions.length === 1 ? "" : "s"}: <code className="font-mono text-xs">{ctx.sessions.map(shortId).join(", ")}</code>
            </span>
          </div>
          <p className="mt-2 text-sm text-muted">
            Labels belong to the context, not the session. Every session above shares them, and nothing removes them.
          </p>
          <div className="mt-4"><Flow events={events} caption="Nothing blocked in this context." /></div>
        </Panel>

        <Panel title="What this context may do next">
          {ctx.mode === "sandbox" ? (
            <p className="text-sm text-muted">Sandbox contexts have no policy. The gateway refuses them (WRONG_MODE).</p>
          ) : (
            <ul className="divide-y divide-line">
              {[...CATALOG.values()].map((op) => {
                const verdict = decide(current, op, labelsIntroduced(op, state.labels).state, false);
                return (
                  <li key={op.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <code className="w-52 font-mono text-[13px]">{op.id}</code>
                    <DecisionBadge decision={verdict.decision} />
                    <span className="text-sm text-muted">{REASONS[verdict.reason]}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="History"><EventList events={events} empty="No operations in this context." /></Panel>
      </div>
    </div>
  );
}
