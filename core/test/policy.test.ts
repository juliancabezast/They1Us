// The truth table of the policy (plan section 7). Pure: no database needed.
import { describe, expect, it } from "vitest";
import { decide } from "../src/policy";
import type { Flags, QueryFacts, Rule } from "../src/types";

const CLEAN: Flags = { hasUntrusted: false, hasSecret: false };
const UNTRUSTED: Flags = { hasUntrusted: true, hasSecret: false };
const SECRET: Flags = { hasUntrusted: false, hasSecret: true };
// Unreachable through the policy itself, but decide() must still behave if it is handed in.
const BOTH: Flags = { hasUntrusted: true, hasSecret: true };

const ALL_FLAGS: [string, Flags][] = [
  ["clean", CLEAN],
  ["untrusted", UNTRUSTED],
  ["secret", SECRET],
  ["both", BOTH],
];

/** A plain read of an unlabeled table, plus whatever the case overrides. */
function facts(overrides: Partial<QueryFacts> = {}): QueryFacts {
  return {
    explainable: true,
    relations: [],
    touchesBreakerSchema: false,
    touchesUntrusted: false,
    touchesSecret: false,
    writesUntrusted: false,
    isWrite: false,
    hasOpaqueNode: false,
    unlistedFunctions: [],
    ...overrides,
  };
}

const READ_UNLABELED = facts();
const READ_UNTRUSTED = facts({ touchesUntrusted: true });
const READ_SECRET = facts({ touchesSecret: true });
const READ_BOTH = facts({ touchesUntrusted: true, touchesSecret: true });
const WRITE = facts({ isWrite: true });
// UPDATE and DELETE scan their target, so they read the untrusted columns too.
const UPDATE_UNTRUSTED = facts({ isWrite: true, touchesUntrusted: true });
const NOT_EXPLAINABLE = facts({
  explainable: false,
  opaqueReason: "multiple statements",
  failedAt: "precheck",
});
const BREAKER_SCHEMA = facts({ touchesBreakerSchema: true });
const FUNCTION_SCAN = facts({ hasOpaqueNode: true });
const UNLISTED = facts({ unlistedFunctions: ["query_to_xml"] });

type Row = {
  n: number;
  name: string;
  before: Flags;
  query: QueryFacts;
  rule: Rule;
  /** Flags an allow must end with. A deny always ends with the flags before. */
  after?: Flags;
};

// Rows 11, 12 and 16 say "any": they are the loops further down.
const ROWS: Row[] = [
  { n: 1, name: "clean, reads unlabeled table", before: CLEAN, query: READ_UNLABELED, rule: "ALLOW", after: CLEAN },
  { n: 2, name: "clean, reads untrusted", before: CLEAN, query: READ_UNTRUSTED, rule: "ALLOW", after: UNTRUSTED },
  { n: 3, name: "clean, reads secret", before: CLEAN, query: READ_SECRET, rule: "ALLOW", after: SECRET },
  { n: 4, name: "untrusted, reads secret", before: UNTRUSTED, query: READ_SECRET, rule: "R2_TRIFECTA_MIX" },
  { n: 5, name: "secret, reads untrusted", before: SECRET, query: READ_UNTRUSTED, rule: "R2_TRIFECTA_MIX" },
  { n: 6, name: "clean, reads untrusted and secret in one query", before: CLEAN, query: READ_BOTH, rule: "R2_TRIFECTA_MIX" },
  { n: 7, name: "untrusted, write to any table", before: UNTRUSTED, query: WRITE, rule: "R3_TAINTED_WRITE" },
  { n: 8, name: "clean, UPDATE that scans an untrusted table", before: CLEAN, query: UPDATE_UNTRUSTED, rule: "R3_TAINTED_WRITE" },
  // INSERT ... VALUES has no scan of its target: writing a column is not reading it.
  { n: 9, name: "clean, INSERT ... VALUES into untrusted table", before: CLEAN, query: WRITE, rule: "ALLOW", after: CLEAN },
  { n: 10, name: "secret, write to unlabeled table", before: SECRET, query: WRITE, rule: "ALLOW", after: SECRET },
  { n: 13, name: "untrusted, Function Scan", before: UNTRUSTED, query: FUNCTION_SCAN, rule: "R4_OPAQUE_IN_FLAGGED_SESSION" },
  { n: 14, name: "clean, Function Scan", before: CLEAN, query: FUNCTION_SCAN, rule: "ALLOW", after: CLEAN },
  { n: 15, name: "untrusted, reads untrusted again", before: UNTRUSTED, query: READ_UNTRUSTED, rule: "ALLOW", after: UNTRUSTED },
];

describe("decide: truth table", () => {
  for (const row of ROWS) {
    it(`row ${row.n}: ${row.name} -> ${row.rule}`, () => {
      const d = decide(row.before, row.query);
      expect(d.rule).toBe(row.rule);
      expect(d.decision).toBe(row.rule === "ALLOW" ? "allow" : "deny");
      expect(d.flagsAfter).toEqual(row.after ?? row.before);
      expect(d.reason.length).toBeGreaterThan(0);
    });
  }

  for (const [label, before] of ALL_FLAGS) {
    it(`row 11: ${label}, not explainable -> R0_OPAQUE_STATEMENT`, () => {
      const d = decide(before, NOT_EXPLAINABLE);
      expect(d.decision).toBe("deny");
      expect(d.rule).toBe("R0_OPAQUE_STATEMENT");
      expect(d.reason).toContain("multiple statements");
      expect(d.flagsAfter).toEqual(before);
    });

    it(`row 12: ${label}, touches breaker schema -> R1_PROTECTED_OBJECT`, () => {
      const d = decide(before, BREAKER_SCHEMA);
      expect(d.decision).toBe("deny");
      expect(d.rule).toBe("R1_PROTECTED_OBJECT");
      expect(d.flagsAfter).toEqual(before);
    });
  }
});

describe("decide: a deny never changes flags (row 16)", () => {
  // One set of facts per deny rule, plus combinations that would move the flags if allowed.
  const QUERIES: [string, QueryFacts][] = [
    ["not explainable", NOT_EXPLAINABLE],
    ["not explainable, reads both", facts({ explainable: false, touchesUntrusted: true, touchesSecret: true })],
    ["breaker schema", BREAKER_SCHEMA],
    ["breaker schema, reads secret", facts({ touchesBreakerSchema: true, touchesSecret: true })],
    ["unlisted function", UNLISTED],
    ["unlisted function, reads untrusted", facts({ unlistedFunctions: ["dblink"], touchesUntrusted: true })],
    ["reads unlabeled", READ_UNLABELED],
    ["reads untrusted", READ_UNTRUSTED],
    ["reads secret", READ_SECRET],
    ["reads both", READ_BOTH],
    ["write", WRITE],
    ["update of untrusted", UPDATE_UNTRUSTED],
    ["function scan", FUNCTION_SCAN],
    ["function scan, reads untrusted", facts({ hasOpaqueNode: true, touchesUntrusted: true })],
    ["function scan, reads secret", facts({ hasOpaqueNode: true, touchesSecret: true })],
  ];

  for (const [label, before] of ALL_FLAGS) {
    it(`row 16: ${label} session`, () => {
      const snapshot = { ...before };
      let denies = 0;
      for (const [, query] of QUERIES) {
        const d = decide(before, query);
        if (d.decision !== "deny") continue;
        denies += 1;
        expect(d.rule).not.toBe("ALLOW");
        expect(d.flagsAfter).toEqual(snapshot);
      }
      // Every flag state meets at least the R0, R1 and R5 denies: the loop is not vacuous.
      expect(denies).toBeGreaterThanOrEqual(6);
      // decide() never mutates its input.
      expect(before).toEqual(snapshot);
    });
  }
});

describe("decide: R5 unlisted function", () => {
  it("denies in a clean session and names the function", () => {
    const d = decide(CLEAN, UNLISTED);
    expect(d.decision).toBe("deny");
    expect(d.rule).toBe("R5_UNLISTED_FUNCTION");
    expect(d.reason).toContain("query_to_xml");
    expect(d.flagsAfter).toEqual(CLEAN);
  });

  it("denies in a flagged session and names every function", () => {
    const query = facts({ unlistedFunctions: ["query_to_xml", "pg_read_file"] });
    for (const before of [UNTRUSTED, SECRET]) {
      const d = decide(before, query);
      expect(d.decision).toBe("deny");
      expect(d.rule).toBe("R5_UNLISTED_FUNCTION");
      expect(d.reason).toContain("query_to_xml");
      expect(d.reason).toContain("pg_read_file");
      expect(d.flagsAfter).toEqual(before);
    }
  });

  it("is reported before R2, R3 and R4", () => {
    const query = facts({
      unlistedFunctions: ["query_to_xml"],
      touchesUntrusted: true,
      touchesSecret: true,
      isWrite: true,
      hasOpaqueNode: true,
    });
    expect(decide(CLEAN, query).rule).toBe("R5_UNLISTED_FUNCTION");
  });

  it("gives way to R1", () => {
    const query = facts({ touchesBreakerSchema: true, unlistedFunctions: ["query_to_xml"] });
    expect(decide(CLEAN, query).rule).toBe("R1_PROTECTED_OBJECT");
  });
});

describe("decide: rule order", () => {
  it("R0 wins over everything", () => {
    const everything = facts({
      explainable: false,
      touchesBreakerSchema: true,
      touchesUntrusted: true,
      touchesSecret: true,
      isWrite: true,
      hasOpaqueNode: true,
      unlistedFunctions: ["query_to_xml"],
    });
    for (const [, before] of ALL_FLAGS) {
      const d = decide(before, everything);
      expect(d.decision).toBe("deny");
      expect(d.rule).toBe("R0_OPAQUE_STATEMENT");
      // No opaqueReason given: the reason still reads as a sentence.
      expect(d.reason).toContain("unknown");
      expect(d.flagsAfter).toEqual(before);
    }
  });

  it("R1 wins over R2", () => {
    const query = facts({ touchesBreakerSchema: true, touchesUntrusted: true, touchesSecret: true });
    expect(decide(CLEAN, query).rule).toBe("R1_PROTECTED_OBJECT");
    expect(decide(UNTRUSTED, facts({ touchesBreakerSchema: true, touchesSecret: true })).rule).toBe(
      "R1_PROTECTED_OBJECT",
    );
  });

  it("R2 wins over R3 and R4", () => {
    const query = facts({ touchesSecret: true, isWrite: true, hasOpaqueNode: true });
    expect(decide(UNTRUSTED, query).rule).toBe("R2_TRIFECTA_MIX");
  });

  it("R3 wins over R4", () => {
    expect(decide(UNTRUSTED, facts({ isWrite: true, hasOpaqueNode: true })).rule).toBe("R3_TAINTED_WRITE");
  });

  it("R4 also fires when the same statement is what flags the session", () => {
    expect(decide(CLEAN, facts({ hasOpaqueNode: true, touchesSecret: true })).rule).toBe(
      "R4_OPAQUE_IN_FLAGGED_SESSION",
    );
    expect(decide(SECRET, FUNCTION_SCAN).rule).toBe("R4_OPAQUE_IN_FLAGGED_SESSION");
  });
});

describe("decide: an allow returns the union of flags", () => {
  const CASES: [string, Flags, QueryFacts, Flags][] = [
    ["clean + unlabeled", CLEAN, READ_UNLABELED, CLEAN],
    ["clean + untrusted", CLEAN, READ_UNTRUSTED, UNTRUSTED],
    ["clean + secret", CLEAN, READ_SECRET, SECRET],
    ["untrusted + unlabeled", UNTRUSTED, READ_UNLABELED, UNTRUSTED],
    ["untrusted + untrusted", UNTRUSTED, READ_UNTRUSTED, UNTRUSTED],
    ["secret + unlabeled", SECRET, READ_UNLABELED, SECRET],
    ["secret + secret", SECRET, READ_SECRET, SECRET],
    ["secret + write that reads secret", SECRET, facts({ isWrite: true, touchesSecret: true }), SECRET],
  ];

  for (const [name, before, query, expected] of CASES) {
    it(name, () => {
      const snapshot = { ...before };
      const d = decide(before, query);
      expect(d.decision).toBe("allow");
      expect(d.rule).toBe("ALLOW");
      expect(d.flagsAfter).toEqual(expected);
      expect(d.flagsAfter).toEqual({
        hasUntrusted: before.hasUntrusted || query.touchesUntrusted,
        hasSecret: before.hasSecret || query.touchesSecret,
      });
      // A fresh object: writing the new flags can never alias the ones that were read.
      expect(d.flagsAfter).not.toBe(before);
      expect(before).toEqual(snapshot);
    });
  }

  it("flags only ever grow: no allow clears a stamp", () => {
    for (const [, before] of ALL_FLAGS) {
      const d = decide(before, READ_UNLABELED);
      if (d.decision !== "allow") continue;
      expect(d.flagsAfter.hasUntrusted || !before.hasUntrusted).toBe(true);
      expect(d.flagsAfter.hasSecret || !before.hasSecret).toBe(true);
    }
  });
});
