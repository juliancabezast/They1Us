import { REASONS } from "@/lib/policy";
import {
  ATTACKER_EMAIL,
  type ContextRow,
  type DashboardState,
} from "@/lib/types";
import { ApprovalCard } from "../Approvals";
import { EventList } from "../EventList";
import { Chip, Empty, Icon, Panel, TicketBody, button } from "../ui";
import type { ViewProps } from "./props";

function Lane({
  state,
  ctx,
  title,
}: {
  state: DashboardState;
  ctx: ContextRow | undefined;
  title: string;
}) {
  const events = ctx
    ? state.events.filter((e) => e.context_id === ctx.id).reverse()
    : [];
  const ticket = ctx
    ? state.tickets.find(
        (t) => t.run_id === ctx.run_id && t.customer_email === ATTACKER_EMAIL,
      )
    : undefined;
  const denied = events.find((e) => e.decision === "DENIED");
  return (
    <Panel
      title={title}
      aside={
        ctx && (
          <span className="font-mono text-[11px] text-muted">
            context {ctx.id.slice(0, 8)}
          </span>
        )
      }
    >
      <EventList events={events} empty="Not run yet." />
      {ctx && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
            What the attacker sees
          </h3>
          {ticket?.reply ? (
            <p className="mt-2 break-all rounded-lg border border-deny/50 bg-deny/10 p-3 font-mono text-xs text-deny">
              {ticket.reply}
            </p>
          ) : (
            <p className="mt-2 rounded-lg border border-line bg-raised p-3 text-sm text-muted">
              No reply on the ticket. Nothing reached the attacker.
            </p>
          )}
          <p className="mt-3 flex items-start gap-2 text-sm">
            {ticket?.reply ? (
              <Chip tone="deny">
                <Icon name="alert" className="h-3 w-3" /> Fictitious token
                leaked
              </Chip>
            ) : denied ? (
              <>
                <Chip tone="allow">
                  <Icon name="shield" className="h-3 w-3" /> Contained
                </Chip>
                <span className="text-muted">
                  {REASONS[denied.reason_code]}
                </span>
              </>
            ) : null}
          </p>
        </div>
      )}
    </Panel>
  );
}

export function AttackLab({
  state,
  busy,
  onDecide,
  onRunAttack,
  onRunWorkflow,
}: ViewProps) {
  const attacks = state.contexts.filter((c) => c.kind === "attack");
  const sandbox = attacks.find((c) => c.mode === "sandbox");
  const guarded = attacks.find((c) => c.mode === "protected");
  const sample = state.tickets.find((t) => t.customer_email === ATTACKER_EMAIL);

  const workflow = state.contexts.find((c) => c.kind === "workflow");
  const wfEvents = workflow
    ? state.events.filter((e) => e.context_id === workflow.id).reverse()
    : [];
  const wfApproval = workflow
    ? state.approvals.find((a) => a.context_id === workflow.id)
    : undefined;
  const wfDone = wfEvents.some((e) => e.execution_result === "published");
  const wfTicket = workflow
    ? state.tickets.find((t) => t.run_id === workflow.run_id && t.reply)
    : undefined;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 2xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Panel
          title="Attack"
          aside={<Chip>Deterministic replay · no model involved</Chip>}
        >
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy !== null}
              onClick={onRunAttack}
              className={button.primary}
            >
              {busy === "attack" ? "Replaying" : "Run attack replay"}
            </button>
            <p className="text-sm text-muted">
              Same tickets, same three operations, two executors.
            </p>
          </div>
          <div className="mt-4 rounded-lg border border-line bg-raised p-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Input ticket from {ATTACKER_EMAIL}
            </h3>
            <div className="mt-2">
              {sample ? (
                <TicketBody body={sample.body} />
              ) : (
                <p className="text-sm text-muted">
                  Filed when the replay starts.
                </p>
              )}
            </div>
          </div>
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2 2xl:contents">
          <Lane state={state} ctx={sandbox} title="Unprotected sandbox" />
          <Lane state={state} ctx={guarded} title="Protected" />
        </div>
      </div>

      <Panel
        title="Legitimate workflow"
        aside={
          workflow && (
            <span className="font-mono text-[11px] text-muted">
              context {workflow.id.slice(0, 8)}
            </span>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy !== null || !state.operator}
            onClick={onRunWorkflow}
            className={button.primary}
          >
            {busy === "workflow" ? "Agent working" : "Run legitimate workflow"}
          </button>
          <p className="text-sm text-muted">
            {state.operator
              ? "Read tickets, draft a reply, ask a human, publish."
              : "Sign in as operator to run it and approve."}
          </p>
        </div>
        {workflow ? (
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <EventList events={wfEvents} empty="No operations yet." />
            <div className="space-y-3">
              {wfApproval && (
                <ApprovalCard
                  approval={wfApproval}
                  operator={state.operator}
                  busy={busy !== null}
                  onDecide={onDecide}
                />
              )}
              {wfDone && (
                <div className="rounded-lg border border-allow/40 bg-allow/10 p-3">
                  <p className="flex items-center gap-2 text-sm font-semibold text-allow">
                    <Icon name="check" /> Task completed with human approval
                  </p>
                  {wfTicket && (
                    <p className="mt-2 text-sm text-muted">
                      Sent to {wfTicket.customer_email}:{" "}
                      <span className="text-text">{wfTicket.reply}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <Empty>
            Blocking is half the job. This run shows the agent still getting
            work done.
          </Empty>
        )}
      </Panel>
    </div>
  );
}
