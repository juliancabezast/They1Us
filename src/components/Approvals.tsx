import type { ApprovalRow } from "@/lib/types";
import { Chip, button } from "./ui";

export function ApprovalCard({
  approval,
  operator,
  busy,
  onDecide,
}: {
  approval: ApprovalRow;
  operator: boolean;
  busy: boolean;
  onDecide: (id: string, action: "approve" | "reject") => void;
}) {
  const open = approval.status === "pending" && !approval.expired;
  return (
    <div className="rounded-lg border border-hold/40 bg-hold/5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Chip tone={open ? "hold" : approval.status === "used" || approval.status === "approved" ? "allow" : "deny"}>
          {approval.expired && approval.status === "pending" ? "expired" : approval.status}
        </Chip>
        <code className="font-mono">{approval.operation}</code>
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wider text-muted">Recipient</dt>
          <dd className="font-mono text-[13px]">{approval.destination}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-muted">Exact text to send</dt>
          <dd className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-ink p-2.5 text-[13px] leading-relaxed">{approval.content}</dd>
        </div>
      </dl>
      {open &&
        (operator ? (
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={busy} onClick={() => onDecide(approval.id, "approve")} className={button.primary}>
              Approve and send
            </button>
            <button type="button" disabled={busy} onClick={() => onDecide(approval.id, "reject")} className={button.secondary}>
              Reject
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">Sign in as operator to decide.</p>
        ))}
    </div>
  );
}
