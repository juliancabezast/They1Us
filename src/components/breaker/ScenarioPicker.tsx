"use client";

import { motion } from "motion/react";
import { SCENARIOS, SCENARIO_IDS, type ScenarioId } from "@core/scenarios";
import { spring } from "../motion";

/** Segmented control for the six scripted scenarios. The selection slides between segments. */
export function ScenarioPicker({ value, onChange }: { value: ScenarioId; onChange: (id: ScenarioId) => void }) {
  return (
    <div
      role="group"
      aria-label="Scenario"
      className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-panel p-1 sm:grid-cols-3 xl:grid-cols-6"
    >
      {SCENARIO_IDS.map((id) => {
        const selected = id === value;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(id)}
            className={`relative flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium leading-tight transition-colors sm:text-sm ${
              selected ? "text-text" : "text-muted hover:text-text"
            }`}
          >
            {selected && (
              <motion.span
                layoutId="scenario-selected"
                transition={spring}
                className="absolute inset-0 rounded-lg border border-line bg-raised"
              />
            )}
            <span
              className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-xs font-semibold ${
                selected ? "bg-brand text-on-brand" : "bg-text/5 text-muted"
              }`}
            >
              {id}
            </span>
            <span className="relative min-w-0">{SCENARIOS[id].title}</span>
          </button>
        );
      })}
    </div>
  );
}
