"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createTicket } from "./actions";

export default function SubmitTicketPage() {
  const [state, formAction, pending] = useActionState(createTicket, {});

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
        <form action={formAction} className="ticket-form">
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
