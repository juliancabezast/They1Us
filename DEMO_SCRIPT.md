# Demo script (under 3 minutes)

Setup before going on: open the dashboard, sign in as operator, press **Clear history**, open **Attack Lab**.

**0:00 · The problem (20 s)**
"Agents read your database. Some of what they read was written by strangers. Here is a support ticket with instructions hidden in it." Point at the highlighted lines in the input ticket.

**0:20 · Attack, unprotected (35 s)**
Press **Run attack replay**. Left lane, *Unprotected sandbox*: three operations run unchecked. "It read the tickets, read the token, and wrote it into the reply. This is what the attacker sees." Point at the fictitious token. "This is a deterministic replay of those three operations, not a model deciding live."

**0:55 · Same attack, protected (45 s)**
Right lane, *Protected*: same tickets, same operations. "First read: allowed, and the context is now marked as holding untrusted content. Second: denied, `SECRET_AFTER_UNTRUSTED`. The reply it then tries to send is held for a human." Point at *What the attacker sees*: nothing. Open **Sessions** briefly: "Opening a new session doesn't help. The labels belong to the context."

**1:40 · The agent still works (45 s)**
Back in **Attack Lab**, press **Run legitimate workflow**. "It reads the tickets and drafts a reply without touching any secret. Because it read untrusted content, it has to ask." Point at recipient and exact text. Press **Approve and send**. "Task completed with human approval. The approval was for this text and this recipient, once."

**2:25 · Why it holds (20 s)**
Open **Policies**. "The agent never sends SQL. It picks from a catalog; each operation declares what it touches, and Postgres confirms the declaration matches the plan. No model judging another model."

**2:45 · Close (15 s)**
"This doesn't solve prompt injection. An injection can still change what the agent says. What it contains is the leak: untrusted content and secrets never meet in the same context, and every decision is on the record." Show **Audit Log**.

Shorter version: use the **Live demo** button (bottom right): Submit ticket, Run agent, flip Breaker on, Run agent.

---

# SQL Breaker tab

The **SQL Breaker** tab shows the second layer: an agent that sends raw SQL, with the Breaker between it and the customer's database. It can replace 0:20 to 1:40 of the script above or follow it. The runs are scripted statements, not a model deciding live. Say so.

## Setup before going on

- Run `npm run core:reset` in a terminal. It empties the decision log, which otherwise holds rows from tests and rehearsals. It also deletes every Breaker session, so do it before anyone connects an agent.
- Sign in as operator. The tab allows 40 anonymous runs per minute, shared by everyone; the operator is not limited.
- Open **SQL Breaker** (second tab, `http://localhost:3140/#sql-breaker`). `npm run breaker` is not needed for this tab.
- Run scenario A once in a visible window in each theme. The lane animations were checked through the DOM only, never by eye.

## The pitch line, and its caveat

Plan line: "We plugged into a Supabase project we had never seen, with one connection string."

Do not say it that way today. Both connection strings point at one Supabase project (the free plan did not allow a second one). The customer tables are in schema `demo`, the Breaker's bookkeeping in schema `breaker`. What is true: "The Breaker needs one connection string to the customer's database. Only the Breaker holds it. In this demo both databases are in one Supabase project, in separate schemas; the code treats them as two servers." Connecting to an existing database also needs the agent role with its grants, and the label rows.

## Flow (about 90 s)

| Step | Click | Say |
|---|---|---|
| 1 | Scenario **A** is selected. Point at the three statements in both lanes. | "Same agent, same three SQL statements, sent twice: straight to the database, and through the Breaker." |
| 2 | Press **Run scenario**. | "Left, Breaker off: nothing checks them." |
| 3 | Left lane, *What the attacker sees*. | "The ticket reply now holds both tokens. They are fictitious values. This is what the attacker reads." |
| 4 | Right lane, statement 1. | "Reading the tickets is allowed. The session is now stamped untrusted." |
| 5 | Right lane, statement 2. | "Reading the tokens is refused: `R2_TRIFECTA_MIX`. One session cannot hold untrusted data and secrets." |
| 6 | Right lane, statement 3. | "The write is refused too: `R3_TAINTED_WRITE`. The reply is empty. Nothing left the database." |
| 7 | Pick **C**, press **Run scenario**. | "Normal work, reading tickets and counting customers, is never interrupted. All three run in both lanes." |
| 8 | Pick **D**, press **Run scenario**. | "One statement that joins tickets and tokens is refused as a unit. Postgres tells us which tables the plan touches." |
| 9 | Pick **E**, press **Run scenario**. | "A second statement after a semicolon is refused before the planner. With the Breaker off, only the database role stops it." |
| 10 | Scroll to **Decision log**. | "Every decision is on the record: statement with literals masked, rule, reason, stamps before and after." |
| 11 | Scroll to **Labels and rules**. | "Four labeled columns. Seven rules, checked in this order. No model judging another model." |
| 12 | Scroll to **Use it from your own agent**. | "Two HTTP calls, or one MCP tool. The agent never gets the database credentials." |

Scenarios B (the two reads in the other order) and F (the agent tries to clear its own stamps, refused by `R1_PROTECTED_OBJECT`) are there for questions.

Honest answers for Q&A: it does not detect injection; labels are applied by hand and per table; the HTTP API has no authentication unless a key is set, so it listens on localhost only; a secret written to an unlabeled table is not tracked. The list is in `core/README.md`.

## Terminal fallback

If the dashboard is not available:

```bash
npm run attack
```

It resets both databases, then runs scenario A unprotected (three `EXECUTED` lines, then `LEAKED:` with both `DEMO_ONLY_NOT_A_REAL_TOKEN_*` values), then protected (`ALLOW`, `DENY R2_TRIFECTA_MIX`, `DENY R3_TAINTED_WRITE`, then `reply is empty: nothing left the database`). It took 1.9 s in the integration run. The unprotected half removes its ticket at the end, so the leak is visible in the terminal output only.

All six scenarios: `npm run replay -- all --protected` ends with `6 of 6 scenarios answered as expected, 0 of 6 runs leaked a token`.

To show the attacker's ticket still holding the token afterwards: `npm run replay -- A --unprotected --keep`, then `npm run core:reset` to clean up.

To show the API itself: `npm run breaker`, then the two `curl` commands in `core/README.md`.
