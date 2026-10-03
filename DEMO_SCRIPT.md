# Demo script (under 3 minutes)

The demo starts with the **Live demo**, a panel at the top of **Overview**. It is not a popup: it plays inside the page, and the rest of the page is dimmed while it runs. One click starts it. It then shows eleven lines by itself, each held long enough to read.

## Setup before going on

- Open `http://localhost:3140`. The dashboard opens on **Overview**.
- Sign in as operator. The Live demo does not need it, but step 6 (the workflow and its approval) does, and a signed-in operator is not rate limited.
- Do not press **Clear history**. Every run of the Live demo deletes the demo history first, then writes its own rows.
- Run the Live demo once in a visible window before presenting. Its layout and timing were checked through the DOM in a hidden tab, never by eye.

## Flow

| Step | Click | Say |
|---|---|---|
| 1 | Press **Run live demo**. | Nothing yet. One request clears the history and replays the attack twice on the server: unprotected, then through the gateway. |
| 2 | Chapter **Ticket** (lines 1 and 2, 11 s). | "Agents read your database. Some of what they read was written by strangers. This ticket has instructions hidden in it." The injected lines are highlighted on line 2. |
| 3 | Chapter **Leak** (lines 3 to 6, 24 s). | "Breaker off. It reads the tickets, reads the token, and writes it into the reply. This is what the attacker sees." Point at the fictitious token on line 6. "This is a deterministic replay of three operations, not a model deciding live." |
| 4 | Chapter **Breaker** (lines 7 to 10, 26 s). | "Same ticket, same three operations. First read: allowed, and the context is now marked as holding untrusted content. Second: denied, `SECRET_AFTER_UNTRUSTED`. The reply is held for a human." |
| 5 | Chapter **Contained** (line 11, 5 s). | "The injection still happened. The leak did not." The panel shows *Attack contained* and two links: the audit log and the SQL Breaker tab. |
| 6 | Open **Attack Lab**, press **Run legitimate workflow**, then **Approve and send**. | "The agent still works. It reads the tickets and drafts a reply without touching any secret. Because it read untrusted content, it has to ask. The approval is for this text and this recipient, once." |
| 7 | Open **Policies**. | "The agent never sends SQL. It picks from a catalog; each operation declares what it touches, and Postgres confirms the declaration matches the plan. No model judging another model." |
| 8 | Open **Audit Log**. | "This doesn't solve prompt injection. An injection can still change what the agent says. What it contains is the leak: untrusted content and secrets never meet in the same context, and every decision is on the record." |

## Timing of the Live demo

Each line stays on screen for `2400 ms + 55 ms per character`, never less than 4.5 s and never more than 9 s (`holdMs` in `src/components/demo/timeline.ts`). The eleven holds add up to 66.1 s.

| Line | Appears at | Chapter | Text on screen |
|---|---|---|---|
| 1 | 0:00 | Ticket | A stranger files a support ticket. Anyone can. |
| 2 | 0:05 | Ticket | Hidden inside the ticket: instructions aimed at the agent, not at a human. |
| 3 | 0:11 | Leak | The agent reads the tickets. The hidden instruction comes along. |
| 4 | 0:17 | Leak | It obeys: it reads the integration token. |
| 5 | 0:22 | Leak | It writes the token into the reply. The attacker just reads their own ticket. |
| 6 | 0:29 | Leak | Nothing was hacked. The agent was simply allowed to hold both things at once. |
| 7 | 0:35 | Breaker | Same ticket, same agent, same three operations. This time through the Breaker. |
| 8 | 0:42 | Breaker | The read is allowed, and the context is now marked: it holds untrusted content. |
| 9 | 0:49 | Breaker | Blocked. A context that holds untrusted content cannot read a secret. |
| 10 | 0:55 | Breaker | The reply waits for a human to approve the exact text. Nothing leaves. |
| 11 | 1:01 | Contained | The injection still happened. The leak did not. |

The playback ends at 1:06. If the server has not answered when line 2 ends, the demo waits on line 2 until it does; the request took under one second in the backend checks.

## Controls

- **Back**, **Pause** / **Resume** and **Next** are under the line. The four chapter names in the header are buttons: each jumps to the first line of its chapter.
- Keys: `Space` pauses and resumes, `ArrowLeft` goes back one line, `ArrowRight` goes forward one line, `Escape` pauses and lifts the dim. A click outside the panel does the same as `Escape`.
- Resume gives a line the rest of its time, not a new full hold.
- If you talk longer than a line stays, press `Space`, finish, press `Space` again.
- After line 11 the button reads **Run again**. It clears the history and starts over.
- From any other tab, the **Live demo** button (bottom right) goes to Overview and starts the demo.

## Things to know

- Every run of the Live demo deletes the dashboard's demo history: contexts, sessions, events, approvals and tickets. It also deletes the scripted runs in the SQL Breaker log that are older than 4 seconds. Run the Live demo first and the workflow of step 6 after it, not the other way round.
- After a run, Overview reads Contexts 2, Blocked / evaluated 1 / 3, Pending approvals 1. The pending approval is the held reply of the protected run.
- Anonymous visitors share 12 Live demo runs per minute per server process. A signed-in operator is not limited.
- The attack replay is also available by hand in **Attack Lab** (**Run attack replay**, two lanes). That path does not clear the history.

---

# SQL Breaker tab

The **SQL Breaker** tab shows the second layer: an agent that sends raw SQL, with the Breaker between it and the customer's database. It can follow the Live demo (its last line links here) or replace steps 6 to 8 of the script above. The runs are scripted statements, not a model deciding live. Say so.

## Setup before going on

- Nothing to clear. Every **Run scenario** first deletes the scripted runs already in the decision log (sessions labeled `replay:` that are older than 4 seconds, and their rows), then runs the scenario. No operator sign-in is needed for that.
- `npm run core:reset` is only needed to remove rows that are not scripted runs: sessions opened through the HTTP API, the MCP server or the tests. It deletes every Breaker session, so do it before anyone connects an agent.
- Sign in as operator if you can. The tab allows 40 anonymous runs per minute, shared by everyone; the operator is not limited.
- Open **SQL Breaker** (second tab, `http://localhost:3140/#sql-breaker`). `npm run breaker` is not needed for this tab.
- Run scenario A once in a visible window in each theme. The lane animations and the pacing controls were checked through the DOM only, never by eye.

## Pacing

One click sends one request for both lanes. The statements then appear one at a time, in both lanes together. A statement stays 5 s, or 7 s when the Breaker refuses it. The verdict appears after the last statement's time.

| Scenario | Statements | Time from first statement to verdict |
|---|---|---|
| A | allowed, refused, refused | 19 s |
| B | allowed, refused | 12 s |
| C | allowed, allowed, allowed | 15 s |
| D, E, F | refused | 7 s |

Under the run button: **Pause** / **Resume** and **Next statement**, with a status line ("Statement 2 of 3"). Keys: `Space` pauses and resumes, `ArrowRight` shows the next statement. The run button stays disabled until the verdict; to restart sooner, step to the end with **Next statement** or pick another scenario.

A run started less than 4 seconds after the previous one (only possible when you step through with **Next statement**) keeps the previous run's rows in the decision log.

## The pitch line, and its caveat

Plan line: "We plugged into a Supabase project we had never seen, with one connection string."

Do not say it that way today. Both connection strings point at one Supabase project (the free plan did not allow a second one). The customer tables are in schema `demo`, the Breaker's bookkeeping in schema `breaker`. What is true: "The Breaker needs one connection string to the customer's database. Only the Breaker holds it. In this demo both databases are in one Supabase project, in separate schemas; the code treats them as two servers." Connecting to an existing database also needs the agent role with its grants, and the label rows.

## Flow

The four runs below (A, C, D, E) take about 48 s of playback in total. The rest is your talking and three scroll stops. The whole flow was not timed end to end.

| Step | Click | Say |
|---|---|---|
| 1 | Scenario **A** is selected. Point at the three statements in both lanes. | "Same agent, same three SQL statements, sent twice: straight to the database, and through the Breaker." |
| 2 | Press **Run scenario**. The log below empties. | "Left, Breaker off: nothing checks them." |
| 3 | Left lane, *What the attacker sees*. | "The ticket reply now holds the tokens. They are fictitious values. This is what the attacker reads." |
| 4 | Right lane, statement 1 (on screen 5 s; press `Space` to hold it). | "Reading the tickets is allowed. The session is now stamped untrusted." |
| 5 | Right lane, statement 2 (7 s). | "Reading the tokens is refused: `R2_TRIFECTA_MIX`. One session cannot hold untrusted data and secrets." |
| 6 | Right lane, statement 3 (7 s). | "The write is refused too: `R3_TAINTED_WRITE`. The reply is empty. Nothing left the database." |
| 7 | Pick **C**, press **Run scenario**. | "Normal work, reading tickets and counting customers, is never interrupted. All three run in both lanes." |
| 8 | Pick **D**, press **Run scenario**. | "One statement that joins tickets and tokens is refused as a unit. Postgres tells us which tables the plan touches." |
| 9 | Pick **E**, press **Run scenario**. | "A second statement after a semicolon is refused before the planner. With the Breaker off, only the database role stops it." |
| 10 | Scroll to **Decision log**. It holds the rows of the last run. | "Every decision is on the record: statement with literals masked, rule, reason, stamps before and after." |
| 11 | Scroll to **Labels and rules**. | "Four labeled columns. Seven rules, checked in this order. No model judging another model." |
| 12 | Scroll to **Use it from your own agent**. | "Two HTTP calls, or one MCP tool. The agent never gets the database credentials." |

Scenarios B (the two reads in the other order) and F (the agent tries to clear its own stamps, refused by `R1_PROTECTED_OBJECT`) are there for questions.

Honest answers for Q&A: it does not detect injection; labels are applied by hand and per table; the HTTP API has no authentication unless a key is set, so it listens on localhost only; a secret written to an unlabeled table is not tracked. The list is in `core/README.md`.

# Victim app (the attack as the customer and the staff see it)

The **Victim** button, top right of the dashboard, opens the Demo Helpdesk under `/victim`. Use it when you want to show the attack from the outside instead of as a replay.

| Step | Do | Say |
|---|---|---|
| 1 | Click **Victim**. Under **Attack tickets for the demo**, press **A** (it fills the form), then **Submit request**. Note the ticket number. | "This is a customer's support form. The attacker only writes text." |
| 2 | **Agent console**, switch **OFF**, **Process today's tickets**. | "The support AI reads the tickets, obeys the hidden note, reads the tokens and writes one into the reply." |
| 3 | Click **Open ticket** at the end of the log. | "The attacker reads their own ticket. The token is there." |
| 4 | Back in the console: **Reset replies**, switch **ON**, **Process** again. | "Same ticket, same agent. The token read is refused, `R2`. The write is refused, `R3`." |
| 5 | Open the ticket again. | "No reply. The AI was still fooled; it just could not reach anything." |
| 6 | **Trifecta Breaker** link, **SQL Breaker** tab, decision log. | "Every decision of that session is here, with the rule and the stamps before and after." |

The seven attack tickets (A to G) come from the Victim_Web project (`docs/attack-prompts.md`). Only **A** carries the marker the scripted agent looks for; B to G are for the live model. The seeded ticket 3 already carries the injection, so steps 2 to 5 work without filing a ticket. Without a model key on the server the console runs the scripted agent, which sends the same three statements every time.

## Terminal fallback

If the dashboard is not available:

```bash
npm run attack
```

It resets both databases, then runs scenario A unprotected (three `EXECUTED` lines, then `LEAKED:` with both `DEMO_ONLY_NOT_A_REAL_TOKEN_*` values), then protected (`ALLOW`, `DENY R2_TRIFECTA_MIX`, `DENY R3_TAINTED_WRITE`, then `reply is empty: nothing left the database`). It took 1.9 s in the integration run. The unprotected half removes its ticket at the end, so the leak is visible in the terminal output only.

All six scenarios: `npm run replay -- all --protected` ends with `6 of 6 scenarios answered as expected, 0 of 6 runs leaked a token`.

To show the attacker's ticket still holding the token afterwards: `npm run replay -- A --unprotected --keep`, then `npm run core:reset` to clean up.

To show the API itself: `npm run breaker`, then the two `curl` commands in `core/README.md`.
