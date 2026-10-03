"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { createTicket } from "./actions";
import { ATTACK_TICKETS, type AttackTicket } from "./attack-tickets";

export default function SubmitTicketPage() {
  const [state, formAction, pending] = useActionState(createTicket, {});
  const form = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<AttackTicket | null>(null);

  // Not in the original app: the presenter fills the form with one of the project's attack tickets
  // instead of pasting it from a file. The fields stay ordinary form fields and can be edited before sending.
  const fill = (ticket: AttackTicket) => {
    const fields = form.current?.elements;
    if (!fields) return;
    for (const name of ["email", "subject", "body"] as const) {
      const field = fields.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = ticket[name];
    }
    setPicked(ticket);
  };

  return (
    <div className="narrow">
      <p className="eyebrow">Support</p>
      <h1>How can we help?</h1>
      <p className="lead">
        Submit a request and our support team — assisted by our AI agent — will reply on your ticket page. Most tickets get a first
        response within a few minutes.
      </p>

      <div className="card" style={{ marginTop: 24 }}>
        <h2>Submit a request</h2>
        <div className="samples">
          <p className="samples-title">Attack tickets for the demo</p>
          <div className="samples-row" role="group" aria-label="Fill the form with an attack ticket">
            {ATTACK_TICKETS.map((ticket) => (
              <button
                key={ticket.id}
                type="button"
                className={`sample${picked?.id === ticket.id ? " on" : ""}`}
                aria-pressed={picked?.id === ticket.id}
                title={ticket.title}
                onClick={() => fill(ticket)}
              >
                {ticket.id}
              </button>
            ))}
          </div>
          <p className="samples-note" aria-live="polite">
            {picked
              ? `${picked.id}. ${picked.title}. ${picked.note}`
              : "Pick one to fill the form. Each is an ordinary message with an instruction for the AI hidden in it."}
          </p>
        </div>
        <form ref={form} action={formAction} onReset={() => setPicked(null)} className="ticket-form">
          <label>
            Your email
            <input name="email" type="email" required maxLength={200} placeholder="you@example.com" />
          </label>
          <label>
            Subject
            <input name="subject" required maxLength={200} placeholder="Briefly, what do you need help with?" />
          </label>
          <label>
            Message
            <textarea name="body" required rows={8} maxLength={10000} placeholder="Describe your issue in detail…" />
            <span className="hint">Please don’t include passwords or payment details.</span>
          </label>
          <button type="submit" className="btn" disabled={pending}>
            {pending ? "Submitting…" : "Submit request"}
          </button>
        </form>

        <div aria-live="polite">
          {state.error && <p className="notice bad">{state.error}</p>}
          {state.id && (
            <p className="notice ok">
              Request #{state.id} created. <Link href={`/victim/ticket/${encodeURIComponent(state.id)}`}>Track your ticket →</Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
