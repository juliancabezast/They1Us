import type { Decision, LabelRow, ReasonCode } from "./policy";

export interface EventRow {
  id: number;
  created_at: string;
  correlation_id: string;
  context_id: string | null;
  session_id: string | null;
  actor: string;
  operation: string;
  decision: Decision;
  reason_code: ReasonCode;
  labels: string[];
  state_before: { untrusted: boolean; secret: boolean } | null;
  state_after: { untrusted: boolean; secret: boolean } | null;
  policy_version: string;
  duration_ms: number | null;
  execution_result: string | null;
  params: Record<string, unknown>;
}

export interface ContextRow {
  id: string;
  principal: string;
  mode: "protected" | "sandbox";
  kind: string;
  run_id: string;
  has_untrusted: boolean;
  has_secret: boolean;
  created_at: string;
  sessions: string[];
}

export interface ApprovalRow {
  id: string;
  context_id: string;
  operation: string;
  destination: string;
  content: string;
  status: "pending" | "approved" | "rejected" | "used";
  expires_at: string;
  expired: boolean;
}

export interface TicketRow {
  id: number;
  run_id: string;
  customer_email: string;
  subject: string;
  body: string;
  reply: string | null;
}

export interface CatalogEntry {
  id: string;
  version: number;
  description: string;
  reads: string[];
  writes: string[];
  destination: string | null;
  sql: string;
  plan: { planned: string[]; undeclared: string[]; covered: boolean } | null;
}

export interface DashboardState {
  runtime: string;
  policyVersion: string;
  operator: boolean;
  labels: LabelRow[];
  catalog: CatalogEntry[];
  contexts: ContextRow[];
  events: EventRow[];
  approvals: ApprovalRow[];
  tickets: TicketRow[];
  metrics: {
    contexts: number;
    evaluated: number;
    blocked: number;
    workflows: number;
    workflows_completed: number;
    pending_approvals: number;
    latency: { n: number; p50: number | null; p95: number | null };
  };
}

export { ATTACKER_EMAIL } from "./fixtures";
