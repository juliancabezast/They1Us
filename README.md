# Trifecta Breaker

**Agent access, without blind trust.** Enforce data-access boundaries, control sensitive actions, and explain every decision.

Supabase Select 2026 Hackathon prototype. It is a demonstration of a containment mechanism on synthetic data, not a production security product and not a general fix for prompt injection.

## The idea

An agent that reads support tickets can mistake text inside a ticket for instructions. Trifecta Breaker does not try to classify that text. It controls what the agent can do *after* reading it:

- The agent never sends SQL. It asks for an **operation from a fixed server-side catalog** (`guardedExecute(authContext, operationId, params)`).
- Each operation declares what it reads, what it writes and where its output goes. Columns carry labels (`untrusted`, `secret`; a column may have both).
- Labels accumulate on a **context** (the root of an agent run). A context may never hold `secret` and `untrusted` together. The gateway judges the state the context would be in *after* the operation.
- Output from a context that read untrusted content needs a **human approval** bound to the exact text and recipient. Output from a context that holds a secret is refused.
- Every decision is written to an audit table and streamed to the dashboard with Supabase Realtime.

## Architecture

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

## Install and run

```bash
npm install
psql "$DATABASE_URL" -f supabase/schema.sql   # demo database only
npm run dev                                   # http://localhost:3140
npm test                                      # needs DATABASE_URL
npm run lint && npm run typecheck && npm run build
```

Variables in `.env.local` (never commit values):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (Supabase session pooler). Server only. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key, used by the browser only for the Realtime subscription to `tb_events`. |
| `OPERATOR_PASSCODE` | What the operator types to sign in. |
| `SESSION_SECRET` | Signs the operator cookie. |

## Local mode vs Supabase

There is one runtime: **Supabase Postgres**. The mutual exclusion, state and audit all rely on Postgres transactions and row locks, so there is no in-memory or file-based fallback. Without `DATABASE_URL` the app does not start a degraded "local demo"; it reports that it cannot load.

## Known limits

- Demo database, synthetic data. `tokens.read_integration` exists only to show the mechanism; a real integration would keep the credential on the server and never return it.
- The app connects as the database owner and switches to `tb_executor` only for the catalog statement. Production would use a dedicated login role.
- One operator, one shared passcode, no accounts. Attack replays are public (rate limited); the workflow, approvals and clearing history need the operator.
- The catalog has four operations. Real coverage means writing and reviewing an entry per operation.
- The agent in the demo is a deterministic replay. A model-driven agent would use the same gateway; it is not included.
- See `THREAT_MODEL.md` for what is and is not covered.
