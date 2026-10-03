# Threat model

## What it protects

Data exfiltration through an agent that has been steered by untrusted content it read from the database. Concretely: an agent reads a ticket containing instructions, then tries to read a secret and send it somewhere the attacker can see.

The gateway enforces, on the server:

- A context cannot hold `secret` and `untrusted` data together, in either order, in one operation or across many, including concurrent requests.
- A context that read untrusted content cannot send output without an operator approving that exact text for that exact recipient.
- A context that holds a secret cannot send output at all.
- Only catalog operations run, with validated parameters, as a role that cannot touch policy, audit or approvals.

## What it does not protect

- **What the agent says.** Injected text can still change the agent's summary or the reply it drafts. The control for that is the human approval, and a human can approve something harmful.
- **Mislabeled or unlabeled data.** A secret column with no label is not a secret to the policy. Labels are maintained by hand.
- **A wrong catalog entry.** If an operation's declared reads omit a column its statement touches, the policy is blind to it. The `EXPLAIN` plan check and its test catch the cases Postgres can see; they do not replace review.
- **Covert channels inside allowed operations**, such as encoding data in which tickets get read, or in timing.
- **Harm that is not exfiltration**: wrong replies, denial of service, wasted approvals.

## Trusted components

- The server runtime, the catalog and policy code, and the Postgres database.
- The operator and the operator's browser session.
- The demo runtime that launches replays.

The agent is untrusted. It holds only a session id. It has no access to the operator's cookie, to the operating system, or to any tool that reaches the database around the gateway.

## Assumptions about agent memory and continuity

- Labels attach to the **context**, not the session. New sessions, reconnects and sub-runs on the same context inherit them, and nothing clears them.
- Only the operator side can open a context. The agent cannot mint itself a clean one.
- **Out of scope:** an agent runtime that keeps memory *outside* the context (a scratchpad, a vector store, another process) and carries what it read into a different context. The gateway cannot see that. Whoever runs the agent must bind its memory to the same context.

## External paths not covered

Anything that does not go through `guardedExecute`: other tools the agent has (web requests, email, file access), other database credentials, direct access to Supabase APIs with a privileged key, logs or traces from the model provider.

## Residual risks and pending controls

- Shared operator passcode; no per-operator identity, no second approver.
- The application's database login is over-privileged (owner). Pending: a dedicated login role with only what the gateway needs.
- Approvals are bound to content by SHA-256 and expire after 10 minutes; there is no review of *why* the agent asked.
- Public replay endpoints are rate limited globally, not per client.
- Session ids are unguessable UUIDs but are bearer handles; a real deployment would bind them to an authenticated agent identity.
- No automated labeling, no multi-tenancy.
