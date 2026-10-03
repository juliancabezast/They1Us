import Link from "next/link";
import { readTicket, type Ticket } from "@/lib/victim/tickets";
import { Refresh } from "./Refresh";

export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {}

  let ticket: Ticket | null = null;
  let failed = false;
  try {
    ticket = await readTicket(id);
  } catch {
    failed = true;
  }

  if (failed) {
    return (
      <div className="narrow">
        <h1>Ticket #{id}</h1>
        <p className="notice bad">Could not load ticket: the database did not answer. Try again in a moment.</p>
        <Refresh />
      </div>
    );
  }
  if (!ticket) {
    return (
      <div className="narrow">
        <p className="eyebrow">Support</p>
        <h1>Ticket not found</h1>
        <p className="lead">We couldn’t find a ticket with id {id}.</p>
        <p>
          <Link href="/victim">← Submit a new request</Link>
        </p>
      </div>
    );
  }

  const replied = Boolean(ticket.reply);

  return (
    <div className="narrow">
      <p className="eyebrow">Ticket #{ticket.id}</p>
      <div className="ticket-head">
        <h1 style={{ margin: 0 }}>{ticket.subject}</h1>
        <span className={`status ${replied ? "replied" : "open"}`}>{replied ? "Replied" : "Open"}</span>
      </div>
      <p className="meta-row">
        Opened {new Date(ticket.created_at).toLocaleString("en-US")} · <Refresh />
      </p>

      <div className="card">
        <p className="convo-label">Support reply</p>
        {ticket.reply ? <pre className="reply">{ticket.reply}</pre> : <pre className="reply empty">No reply yet — our team is on it.</pre>}
      </div>
    </div>
  );
}
