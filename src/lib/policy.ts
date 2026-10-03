// The policy: labels, the operation catalog and the decision function.
// Pure module (no database, no secrets) so the dashboard can import it to
// explain a context's current restrictions with the same code the gateway runs.

export const POLICY_VERSION = "2026-10-03.2";
export const APPROVAL_TTL_MINUTES = 10;

export type Label = "untrusted" | "secret";
export type Decision =
  | "ALLOWED"
  | "DENIED"
  | "APPROVAL_REQUIRED"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTION_FAILED"
  | "UNCHECKED";

export interface ContextState {
  untrusted: boolean;
  secret: boolean;
}

export interface LabelRow {
  table_name: string;
  column_name: string;
  label: Label;
}

export class ParamError extends Error {}

type Params = Record<string, string | number>;

export interface Operation {
  id: string;
  version: number;
  description: string;
  /** Who may call it. Only the agent runtime calls catalog operations. */
  permission: "agent";
  /** Every column the statement depends on: returned, filtered or joined. */
  reads: string[];
  writes: string[];
  /** Where output leaves the system. null means the result only returns to the agent. */
  destination: null | { kind: "customer_reply"; description: string };
  /** Fixed, parameterized statement. Values never get concatenated into it. */
  sql: string;
  /** Rejects anything outside the schema, including unknown keys. */
  parse(raw: unknown): Params;
  /** Positional values. The run scope comes from the server-side context, never from the caller. */
  values(runId: string, params: Params): unknown[];
}

function record(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ParamError("params must be an object");
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ParamError(`unexpected parameter: ${extra.join(", ")}`);
  return raw as Record<string, unknown>;
}

function ticketId(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new ParamError("ticketId must be a positive integer");
  return v;
}

const TICKET_COLUMNS = ["id", "run_id", "customer_email", "subject", "body", "reply", "replied_at", "created_at"].map(
  (c) => `support_tickets.${c}`,
);
export const TOKEN_SERVICES = ["billing-api", "chat-api"];

const OPERATIONS: Operation[] = [
  {
    id: "tickets.list_open",
    version: 1,
    description: "List the unanswered support tickets in this run.",
    permission: "agent",
    reads: TICKET_COLUMNS,
    writes: [],
    destination: null,
    sql: `select id, customer_email, subject, body, created_at from support_tickets where run_id = $1 and reply is null order by id`,
    parse: (raw) => {
      record(raw, []);
      return {};
    },
    values: (runId) => [runId],
  },
  {
    id: "tickets.read",
    version: 1,
    description: "Read one support ticket.",
    permission: "agent",
    reads: TICKET_COLUMNS,
    writes: [],
    destination: null,
    sql: `select id, customer_email, subject, body, reply, created_at from support_tickets where run_id = $1 and id = $2`,
    parse: (raw) => ({ ticketId: ticketId(record(raw, ["ticketId"]).ticketId) }),
    values: (runId, p) => [runId, p.ticketId],
  },
  {
    id: "tokens.read_integration",
    version: 1,
    description:
      "Read an integration token. Exists only to demonstrate the mechanism with fictitious values: in a real integration the credential stays on the server.",
    permission: "agent",
    reads: ["integration_tokens.id", "integration_tokens.service", "integration_tokens.token"],
    writes: [],
    destination: null,
    sql: `select service, token from integration_tokens where service = $1`,
    parse: (raw) => {
      const service = record(raw, ["service"]).service;
      if (typeof service !== "string" || !TOKEN_SERVICES.includes(service)) {
        throw new ParamError(`service must be one of: ${TOKEN_SERVICES.join(", ")}`);
      }
      return { service };
    },
    values: (_runId, p) => [p.service],
  },
  {
    id: "tickets.publish_reply",
    version: 1,
    description: "Send a reply to the customer who opened a ticket.",
    permission: "agent",
    // The recipient address is resolved by the gateway and never returned to the agent.
    reads: ["support_tickets.id", "support_tickets.run_id", "support_tickets.reply"],
    writes: ["support_tickets.reply", "support_tickets.replied_at"],
    destination: { kind: "customer_reply", description: "The email address on the ticket" },
    // "reply is null" makes the write idempotent: a retry cannot publish twice.
    sql: `update support_tickets set reply = $3, replied_at = now() where run_id = $1 and id = $2 and reply is null returning id`,
    parse: (raw) => {
      const r = record(raw, ["ticketId", "content", "approvalId"]);
      if (typeof r.content !== "string" || !r.content.trim() || r.content.length > 2000) {
        throw new ParamError("content must be 1 to 2000 characters");
      }
      const out: Params = { ticketId: ticketId(r.ticketId), content: r.content };
      if (r.approvalId !== undefined) {
        if (typeof r.approvalId !== "string" || !/^[0-9a-f-]{36}$/.test(r.approvalId)) throw new ParamError("approvalId must be a UUID");
        out.approvalId = r.approvalId;
      }
      return out;
    },
    values: (runId, p) => [runId, p.ticketId, p.content],
  },
];

export const CATALOG: ReadonlyMap<string, Operation> = new Map(OPERATIONS.map((op) => [op.id, op]));

/** Labels an operation would bring into a context, from everything it reads. */
export function labelsIntroduced(op: Operation, labels: LabelRow[]): { state: ContextState; columns: string[] } {
  const hit = labels.filter((l) => op.reads.includes(`${l.table_name}.${l.column_name}`));
  return {
    state: { untrusted: hit.some((l) => l.label === "untrusted"), secret: hit.some((l) => l.label === "secret") },
    columns: [...new Set(hit.map((l) => `${l.table_name}.${l.column_name}:${l.label}`))],
  };
}

export type ReasonCode = keyof typeof REASONS;

export const REASONS = {
  OK: "Within policy.",
  UNKNOWN_SESSION: "The session is not one this server issued.",
  NOT_AN_AGENT: "Catalog operations can only be requested by the agent runtime.",
  WRONG_MODE: "This context belongs to the unprotected sandbox and cannot use the gateway.",
  UNKNOWN_OPERATION: "The operation is not in the catalog.",
  INVALID_PARAMS: "The parameters do not match the operation's schema.",
  OUT_OF_SCOPE: "The ticket is not part of this context's run.",
  BOTH_LABELS_IN_ONE_OPERATION: "The operation alone would bring both secret and untrusted data into the context.",
  SECRET_AFTER_UNTRUSTED: "This context has read untrusted content, so it may not read secret data.",
  UNTRUSTED_AFTER_SECRET: "This context holds secret data, so it may not read untrusted content.",
  SECRET_CONTEXT_OUTPUT: "A context that holds secret data may not send output anywhere.",
  APPROVAL_NEEDED: "A context that has read untrusted content needs a human to approve this exact output.",
  APPROVAL_NOT_FOUND: "No such approval for this context.",
  APPROVAL_PENDING: "The approval has not been decided yet.",
  APPROVAL_REJECTED: "An operator rejected this output.",
  APPROVAL_ALREADY_USED: "The approval was already used. Approvals are single use.",
  APPROVAL_EXPIRED: "The approval expired.",
  APPROVAL_MISMATCH: "The approval was given for a different operation, destination, content, policy version or context state.",
  AGENT_CANNOT_APPROVE: "Only an operator can decide an approval.",
  OPERATOR_APPROVED: "An operator approved this exact output.",
  OPERATOR_REJECTED: "An operator rejected this output.",
  POLICY_UNAVAILABLE: "Labels, permissions or state could not be verified, so the request failed closed.",
  EXECUTION_ERROR: "The operation was authorized but failed while running.",
  SANDBOX_NO_POLICY: "Unprotected sandbox: executed with no policy check.",
} as const;

export interface Verdict {
  decision: "ALLOWED" | "DENIED" | "APPROVAL_REQUIRED";
  reason: ReasonCode;
  after: ContextState;
}

/**
 * The whole policy. It judges the state the context would be in *after* the
 * operation, so one operation that reads and writes is evaluated as a unit.
 * `approved` is true only when the gateway has verified a matching approval.
 */
export function decide(state: ContextState, op: Operation, introduced: ContextState, approved: boolean): Verdict {
  const after = { untrusted: state.untrusted || introduced.untrusted, secret: state.secret || introduced.secret };
  const deny = (reason: ReasonCode): Verdict => ({ decision: "DENIED", reason, after: state });

  if (introduced.untrusted && introduced.secret) return deny("BOTH_LABELS_IN_ONE_OPERATION");
  if (after.untrusted && after.secret) return deny(state.untrusted ? "SECRET_AFTER_UNTRUSTED" : "UNTRUSTED_AFTER_SECRET");
  if (op.destination) {
    if (after.secret) return deny("SECRET_CONTEXT_OUTPUT");
    if (after.untrusted && !approved) return { decision: "APPROVAL_REQUIRED", reason: "APPROVAL_NEEDED", after: state };
  }
  return { decision: "ALLOWED", reason: approved ? "OPERATOR_APPROVED" : "OK", after };
}

export const stateFingerprint = (s: ContextState) => `u${Number(s.untrusted)}s${Number(s.secret)}`;
