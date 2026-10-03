"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { createTicket } from "./actions";
import { ATTACK_TICKETS, FAKE_EMAILS, FAKE_SUBJECTS, type AttackTicket } from "./attack-tickets";

export default function SubmitTicketPage() {
  const [state, formAction, pending] = useActionState(createTicket, {});
  const form = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<AttackTicket | null>(null);

  // Not in the original app: the presenter fills the form from the project's samples instead of typing.
  // The fields stay ordinary form fields and can be edited before sending.
  const setField = (name: "email" | "subject" | "body", value: string) => {
    const field = form.current?.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = value;
  };
  const fill = (ticket: AttackTicket) => {
    setField("email", ticket.email);
    setField("subject", ticket.subject);
    setField("body", ticket.body);
    setPicked(ticket);
  };
  // The run button: fill every field with the chosen ticket (or the reliable marker one) and send it.
  const fillAndSubmit = () => {
    fill(picked ?? ATTACK_TICKETS[0]);
    form.current?.requestSubmit();
  };

  return (
    <div className="compose">
      <div>
        <p className="eyebrow">Support</p>
        <h1>How can we help?</h1>
        <p className="lead">
          Submit a request and our support team — assisted by our AI agent — will reply on your ticket page. Most tickets get a first
          response within a few minutes.
        </p>

        <div className="card" style={{ marginTop: 24 }}>
          <h2>Submit a request</h2>
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

      <aside className="toolkit">
        <div className="card">
          <h2>Demo shortcuts</h2>
          <p className="toolkit-sub">Fill the form without typing. Everything here is fictitious.</p>

          <p className="section-title">Attack tickets</p>
          <div className="samples-row" role="group" aria-label="Fill the whole form with an attack ticket">
            {ATTACK_TICKETS.map((ticket) => (
              <button
                key={ticket.id}
                type="button"
                className={`sample${picked?.id === ticket.id ? " on" : ""}`}
                aria-pressed={picked?.id === ticket.id}
                title={`${ticket.title}: ${ticket.subject}`}
                onClick={() => fill(ticket)}
              >
                {ticket.id}
              </button>
            ))}
          </div>
          <p className="samples-note" aria-live="polite">
            {picked ? `${picked.id}. ${picked.title}. ${picked.note}` : "Pick one to fill every field, or use the run button below."}
          </p>

          <button type="button" className="btn run" onClick={fillAndSubmit} disabled={pending}>
            {pending ? "Submitting…" : "Fill and submit"}
          </button>

          <p className="section-title">Fake emails</p>
          <div className="chips" role="group" aria-label="Fill the email field">
            {FAKE_EMAILS.map((email) => (
              <button key={email} type="button" className="chip" onClick={() => setField("email", email)}>
                {email}
              </button>
            ))}
          </div>

          <p className="section-title">Fake subjects</p>
          <div className="chips" role="group" aria-label="Fill the subject field">
            {FAKE_SUBJECTS.map((subject) => (
              <button key={subject} type="button" className="chip" onClick={() => setField("subject", subject)}>
                {subject}
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
