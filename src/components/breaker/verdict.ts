// One sentence that compares the two lanes of a run. Built only from what the API returned.
import type { ScenarioRun } from "@core/scenarios";

/** A plain string, or a rule code that is set in the mono font. */
export type VerdictPart = string | { code: string };

export interface Verdict {
  /** allow: the Breaker held. hold: it answered differently than the scenario expects. deny: the token got out anyway. */
  tone: "allow" | "hold" | "deny";
  parts: VerdictPart[];
}

const count = (n: number) => (n === 1 ? "1 statement" : `${n} statements`);
const every = (n: number) => (n === 1 ? "the statement" : n === 2 ? "both statements" : `all ${n} statements`);
const capital = (text: string) => text[0].toUpperCase() + text.slice(1);

export function verdict(off: ScenarioRun, on: ScenarioRun): Verdict {
  const n = on.steps.length;
  const stop = on.steps.find((s) => s.outcome === "deny");
  const rule = { code: stop?.rule ?? "" };

  if (on.leaked) {
    return {
      tone: "deny",
      parts: ["The token reached the attacker with the Breaker on. This run did not hold: read the decision log below."],
    };
  }

  const parts: VerdictPart[] = [];
  if (!stop) {
    parts.push(
      off.leaked
        ? `Off: the token reached the attacker in ${count(off.steps.length)}. On: ${every(n)} ran and the token stayed in the database.`
        : `${capital(every(n))} ran in both lanes: normal work is never interrupted.`,
    );
  } else {
    parts.push("Same agent, same SQL. ");

    const refused = off.steps.find((s) => s.outcome === "failed");
    if (off.leaked) parts.push(`Off: the token reached the attacker in ${count(off.steps.length)}. `);
    else if (!refused) parts.push(`Off: ${every(off.steps.length)} ran unchecked. `);
    else {
      const state = refused.errorCode ? ` (SQLSTATE ${refused.errorCode})` : "";
      parts.push(
        off.steps.length === 1
          ? `Off: only Postgres itself refused it${state}. `
          : `Off: only Postgres itself refused statement ${refused.n}${state}. `,
      );
    }

    if (stop.stoppedAt === "precheck") parts.push("On: refused before it reached the planner by ", rule, ".");
    // Found while Postgres planned it: an object the agent role may not use, or a function off the allowlist.
    else if (stop.stoppedAt === "explain") parts.push("On: refused during analysis, before anything ran, by ", rule, ".");
    else if (n === 1) parts.push("On: refused by ", rule, " before it ran.");
    else parts.push(`On: stopped at statement ${stop.n} by `, rule, ".");
  }

  if (on.asExpected === false) {
    parts.push(" The Breaker answered differently than this scenario expects.");
    return { tone: "hold", parts };
  }
  return { tone: "allow", parts };
}
