// CLI entry point, never imported. Replays the scripted scenarios with no LLM:
//   npx tsx --env-file=.env.local core/src/replay.ts <A|B|C|D|E|F|all> [--protected|--unprotected] [--keep]
import { assertEnv, closePools } from "./db";
import { runScenario } from "./runner";
import { SCENARIOS, SCENARIO_IDS } from "./scenarios";
import type { Mode, ScenarioId, ScenarioRun, StepResult } from "./scenarios";
import type { Flags } from "./types";

const USAGE = [
  "usage: replay.ts <A|B|C|D|E|F|all> [--protected|--unprotected] [--keep]   (default: --protected)",
  "",
  "  --keep  leave the run's ticket in the Customer DB, to show the attacker's view afterwards",
  "",
  ...SCENARIO_IDS.map((id) => `  ${id}  ${SCENARIOS[id].title}: ${SCENARIOS[id].summary}`),
  "  all  the six, in order",
].join("\n");

// Plain text when piped or when NO_COLOR is set, so the output can be pasted anywhere.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

const SQL_WIDTH = 70;

const shorten = (sql: string) => {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > SQL_WIDTH ? `${flat.slice(0, SQL_WIDTH - 1)}…` : flat;
};

const stamps = (f: Flags) =>
  [f.hasUntrusted && "untrusted", f.hasSecret && "secret"].filter(Boolean).join("+") || "clean";

/** The plain text of every column, so widths are measured before any color goes on. */
function cells(s: StepResult) {
  const failure = s.errorCode ? `SQLSTATE ${s.errorCode}` : "no SQLSTATE";
  return {
    n: String(s.n).padStart(2),
    sql: shorten(s.sql),
    outcome: s.outcome.toUpperCase(),
    // An allowed step fired no rule, and an unprotected one was never checked.
    rule: s.rule === null || s.rule === "ALLOW" ? "-" : s.rule,
    flags: s.flagsBefore && s.flagsAfter ? `${stamps(s.flagsBefore)} → ${stamps(s.flagsAfter)}` : "-",
    note:
      s.outcome === "failed"
        ? failure
        : s.outcome === "allow" && (s.errorCode !== null || s.rowCount === null)
          ? `failed while running (${failure})`
          : s.outcome === "deny"
            ? ""
            : `${s.rowCount ?? 0} ${s.rowCount === 1 ? "row" : "rows"}`,
  };
}

function print(run: ScenarioRun, kept: boolean): void {
  const scenario = SCENARIOS[run.scenario];
  const rows = run.steps.map((s) => ({ step: s, text: cells(s) }));
  const width = (key: "sql" | "outcome" | "rule" | "flags", heading: string) =>
    Math.max(heading.length, ...rows.map((r) => r.text[key].length));
  const w = {
    sql: width("sql", "statement"),
    outcome: width("outcome", "decision"),
    rule: width("rule", "rule"),
    flags: width("flags", "flags"),
  };

  const mode = run.mode === "protected" ? green("PROTECTED") : red("UNPROTECTED");
  console.log("");
  console.log(`${bold(`Scenario ${scenario.id}: ${scenario.title}`)}  ${mode}`);
  console.log(dim(scenario.summary));
  console.log(dim(`session ${run.sessionId}  attacker's ticket #${run.ticket.id}${kept ? " (kept)" : ""}`));
  console.log("");
  console.log(
    dim(`   #  ${"statement".padEnd(w.sql)}  ${"decision".padEnd(w.outcome)}  ${"rule".padEnd(w.rule)}  flags`),
  );

  for (const { step, text } of rows) {
    const good = step.outcome === "allow" || step.outcome === "executed";
    const tint = good ? green : red;
    const ranBadly = step.outcome === "failed" || (step.outcome === "allow" && text.note.startsWith("failed"));
    const line = [
      `  ${dim(text.n)}`,
      text.sql.padEnd(w.sql),
      bold(tint(text.outcome.padEnd(w.outcome))),
      tint(text.rule.padEnd(w.rule)),
    ];
    // No padding after the last column: a painted line cannot be trimmed afterwards.
    if (text.note) line.push(text.flags.padEnd(w.flags), ranBadly ? red(text.note) : dim(text.note));
    else line.push(text.flags);
    console.log(line.join("  "));
    // The sentence the agent gets back with a refusal.
    if (step.outcome === "deny" && step.reason) console.log(`      ${dim(step.reason)}`);
    if (run.mode === "protected" && step.rule !== step.expected) {
      console.log(`      ${yellow(`UNEXPECTED: the script expects ${step.expected}`)}`);
    }
  }

  console.log("");
  if (run.leaked) console.log(`  ${bold(red(`LEAKED: ${run.ticket.reply}`))}`);
  else if (!run.ticket.reply) console.log(`  ${bold(green("reply is empty: nothing left the database"))}`);
  else console.log(`  ${yellow(`reply was written but carries no token: ${run.ticket.reply}`)}`);
}

function parseArgs(argv: string[]): { ids: ScenarioId[]; mode: Mode; keep: boolean } | null {
  let mode: Mode | null = null;
  let target: string | null = null;
  let keep = false;
  for (const arg of argv) {
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--protected" || arg === "--unprotected") {
      const asked: Mode = arg === "--protected" ? "protected" : "unprotected";
      if (mode !== null && mode !== asked) return null;
      mode = asked;
    } else if (arg.startsWith("-") || target !== null) {
      return null;
    } else {
      target = arg.toUpperCase();
    }
  }
  if (target === null) return null;
  const ids = target === "ALL" ? SCENARIO_IDS : SCENARIO_IDS.filter((id) => id === target);
  return ids.length ? { ids, mode: mode ?? "protected", keep } : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  // A clear message now, instead of a connection error in the middle of the first scenario.
  assertEnv();

  const runs: ScenarioRun[] = [];
  for (const id of args.ids) {
    const run = await runScenario(id, args.mode, { keep: args.keep });
    print(run, args.keep);
    runs.push(run);
  }

  const unexpected = runs.filter((r) => r.asExpected === false).length;
  const leaks = runs.filter((r) => r.leaked).length;
  if (runs.length > 1) {
    console.log("");
    const leakLine = `${leaks} of ${runs.length} runs leaked a token`;
    if (args.mode === "protected") {
      const verdict = `${runs.length - unexpected} of ${runs.length} scenarios answered as expected`;
      console.log(`${bold(unexpected ? red(verdict) : green(verdict))}${dim(", ")}${leaks ? red(leakLine) : dim(leakLine)}`);
    } else {
      console.log(bold(leaks ? red(leakLine) : green(leakLine)));
    }
  }
  console.log("");

  // A protected run that did not answer as scripted is a broken Breaker: make CI and the stage notice.
  if (unexpected) process.exitCode = 1;
}

main()
  .catch((err) => {
    // Message only: a pg error object can carry connection details.
    console.error(red(`failed: ${err instanceof Error ? err.message : "unknown error"}`));
    process.exitCode = 1;
  })
  .finally(() => closePools().catch(() => {}));
