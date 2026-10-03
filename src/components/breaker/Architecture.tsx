import { Icon } from "../ui";
import { AgentIcon, DatabaseIcon } from "./icons";

const NODE = "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium leading-tight";
const RAIL = "h-px min-w-3 flex-1 bg-line";

/**
 * Who talks to whom, drawn. With the Breaker: agent, checkpoint, customer's database, and the
 * Breaker's own database hanging off the checkpoint. Without it: the agent holds the customer's
 * connection string and goes straight in.
 */
export function Architecture({ guarded }: { guarded: boolean }) {
  return (
    <div
      role="img"
      aria-label={
        guarded
          ? "The AI agent talks to the Breaker checkpoint, and only the Breaker talks to the customer's database. The Breaker keeps its labels, stamps and log in its own database."
          : "The AI agent talks straight to the customer's database. There is no checkpoint, and the agent holds the connection string."
      }
      className="border-b border-line px-3 py-3 sm:px-4"
    >
      {/* Equal side columns keep the checkpoint on the center line, where its database hangs. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
        <div className="flex min-w-0 items-center">
          <span className={`${NODE} border-line bg-raised`}>
            <AgentIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
            AI agent
          </span>
          <span className={RAIL} />
        </div>

        {guarded ? (
          <span className={`${NODE} border-allow/50 bg-allow/10`}>
            <Icon name="shield" className="h-3.5 w-3.5 shrink-0 text-allow" />
            Breaker
          </span>
        ) : (
          <span className="h-px w-10 bg-line" />
        )}

        <div className="flex min-w-0 items-center">
          <span className={RAIL} />
          <span className={`${NODE} border-line bg-raised`}>
            <DatabaseIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
            Customer&apos;s database
          </span>
        </div>
      </div>

      {guarded ? (
        <div className="flex flex-col items-center">
          <span className="h-3 w-px bg-line" />
          <span className={`${NODE} max-w-full border-line bg-raised`}>
            <DatabaseIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0">
              Breaker&apos;s database <span className="font-normal text-muted">labels, stamps, log</span>
            </span>
          </span>
        </div>
      ) : (
        // Same height as the branch in the other lane, so the statements of both lanes stay level.
        <p className="flex min-h-[38px] items-end justify-center text-center text-xs leading-tight text-muted">
          No checkpoint. The agent holds the connection string.
        </p>
      )}
    </div>
  );
}
