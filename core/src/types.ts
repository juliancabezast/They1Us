// The shared contract of the Breaker core. Types only: no database, no I/O.

/** The stamps on a session: which kinds of labeled data it has been exposed to. */
export type Flags = { hasUntrusted: boolean; hasSecret: boolean };

export type Relation = { schema: string; name: string; scanned: boolean; written: boolean };

/** One row of breaker.column_labels (Breaker DB). It points at a column that lives in the Customer DB. */
export type LabelRow = { table_schema: string; table_name: string; column_name: string; label: "untrusted" | "secret" };

/** Where a refused statement stopped on its way to Postgres. */
export type Stage = "precheck" | "explain" | "policy";

export type QueryFacts = {
  /** false: we could not analyze it, so it is refused. */
  explainable: boolean;
  /** Why not. Safe to show to the agent: never raw planner error text outside SQLSTATE class 42. */
  opaqueReason?: string;
  failedAt?: "precheck" | "explain";
  relations: Relation[];
  /** Touches breaker bookkeeping, or anything outside what the agent role may use. */
  touchesBreakerSchema: boolean;
  /** A relation with untrusted columns was READ. Writing a column is not reading it. */
  touchesUntrusted: boolean;
  touchesSecret: boolean;
  /** A relation with untrusted columns is WRITTEN: a table outsiders reach, so a way out for a secret. */
  writesUntrusted: boolean;
  isWrite: boolean;
  /** Function Scan, Foreign Scan, Table Function Scan: nodes we cannot see inside. */
  hasOpaqueNode: boolean;
  /** Function calls outside the allowlist. A function can read tables without EXPLAIN showing it. */
  unlistedFunctions: string[];
};

export type Rule =
  | "ALLOW"
  | "R0_OPAQUE_STATEMENT"
  | "R1_PROTECTED_OBJECT"
  | "R2_TRIFECTA_MIX"
  | "R3_TAINTED_WRITE"
  | "R4_OPAQUE_IN_FLAGGED_SESSION"
  | "R5_UNLISTED_FUNCTION"
  | "R6_SECRET_SINK";

export type Decision = {
  decision: "allow" | "deny";
  rule: Rule;
  reason: string;
  /** On deny this equals the flags before: nothing ran. */
  flagsAfter: Flags;
};

/** What every result carries, so a caller can explain the decision without reading the log. */
export type Audit = {
  rule: Rule;
  reason: string;
  flagsBefore: Flags;
  flagsAfter: Flags;
  /** null when the statement passed every checkpoint. */
  stoppedAt: Stage | null;
  eventId: number;
};

export type GuardResult =
  | ({ ok: true; decision: "allow"; rows: unknown[]; rowCount: number; truncated: boolean } & Audit)
  | ({ ok: false; decision: "deny" } & Audit)
  /** Allowed, but the SQL itself failed. The session keeps the flags: assume it was exposed. */
  | ({ ok: false; decision: "allow"; error: string; errorCode: string | null } & Audit);

// ---- HTTP API (core/src/server.ts): POST /sessions, POST /execute, GET /health ----
export type CreateSessionResponse = { sessionId: string };
export type ExecuteRequest = { sessionId: string; sql: string };

/** Rows returned to the agent are capped. */
export const ROW_CAP = 200;

/** Every rule with the sentence the dashboard and the docs show for it. */
export const RULES: Record<Rule, string> = {
  ALLOW: "No policy violated.",
  R0_OPAQUE_STATEMENT: "The statement could not be analyzed, so it is refused.",
  R1_PROTECTED_OBJECT: "Agent SQL may not touch the breaker schema or anything outside the customer's own tables.",
  R2_TRIFECTA_MIX: "A session cannot hold both untrusted and secret data.",
  R3_TAINTED_WRITE: "A session that has read untrusted data cannot write.",
  R4_OPAQUE_IN_FLAGGED_SESSION: "The query uses an object the analyzer cannot see into.",
  R5_UNLISTED_FUNCTION: "The query calls a function that is not on the allowlist.",
  R6_SECRET_SINK: "A session that holds secret data cannot write into a table outsiders can reach.",
};
