# Trifecta Breaker

**Agent access, without blind trust.** Enforce data-access boundaries, control sensitive actions, and explain every decision.

Supabase Select 2026 Hackathon prototype. It is a demonstration of a containment mechanism on synthetic data, not a production security product and not a general fix for prompt injection.

## The idea

An agent that reads support tickets can mistake text inside a ticket for instructions. Trifecta Breaker does not try to classify that text. It controls what the agent can do *after* reading it: one session (or context) may never hold `untrusted` data and `secret` data together.

## Two layers

The repository has two independent implementations of that rule, for two kinds of agent. They share the dashboard and nothing else: separate code, separate tables, separate tests.

| | SQL Breaker (`core/`) | Operation catalog (`src/lib/`) |
|---|---|---|
| For | Agents that send raw SQL | Production flows with a known set of operations |
| Entry point | `guardedExecute(sessionId, sql)` in `core/src/breaker.ts` | `guardedExecute(authContext, operationId, params)` in `src/lib/gateway.ts` |
| What the agent sends | One SQL statement | An operation id from a fixed server-side catalog, with parameters. Never SQL. |
| How it knows what a request touches | Asks Postgres: `EXPLAIN` on the customer's database, then matches the plan's tables against column labels | Each catalog entry declares what it reads, writes and outputs |
| Labels accumulate on | A session (one per agent conversation) | A context (the root of an agent run) |
| After untrusted content was read | Writes are refused (`R3_TAINTED_WRITE`) | Output needs a human approval bound to the exact text and recipient |
| Reachable over | Its own HTTP API (`POST /sessions`, `POST /execute`), an MCP server, or a function call | The dashboard's operator routes |
| Databases | Customer DB (the data) and Breaker DB (`breaker.*`) | The dashboard database (`tb_*` tables) |
| Dashboard tab | **SQL Breaker** | **Overview** (the Live demo), **Attack Lab**, **Sessions**, **Policies**, **Audit Log** |
| Docs | `core/README.md`, `core/INTEGRATION.md` | This file |

### SQL Breaker

The Breaker sits between an agent and the customer's database. Only the Breaker holds the customer's connection string. Every statement is analyzed with `EXPLAIN`, judged by a pure policy function, logged, and only then run, as a least-privilege database role. Rules, scenarios, setup and limitations are in `core/README.md`. The request and response format for another app is in `core/INTEGRATION.md`.

The **SQL Breaker** tab replays six scripted scenarios (A to F). Pick one and press **Run scenario**. The same statements go down two lanes: *Breaker off* (straight to the customer's database) and *Breaker on* (through the checkpoint). Each lane shows what the attacker would see in the ticket reply. Below the lanes: the decision log, the labeled columns, the rules in the order they are checked, and three snippets for calling the Breaker from another agent.

One click sends one request, `POST /api/breaker/demo { scenario }`. The server first deletes the earlier scripted runs from the decision log, then runs the scenario in both modes. The statements then appear one at a time in both lanes: 5 s each, 7 s when the Breaker refuses one, with **Pause** / **Resume** and **Next statement** under the run button (`Space` and `ArrowRight`). The tab never sends SQL from the browser: the route takes a scenario id and nothing else. No operator sign-in is needed.

### Operation catalog

- The agent never sends SQL. It asks for an **operation from a fixed server-side catalog** (`guardedExecute(authContext, operationId, params)`).
- Each operation declares what it reads, what it writes and where its output goes. Columns carry labels (`untrusted`, `secret`; a column may have both).
- Labels accumulate on a **context** (the root of an agent run). A context may never hold `secret` and `untrusted` together. The gateway judges the state the context would be in *after* the operation.
- Output from a context that read untrusted content needs a **human approval** bound to the exact text and recipient. Output from a context that holds a secret is refused.
- Every decision is written to an audit table and streamed to the dashboard with Supabase Realtime.

### Live demo

The **Live demo** is a panel at the top of **Overview**, inside the page. One click on **Run live demo** sends one request, `POST /api/demo/run`. The server deletes the demo history, then replays the same attack twice through the operation catalog layer: first in the unprotected sandbox, then through the gateway. The panel then plays eleven lines by itself, in four chapters (Ticket, Leak, Breaker, Contained). Each line stays between 4.5 and 9 s depending on its length; the whole playback takes 66 s. **Back**, **Pause** / **Resume** and **Next** are under the line, and the keys `Space`, `ArrowLeft`, `ArrowRight` and `Escape` do the same. Every result on screen is a row that request wrote. No operator sign-in is needed. From any other tab, a **Live demo** button goes to Overview and starts it. The presenter's script is in `DEMO_SCRIPT.md`.

### Victim app

The **Victim** button at the top right of the dashboard opens the Demo Helpdesk: a fictional, deliberately vulnerable support app built by a teammate (repository `JustinFutureBillionaire/Victim_Web`) and embedded here under `/victim` with its own look. It is the target of the attack, not part of the product.

- `/victim`: the public form. Anyone files a ticket; the attacker hides an instruction for the AI in the message.
- `/victim/admin`: the staff console. A Breaker ON/OFF switch, **Process today's tickets** and an action log of every SQL statement the support AI sends.
- `/victim/ticket/<id>`: the reply as the customer sees it. This is where the attacker reads the leaked token.

With the Breaker off, the agent's SQL reaches the customer's tables unchecked and the fictitious token lands in the reply. With it on, every statement goes through `guardedExecute`: the token read is refused (`R2`) and so is the write (`R3`). Those sessions also appear in the decision log of the **SQL Breaker** tab.

Where it differs from the original project: it uses this project's customer tables and calls the Breaker in process instead of over HTTP; with the Breaker off each statement still runs one at a time as the least-privilege role, not as the database owner; without `ANTHROPIC_API_KEY` on the server only the scripted agent runs (the live model path is ported and was not exercised here), and the live model with the Breaker off also needs `VICTIM_UNSAFE_LIVE_OFF=1`, which is for a local demo only (see `THREAT_MODEL.md`).

## Architecture

Operation catalog and dashboard:

```
dashboard (Next.js, React)  ──  /api/state (read)        Supabase Realtime on tb_events
        │ operator cookie
        ▼
/api/runs/*  /api/approvals/*          /api/sandbox/attack
        │                                      │
   agent runtime (deterministic)          sandbox executor (no policy,
        │  session id only                 sandbox contexts only)
        ▼
guardedExecute ── policy.ts (catalog + decide) ── Postgres transaction
        │            row lock on tb_contexts, audit, approvals
        ▼
fixed parameterized statement, run as role tb_executor (no access to tb_* tables)
```

`POST /api/demo/run` (the Live demo, public, no body) clears the demo history and then calls both paths of this diagram on the server: the sandbox executor first, then the agent runtime through `guardedExecute`.

SQL Breaker:

```
agent ── POST /execute {sessionId, sql} ──▶ Breaker API (core/src/server.ts, port 3150)
agent ── MCP tool execute_sql ── HTTP ────▶        │
dashboard tab ── /api/breaker/demo {scenario} ──────┤ (scripted SQL only; clears earlier
                 /api/breaker/run {scenario, mode}  │  replay rows, then runs both modes)
                                                    ▼
                                    guardedExecute (core/src/breaker.ts)
                                      │ analyzer.ts: pre-check, EXPLAIN, plan walk
                                      │ policy.ts:   decide(stamps, facts)
                     ┌────────────────┴─────────────────┐
                     ▼                                  ▼
        Breaker DB (control pool)            Customer DB (as role breaker_agent)
        breaker.column_labels                support_tickets
        breaker.sessions (stamps, row lock)  integration_tokens
        breaker.events (decision log)        customers
```

| File | Role |
|---|---|
| `src/lib/policy.ts` | Policy version, operation catalog, `decide()`. Pure; the dashboard imports it to explain restrictions. |
| `src/lib/gateway.ts` | `guardedExecute`, contexts, sessions, approvals, audit. |
| `src/lib/sandbox.ts` | The unprotected executor. Separate code path; refuses non-sandbox contexts. |
| `src/lib/runs.ts` | The two demo runs: attack replay and legitimate workflow. |
| `src/lib/demo-api.ts`, `src/app/api/demo/run/` | `POST /api/demo/run`: clears the demo history and runs the attack replay unprotected, then protected. Answers `{ off, on }`. |
| `src/components/LiveDemo.tsx`, `src/components/demo/` | The Live demo panel on Overview and its timeline (the eleven lines and how long each stays). |
| `src/lib/explain.ts` | Diagnostic only: plans each catalog statement with `EXPLAIN` and compares the columns with the declaration. |
| `src/lib/operator.ts` | Operator sign-in cookie, Origin/Host check. |
| `supabase/schema.sql` | Tables, RLS, executor role, Realtime, seed. **Drops and recreates the demo tables.** |
| `tests/gateway.test.ts` | 24 tests against the real database. |
| `core/src/breaker.ts` | SQL Breaker: `guardedExecute(sessionId, sql)`, the session lock, the decision log, admission limits. |
| `core/src/analyzer.ts` | Pre-check, `EXPLAIN` on the Customer DB, plan walk, function allowlist. |
| `core/src/policy.ts` | SQL Breaker rules `R0` to `R6`, `decide()`. Pure. Not the same file as `src/lib/policy.ts`. |
| `core/src/db.ts` | The two pools (`control`, `customer`) and `asAgent()`, which runs SQL as role `breaker_agent`. |
| `core/src/labels.ts`, `session.ts`, `mask.ts` | Label cache, session stamps, literal masking for the log. |
| `core/src/http.ts`, `server.ts` | The Breaker HTTP API: `POST /sessions`, `POST /execute`, `GET /health`. |
| `core/src/mcp.ts` | The Breaker as a stdio MCP server (tool `execute_sql`). Talks to the HTTP API only. |
| `core/src/scenarios.ts`, `runner.ts`, `replay.ts` | The six scripted scenarios, the runner, and the CLI. |
| `core/sql/breaker/`, `core/sql/customer/`, `core/sql/apply.ts` | Schema, labels, seed and reset for each database, and the script that applies them. |
| `core/test/` | 179 tests in 8 files against the real databases (`npm run test:core`). |
| `src/lib/breaker-api.ts`, `src/app/api/breaker/` | Dashboard routes for the SQL Breaker tab (`demo`, `run`, `state`, `reset`) and the hosted mirror of the Breaker API (`sessions`, `execute`). |
| `src/components/views/SqlBreaker.tsx`, `src/components/breaker/` | The SQL Breaker tab. |

## Install and run

```bash
npm install
psql "$DATABASE_URL" -f supabase/schema.sql   # demo database only
npm run dev                                   # http://localhost:3140
npm test                                      # needs DATABASE_URL
npm run lint && npm run typecheck && npm run build
```

SQL Breaker commands:

```bash
npm run core:db                    # apply core/sql to both databases (additive, idempotent)
npm run breaker                    # the Breaker HTTP API on http://127.0.0.1:3150
npm run replay -- A --protected    # one scenario in the terminal; also --unprotected, all, --keep
npm run attack                     # reset both databases, then A unprotected, then A protected
npm run core:reset                 # empty the decision log, delete sessions and rehearsal tickets
npm run test:core                  # vitest, 179 tests against the real databases
npm run -s mcp                     # the MCP server on stdio (needs the HTTP API running)
```

`npm run attack` and `npm run core:reset` delete every Breaker session and event. The SQL Breaker tab works without `npm run breaker`: the dashboard calls the core in process.

## Dashboard routes

None of these routes accepts SQL, except the hosted mirror in the last row, which needs the key.

| Route | Who | Does |
|---|---|---|
| `GET /api/state` | Anyone | The dashboard's state, read only. |
| `POST /api/demo/run` | Anyone, 12 per minute | The Live demo. No body. Deletes the demo history (`tb_events`, `tb_approvals`, `tb_sessions`, `tb_contexts`, `support_tickets` of the dashboard database) and the scripted runs older than 4 seconds in the Breaker log, then runs the attack replay in the sandbox and through the gateway. Answers `{ off, on }`, each `{ contextId, events, ticket }`. Errors: 403, 429, 500. |
| `POST /api/sandbox/attack` | Anyone, until 30 contexts were created in the last minute | One attack replay on the unprotected sandbox (Attack Lab). Clears nothing. |
| `POST /api/runs/attack` | Anyone, until 30 contexts were created in the last minute | One attack replay through the gateway (Attack Lab). Clears nothing. |
| `POST /api/runs/workflow` | Operator | The legitimate workflow. |
| `POST /api/approvals/[id]` | Operator | Approve or reject a held output. |
| `POST /api/reset` | Operator | **Clear history**: deletes the demo history of the dashboard database. |
| `POST /api/operator`, `DELETE /api/operator` | Anyone | Operator sign-in with the passcode, and sign-out. |
| `POST /api/breaker/demo` | Anyone, 40 per minute shared with `run` | The SQL Breaker tab. Body `{ scenario }`, `A` to `F`. Deletes the scripted runs older than 4 seconds from the Breaker log, then runs the scenario unprotected and protected. Answers `{ off, on }`. Errors: 400, 403, 413, 429, 500. |
| `POST /api/breaker/run` | Anyone, 40 per minute | One scenario in one mode, body `{ scenario, mode }`. Clears nothing. |
| `GET /api/breaker/state` | Anyone | The decision log, with session ids cut to 8 characters. |
| `POST /api/breaker/reset` | Operator | Empties the Breaker log, deletes every Breaker session and the rehearsal tickets. |
| `POST /api/breaker/sessions`, `POST /api/breaker/execute` | Callers with `BREAKER_API_KEY` | The hosted mirror of the Breaker API. Answers 503 when the key is not set. |
| `POST /api/victim/process` | Anyone, 6 per minute per visitor, 20 in all | The victim app's agent run. Body `{ breakerOn, scripted }`, two booleans. Streams the agent's steps as NDJSON. |
| `POST /api/victim/reset` | Anyone | The victim app's **Reset replies**: clears the reply of every ticket in the customer tables and restores the three seeded tickets. |

The limits of 12 and 40 are counted per server process and do not apply to a signed-in operator. Both demo routes refuse requests without a same-origin `Origin` header (403).

Variables in `.env.local` (never commit values):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (Supabase transaction pooler, port 6543). Server only. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key, used by the browser only for the Realtime subscription to `tb_events`. |
| `OPERATOR_PASSCODE` | What the operator types to sign in. |
| `SESSION_SECRET` | Signs the operator cookie. |
| `CUSTOMER_DATABASE_URL` | SQL Breaker: the customer's Postgres (tickets, tokens, customers). Server only. Required by the core. |
| `CUSTOMER_SCHEMA` | SQL Breaker: schema of the customer tables. Default `public`; today `demo`. |
| `BREAKER_DATABASE_URL` | SQL Breaker: the Breaker's own Postgres (`breaker.*`). Falls back to `DATABASE_URL`. |
| `PORT` | Breaker HTTP API port. Default `3150`. |
| `HOST` | Breaker HTTP API bind address. Default `127.0.0.1`. |
| `BREAKER_CORS_ORIGINS` | Extra browser origins allowed to call the Breaker HTTP API, comma separated. `http://localhost:3000` is always allowed. |
| `BREAKER_ALLOWED_HOSTS` | Extra `Host` names the Breaker HTTP API answers to, comma separated, no port. |
| `BREAKER_API_KEY` | Optional. When set, the Breaker HTTP API requires `Authorization: Bearer <key>`, and the hosted mirror routes `/api/breaker/sessions` and `/api/breaker/execute` are enabled for callers that send it. Without it those two routes answer 503. |
| `BREAKER_URL` | Read by clients of the Breaker (the MCP server, the victim app): where the API listens. Default `http://127.0.0.1:3150`. |

## Local mode vs Supabase

There is one runtime: **Supabase Postgres**. The mutual exclusion, state and audit all rely on Postgres transactions and row locks, so there is no in-memory or file-based fallback. Without `DATABASE_URL` the app does not start a degraded "local demo"; it reports that it cannot load.

The SQL Breaker is written for two databases. Today both of its connection strings point at one Supabase project: the customer tables are in schema `demo` and the bookkeeping in schema `breaker`. A second project needs new values in `.env.local` and `npm run core:db`. That move has not been tested.

## Known limits

- Demo database, synthetic data. `tokens.read_integration` exists only to show the mechanism; a real integration would keep the credential on the server and never return it.
- The app connects as the database owner and switches to `tb_executor` only for the catalog statement. Production would use a dedicated login role.
- One operator, one shared passcode, no accounts. Attack replays are public (rate limited); the workflow, approvals and the **Clear history** button need the operator.
- The Live demo (`POST /api/demo/run`) and **Run scenario** (`POST /api/breaker/demo`) are public and delete demo data on every run, by design: the data is synthetic and every run starts clean. Anyone can clear the shared demo board for everyone else. A deployment with real data must not ship these two routes. Details in `THREAT_MODEL.md`.
- The Live demo runs one at a time per server process. With several instances, or with the test suite running against the same database, one run can delete the rows of another that is in flight; that run then answers 500. Not tested under concurrency.
- The catalog has four operations. Real coverage means writing and reviewing an entry per operation.
- The agent in the demo is a deterministic replay. A model-driven agent would use the same gateway; it is not included.
- SQL Breaker: the Breaker HTTP API has no authentication unless `BREAKER_API_KEY` is set. It binds to `127.0.0.1` for that reason.
- SQL Breaker: labels follow columns, not data. A session that holds a secret may write into an unlabeled table, and another session can read it there. The full list is in `core/README.md`.
- SQL Breaker tab: the run limit (40 scenario runs per minute) is counted per server process. It is exact on a single server; a deployment with several instances allows 40 per instance. It is a shared public budget: anonymous visitors can use it up for each other for up to a minute. A signed-in operator is never limited, so the presenter should sign in before the demo.
- SQL Breaker tab: the unprotected lane returns the leaked reply in full to anyone when it consists only of the seed's fictitious `DEMO_ONLY_NOT_A_REAL_TOKEN_*` values. Any other reply is cut to a preview unless the caller is the operator.
- SQL Breaker tab: the same-origin check on its POST routes stops browsers on other sites, not scripts. A non-browser client can send matching `Origin` and `Host` headers. There is no Host allowlist on the dashboard, so DNS rebinding against a locally running dashboard is not covered. Reset and full replies of non-fictitious data also require the signed operator cookie.
- See `THREAT_MODEL.md` for what is and is not covered.
