// The policy: (session flags, query facts) -> allow | deny. Pure: no database, no I/O.
import { RULES } from "./types";
import type { Decision, Flags, QueryFacts, Rule } from "./types";

/**
 * Decides on the state the session WOULD be in after the statement, not on the
 * state it is in now. The order of the checks is the contract: the first rule
 * that fires wins. On deny the flags do not change, because nothing ran.
 */
export function decide(before: Flags, f: QueryFacts): Decision {
  // A copy, so a caller mutating the decision can never change the flags it passed in.
  const deny = (rule: Exclude<Rule, "ALLOW">, reason: string): Decision => ({
    decision: "deny",
    rule,
    reason,
    flagsAfter: { hasUntrusted: before.hasUntrusted, hasSecret: before.hasSecret },
  });

  // Fail closed: what we cannot analyze never reaches Postgres. The other facts
  // of an unexplainable statement are not trustworthy, so this check comes first.
  if (!f.explainable) {
    return deny(
      "R0_OPAQUE_STATEMENT",
      `Statement could not be analyzed (${f.opaqueReason ?? "unknown"}).`,
    );
  }

  // The agent may never edit its own stamps or labels, nor leave its own data.
  if (f.touchesBreakerSchema) {
    return deny("R1_PROTECTED_OBJECT", RULES.R1_PROTECTED_OBJECT);
  }

  // Every session, flagged or clean: a function can read tables without EXPLAIN
  // showing a scan, so the labels below would be blind to what it reads.
  if (f.unlistedFunctions.length > 0) {
    return deny(
      "R5_UNLISTED_FUNCTION",
      `${RULES.R5_UNLISTED_FUNCTION} Not allowed: ${f.unlistedFunctions.join(", ")}.`,
    );
  }

  const after: Flags = {
    hasUntrusted: before.hasUntrusted || f.touchesUntrusted,
    hasSecret: before.hasSecret || f.touchesSecret,
  };

  if (after.hasUntrusted && after.hasSecret) {
    return deny("R2_TRIFECTA_MIX", RULES.R2_TRIFECTA_MIX);
  }

  // "after", not "before": an UPDATE that scans an untrusted table is refused
  // even in a clean session, because it reads and writes in one statement.
  if (after.hasUntrusted && f.isWrite) {
    return deny("R3_TAINTED_WRITE", RULES.R3_TAINTED_WRITE);
  }

  // The mirror of R3. A table with untrusted columns is one outsiders reach (the attacker files a
  // ticket and reads its reply), so a secret written there has left: INSERT ... SELECT token in one
  // statement, or a read followed by an INSERT of the literal. A plain INSERT never scans its target,
  // so R2 does not see it.
  if (after.hasSecret && f.writesUntrusted) {
    return deny("R6_SECRET_SINK", RULES.R6_SECRET_SINK);
  }

  if ((after.hasUntrusted || after.hasSecret) && f.hasOpaqueNode) {
    return deny("R4_OPAQUE_IN_FLAGGED_SESSION", RULES.R4_OPAQUE_IN_FLAGGED_SESSION);
  }

  return { decision: "allow", rule: "ALLOW", reason: RULES.ALLOW, flagsAfter: after };
}
