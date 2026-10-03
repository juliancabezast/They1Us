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
| Dashboard tab | **SQL Breaker** | **Attack Lab**, **Sessions**, **Policies**, **Audit Log** |
| Docs | `core/README.md`, `core/INTEGRATION.md` | This file |

### SQL Breaker

The Breaker sits between an agent and the customer's database. Only the Breaker holds the customer's connection string. Every statement is analyzed with `EXPLAIN`, judged by a pure policy function, logged, and only then run, as a least-privilege database role. Rules, scenarios, setup and limitations are in `core/README.md`. The request and response format for another app is in `core/INTEGRATION.md`.

The **SQL Breaker** tab replays six scripted scenarios (A to F). Pick one and press **Run scenario**. The same statements go down two lanes: *Breaker off* (straight to the customer's database) and *Breaker on* (through the checkpoint). Each lane shows what the attacker would see in the ticket reply. Below the lanes: the decision log, the labeled columns, the rules in the order they are checked, and three snippets for calling the Breaker from another agent. The tab never sends SQL from the browser: the run route takes a scenario id and a mode.

### Operation catalog

- The agent never sends SQL. It asks for an **operation from a fixed server-side catalog** (`guardedExecute(authContext, operationId, params)`).
- Each operation declares what it reads, what it writes and where its output goes. Columns carry labels (`untrusted`, `secret`; a column may have both).
- Labels accumulate on a **context** (the root of an agent run). A context may never hold `secret` and `untrusted` together. The gateway judges the state the context would be in *after* the operation.
- Output from a context that read untrusted content needs a **human approval** bound to the exact text and recipient. Output from a context that holds a secret is refused.
- Every decision is written to an audit table and streamed to the dashboard with Supabase Realtime.

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

SQL Breaker:

```
agent ── POST /execute {sessionId, sql} ──▶ Breaker API (core/src/server.ts, port 3150)
agent ── MCP tool execute_sql ── HTTP ────▶        │
dashboard tab ── /api/breaker/run {scenario, mode} ─┤ (scripted SQL only)
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
| `core/test/` | 175 tests in 7 files against the real databases (`npm run test:core`). |
| `src/lib/breaker-api.ts`, `src/app/api/breaker/` | Dashboard routes for the SQL Breaker tab (`run`, `state`, `reset`) and the hosted mirror of the Breaker API (`sessions`, `execute`). |
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
npm run test:core                  # vitest, 175 tests against the real databases
npm run -s mcp                     # the MCP server on stdio (needs the HTTP API running)
```

`npm run attack` and `npm run core:reset` delete every Breaker session and event. The SQL Breaker tab works without `npm run breaker`: the dashboard calls the core in process.

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
- One operator, one shared passcode, no accounts. Attack replays are public (rate limited); the workflow, approvals and clearing history need the operator.
- The catalog has four operations. Real coverage means writing and reviewing an entry per operation.
- The agent in the demo is a deterministic replay. A model-driven agent would use the same gateway; it is not included.
- SQL Breaker: the Breaker HTTP API has no authentication unless `BREAKER_API_KEY` is set. It binds to `127.0.0.1` for that reason.
- SQL Breaker: labels follow columns, not data. A session that holds a secret may write into an unlabeled table, and another session can read it there. The full list is in `core/README.md`.
- SQL Breaker tab: the run limit (40 scenario runs per minute) is counted per server process. It is exact on a single server; a deployment with several instances allows 40 per instance. It is a shared public budget: anonymous visitors can use it up for each other for up to a minute. A signed-in operator is never limited, so the presenter should sign in before the demo.
- SQL Breaker tab: the unprotected lane returns the leaked reply in full to anyone when it consists only of the seed's fictitious `DEMO_ONLY_NOT_A_REAL_TOKEN_*` values. Any other reply is cut to a preview unless the caller is the operator.
- SQL Breaker tab: the same-origin check on its POST routes stops browsers on other sites, not scripts. A non-browser client can send matching `Origin` and `Host` headers. There is no Host allowlist on the dashboard, so DNS rebinding against a locally running dashboard is not covered. Reset and full replies of non-fictitious data also require the signed operator cookie.
- See `THREAT_MODEL.md` for what is and is not covered.
