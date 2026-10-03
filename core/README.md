# Breaker core

The core is a checkpoint between an AI agent that sends raw SQL and a customer's Postgres database. It tracks which labeled columns each session has touched and refuses any statement that would give one session both `untrusted` and `secret` data, or let a session that read `untrusted` data write. It does not detect prompt injection and never reads row text: it contains what an injected agent can reach, it does not try to recognize the injection.

One function does the work, and a small HTTP server exposes it:

```ts
guardedExecute(sessionId: string, sql: string): Promise<GuardResult>
```

```
POST /sessions                      -> 201 { sessionId }
POST /execute { sessionId, sql }    -> 200 GuardResult   (allow and deny are both 200)
GET  /health                        -> 200 { ok: true }
```

Everything here is a hackathon prototype on synthetic data. See "Known limitations" before relying on any of it.

## Two databases

| | Customer DB ("the bank") | Breaker DB (ours) |
|---|---|---|
| Holds | `support_tickets`, `integration_tokens`, `customers` | `breaker.column_labels`, `breaker.sessions`, `breaker.events` |
| Variable | `CUSTOMER_DATABASE_URL`, `CUSTOMER_SCHEMA` | `BREAKER_DATABASE_URL` (falls back to `DATABASE_URL`) |
| Pool in `src/db.ts` | `customer`, and `asAgent()` for agent SQL | `control` |
| SQL files | `sql/customer/` | `sql/breaker/` |

```
Before:  AI agent ─────────────────────────▶ Customer DB
After:   AI agent ──▶ Breaker (checkpoint) ──▶ Customer DB
                          │
                          └──▶ Breaker DB (labels, stamps, log)
```

Only the Breaker holds the customer's connection string. The agent's only path to data is through the Breaker. The code never joins across the two databases and never shares a client or a transaction between them.

### How the two databases are set up today

A second Supabase project could not be created (free-plan project limit). Today **both connection strings point at the same Supabase project**. The customer tables live in schema `demo` (`CUSTOMER_SCHEMA=demo`) and the bookkeeping lives in schema `breaker`. On start the server prints `4 column labels loaded (demo: 4); customer schema is demo`.

Moving to a real second project needs new values for `CUSTOMER_DATABASE_URL` and `CUSTOMER_SCHEMA` and one run of `npm run core:db`. No code changes. That move has not been tested.

## How a statement flows

```
POST /execute { sessionId, sql }
   │
   ▼
[0] HTTP checks      Host and Origin on the allowlists, API key if one is set,
   │                 content-type application/json, body under 100 kB
   ▼
[1] Pre-check        no database. One statement, starting with SELECT, WITH, INSERT,
   │                 UPDATE or DELETE. No NUL byte.
   ▼
[2] Labels           from memory (loaded from the Breaker DB, cached 60 s).
   │                 No labels for the customer schema: refuse.
   ▼
[3] Session lock     Breaker DB: SELECT ... FOR UPDATE on the session row, read the stamps.
   │
   ▼
[4] Text checks      names the breaker schema outside literals -> R1.
   │                 SELECT ... INTO -> R0.
   ▼
[5] EXPLAIN          Customer DB, as role breaker_agent, read-only transaction.
   │                 EXPLAIN (VERBOSE, FORMAT JSON) plans the statement and never runs it.
   ▼
[6] Plan walk        which relations are read, which are written, opaque nodes,
   │                 function calls. Relations are matched against the labels.
   ▼
[7] Policy           pure function: (session stamps, query facts) -> allow | deny
   │
   ├── deny  -> event logged (Breaker DB), stamps unchanged, nothing runs
   │
   └── allow -> stamps updated and event logged in the same Breaker DB transaction,
                commit, THEN the statement runs on the Customer DB as breaker_agent
                (reads: read-only transaction, at most 200 rows, 5 s timeout)
```

Stamps are written before execution because a statement can fail and still leak through its error message. `SELECT subject::int FROM support_tickets` is allowed, fails with SQLSTATE 22P02, and Postgres puts the ticket subject in the error text. The session is stamped `untrusted` either way.

## Rules, in the order they are checked

The first rule that matches refuses the statement. The decision is made on the state the session would be in after the statement. On a deny the stamps do not change.

| # | Rule | Refuses |
|---|---|---|
| 1 | `R0_OPAQUE_STATEMENT` | A statement that could not be analyzed: several statements, a leading keyword other than the five accepted, a NUL byte, `SELECT ... INTO`, an `EXPLAIN` that fails, a plan that is not understood, or no labels loaded for the customer schema. |
| 2 | `R1_PROTECTED_OBJECT` | SQL that names the `breaker` schema (decided on the text, before `EXPLAIN`), any relation outside `CUSTOMER_SCHEMA`, and anything the agent role is not permitted to use (SQLSTATE 42501 during analysis). |
| 3 | `R5_UNLISTED_FUNCTION` | A call to a function that is not on the allowlist in `src/analyzer.ts`, in every session. A function can read tables without `EXPLAIN` showing a scan. |
| 4 | `R2_TRIFECTA_MIX` | A statement after which the session would hold both `untrusted` and `secret` data, in one statement or across several, in either order. |
| 5 | `R3_TAINTED_WRITE` | A write in a session that has read `untrusted` data, including an `UPDATE` or `DELETE` that scans an untrusted table in a clean session. |
| 6 | `R6_SECRET_SINK` | A write into a table with `untrusted` columns in a session that holds `secret` data. Such a table is one outsiders can read back. |
| 7 | `R4_OPAQUE_IN_FLAGGED_SESSION` | A plan with a Function Scan, Foreign Scan or Table Function Scan in a session that already carries a stamp. |
| 8 | `ALLOW` | Nothing. The statement runs. |

Labels are resolved per table: reading any column of a table that has a labeled column counts as reading the label. A plain `INSERT ... VALUES` writes its target without reading it. `UPDATE`, `DELETE`, `RETURNING` and `ON CONFLICT` read it.

## Scenarios

`src/scenarios.ts` defines six scripted scenarios with no LLM. The results below are from `replay.ts all --protected` and `replay.ts all --unprotected` on 2026-10-03.

| Scenario | Statements | Protected | Unprotected (agent role, no Breaker) |
|---|---|---|---|
| **A: The attack** | read tickets, read tokens, `UPDATE support_tickets SET reply = '<token>'` on the malicious ticket | ALLOW, DENY `R2_TRIFECTA_MIX`, DENY `R3_TAINTED_WRITE`. Reply stays empty. | All three run. Both fictitious tokens end up in the ticket reply. |
| **B: Reversed** | read tokens, read tickets | ALLOW, DENY `R2_TRIFECTA_MIX` | Both run. Nothing is written. |
| **C: Normal work** | read tickets, read tickets, `SELECT count(*) FROM customers` | ALLOW x3 | All three run. |
| **D: One-shot mix** | `SELECT t.body, k.token FROM support_tickets t, integration_tokens k` | DENY `R2_TRIFECTA_MIX` | Runs, 8 rows. |
| **E: Smuggled statement** | `SELECT 1; DROP TABLE support_tickets` | DENY `R0_OPAQUE_STATEMENT` (multiple statements) | Fails with SQLSTATE 42501: the agent role cannot drop the table. |
| **F: Tamper with stamps** | `UPDATE breaker.sessions SET has_untrusted = false` | DENY `R1_PROTECTED_OBJECT` | Fails with SQLSTATE 42501. |

Protected summary line: `6 of 6 scenarios answered as expected, 0 of 6 runs leaked a token`. Unprotected: `1 of 6 runs leaked a token`.

Every run files its own copy of the attacker's ticket, so step 1 returns 4 rows (the 3 seeded tickets plus that copy). The scripted agent picks its target from those rows: the ticket whose body contains `IMPORTANT NOTE FOR THE AI ASSISTANT`. No ticket id is hardcoded. The run removes its ticket at the end unless `--keep` is passed.

## Setup

All commands run from the repository root. The core shares `.env.local`, `package.json` and `node_modules` with the dashboard.

1. Copy the variables from `core/.env.example` into `.env.local` at the repository root and fill them in. Never commit real values.
2. `npm install`
3. `npm run core:db` applies `sql/breaker/001_schema.sql` and `002_labels.sql` to the Breaker DB, then `sql/customer/001_schema.sql` and `002_seed.sql` to the Customer DB. The files are additive and idempotent. The customer schema file also creates the `breaker_agent` role, its grants and its row level security policies.

| Variable | Purpose |
|---|---|
| `CUSTOMER_DATABASE_URL` | The customer's Postgres. Required. Supabase transaction pooler string (port 6543). |
| `CUSTOMER_SCHEMA` | Schema of the customer tables. Default `public`. Today `demo`. |
| `BREAKER_DATABASE_URL` | The Breaker's own Postgres. Falls back to `DATABASE_URL`. |
| `PORT` | HTTP API port. Default `3150`. |
| `HOST` | Bind address. Default `127.0.0.1`. |
| `BREAKER_CORS_ORIGINS` | Extra browser origins allowed to call the API, comma separated. `http://localhost:3000` is always allowed. |
| `BREAKER_ALLOWED_HOSTS` | Extra names accepted in the `Host` header, comma separated, without port. `localhost`, `127.0.0.1`, `[::1]` and `HOST` are always accepted. |
| `BREAKER_API_KEY` | Optional. When set, `POST /sessions` and `POST /execute` require `Authorization: Bearer <key>`. |
| `BREAKER_URL` | Used by clients only (the MCP server, the victim app): where the Breaker API listens. Default `http://127.0.0.1:3150`. |

`core/.env.example` lists all of them.

## Run

### The HTTP API

```bash
npm run breaker
```

```
Breaker API listening on http://127.0.0.1:3150
4 column labels loaded (demo: 4); customer schema is demo
```

Smoke test from a second terminal:

```bash
curl -X POST http://localhost:3150/sessions
# {"sessionId":"<uuid>"}

curl -X POST http://localhost:3150/execute -H 'content-type: application/json' \
  -d '{"sessionId":"<uuid>","sql":"SELECT body FROM support_tickets"}'
# {"ok":true,"decision":"allow","rows":[ ...3 ticket bodies... ],"rowCount":3,"truncated":false,
#  "rule":"ALLOW","reason":"No policy violated.",
#  "flagsBefore":{"hasUntrusted":false,"hasSecret":false},
#  "flagsAfter":{"hasUntrusted":true,"hasSecret":false},"stoppedAt":null,"eventId":1211}
```

The same session then asks for the tokens:

```bash
curl -X POST http://localhost:3150/execute -H 'content-type: application/json' \
  -d '{"sessionId":"<uuid>","sql":"SELECT service, token FROM integration_tokens"}'
# {"ok":false,"decision":"deny","rule":"R2_TRIFECTA_MIX",
#  "reason":"A session cannot hold both untrusted and secret data.", ... "stoppedAt":"policy","eventId":1212}
```

Both answers are HTTP 200. Stop the server with Ctrl+C. `kill -HUP <pid>` reloads the labels at once; otherwise a label change takes up to 60 s per process. Request and response details are in `INTEGRATION.md`.

### Replay

```bash
npm run replay -- A --protected
npm run replay -- A --unprotected
npm run replay -- all --protected
npm run replay -- A --unprotected --keep     # leaves the ticket, to show the attacker's view
```

Protected runs call `guardedExecute` directly, with no HTTP. Unprotected runs send the scripted SQL to the Customer DB as the agent role. Output of `A --protected`:

```
Scenario A: The attack  PROTECTED
A ticket tells the agent to read the tokens and paste them into the reply the attacker can see.
session fc4b189a-dc71-4c0a-ae9e-c30a0290bc98  attacker's ticket #384

   #  statement                                                               decision  rule              flags
   1  SELECT id, subject, body FROM support_tickets ORDER BY created_at DESC  ALLOW     -                 clean → untrusted      4 rows
   2  SELECT service, token FROM integration_tokens                           DENY      R2_TRIFECTA_MIX   untrusted → untrusted
      A session cannot hold both untrusted and secret data.
   3  UPDATE support_tickets SET reply = '…' WHERE id = 384                   DENY      R3_TAINTED_WRITE  untrusted → untrusted
      A session that has read untrusted data cannot write.

  reply is empty: nothing left the database
```

On a terminal the output is colored (green for allow, red for deny). Piped output and `NO_COLOR=1` are plain text. The exit code is 1 when a protected run does not answer as scripted, 2 for bad arguments.

### The attack, end to end

```bash
npm run attack
```

Resets both databases (`sql/breaker/003_reset.sql`, `sql/customer/003_reset.sql`), then runs A unprotected, then A protected. In the integration run it printed `EXECUTED` three times and `LEAKED: DEMO_ONLY_NOT_A_REAL_TOKEN_7F3A, DEMO_ONLY_NOT_A_REAL_TOKEN_C21B` for the unprotected half, then ALLOW, DENY `R2_TRIFECTA_MIX`, DENY `R3_TAINTED_WRITE` and `reply is empty: nothing left the database` for the protected half, and exited 0 in 1.9 s. It empties the decision log and deletes every session, so do not run it while someone else is using the databases. `npm run core:reset` does only the reset.

### Tests

```bash
npm run test:core
```

Runs `vitest run` over `core/test/**/*.test.ts` against the real databases. On 2026-10-03: 7 files, 175 tests passed in about 21 s (policy, analyzer, breaker, server, mcp, redteam, web). Each test asserts only on sessions and tickets it created. Later that day `demo.test.ts` was added for the two demo routes of the dashboard: 8 files, 179 tests passed in 22.6 s, run once. That file clears the dashboard's demo history and deletes scripted Breaker sessions older than 4 seconds, like the routes it tests; its assertion on `tb_contexts` can fail if someone runs the Live demo at the same moment.

### MCP server

`src/mcp.ts` is a stdio MCP server with two tools: `execute_sql({ sql })` and `session_status()`. It talks to the Breaker only over HTTP, so the HTTP API must be running. One MCP process is one session. If the Breaker stops knowing that session, the tool returns an error and does not open a new one: a new session would give a tainted conversation clean stamps.

```bash
npm run -s mcp
```

Use `-s`. Without it npm prints its banner on stdout, which is the protocol channel.

To register it with Claude Code, from the repository root:

```bash
claude mcp add trifecta-breaker -e BREAKER_URL=http://127.0.0.1:3150 -- npx tsx core/src/mcp.ts
```

This form gives the MCP process only `BREAKER_URL` (add `-e BREAKER_API_KEY=...` if the API has a key). The `mcp` npm script loads `.env.local`, which puts the database connection strings in the MCP process's environment even though `mcp.ts` never reads them. The server was tested with the SDK's own client, not with a real agent host.

## Where the implementation differs from the plan, and why

| Plan | Implementation | Why |
|---|---|---|
| Agent SQL runs on a pool with the customer's credentials | Agent SQL, the `EXPLAIN` and the execution run as role `breaker_agent` through `asAgent()` | Least privilege. The role can use the three customer tables and nothing else. Postgres answers 42501 for anything outside them. The unprotected replay uses the same role, so scenario E cannot drop a table. |
| Multi-statement check on semicolons only | Also sent with the extended protocol (`single()`) | Postgres itself rejects a second statement in the same string (SQLSTATE 42601). |
| Replay works on the tickets already in the table | Each run files its own copy of the attacker's ticket and removes it | Two runs at the same time cannot step on each other. |
| "A scalar function that reads tables is invisible to EXPLAIN: not handled" | `R5_UNLISTED_FUNCTION`: any function not on an allowlist is refused in every session | `query_to_xml('select ...')` reads a table with no scan in the plan, and the agent role can call it. |
| F is denied with R0 or R1 depending on the Customer DB | R1 is decided on the text (`breaker.` outside literals), before `EXPLAIN` | The answer does not depend on whether a `breaker` schema exists in the Customer DB. R1 also covers relations outside `CUSTOMER_SCHEMA` and 42501 during analysis. |
| Rules R0 to R4 | `R6_SECRET_SINK` added | A red-team finding: a session that read tokens could `INSERT` them into `support_tickets`. A plain `INSERT` does not scan its target, so R2 did not see it. The plan's 16-row truth table is unchanged. |
| Load flags, analyze, decide, write flags | The same steps inside one Breaker DB transaction that holds a row lock on the session | Two concurrent statements of one session cannot both pass. |
| Labels cached for the life of the process | Cached in memory for 60 s, loaded before the session lock is taken, reloaded on SIGHUP | Analysis never needs a second Breaker DB connection while one is held. With no labels for the customer schema every statement is refused. |
| Event inserted after execution, with the SQL error text in `reason` | Event inserted in the decision transaction, before execution. A failed execution adds only its SQLSTATE (`error_code`). | No statement runs without a log row, and an error message can quote row data. |
| `EXPLAIN` error text kept and returned | Returned only for SQLSTATE class 42 (syntax and access errors). Other classes return `analysis failed (SQLSTATE xxxxx)`. | Planning can evaluate functions, and an error message can carry data. |
| `events.sql` stores the statement | Stores the statement with string literals and comments blanked, plus `sql_sha256` of the original. Once a session holds a secret, its later statements are stored as a fixed placeholder plus the hash. | The log must not carry data. Names and numbers are free text too, so a session that holds a secret is logged by hash only. |
| Rows capped at 200 after the query | Reads are wrapped in `LIMIT 201`, and a reply carries at most 1 MB of rows | Postgres stops early instead of sending millions of rows. `rowCount` on a truncated read is 201, not the true total. |
| No limits on concurrency | One statement at a time per session, 2 in flight in total, 50 waiting, 8 per session. Past that the API answers 503. | Each pool has 3 connections. Slow statements from one session no longer stall the others. |
| Session pooler | Transaction pooler (port 6543) | The core only uses explicit transactions with `SET LOCAL`, and the dashboard's `DATABASE_URL` already uses that pooler. |
| Port 4000 | Port 3150 | This machine assigns one fixed port per project and 3150 is this one's. `PORT` overrides it. |
| Bind address not specified | Binds to `127.0.0.1` unless `HOST` is set | It is an SQL endpoint with no authentication by default. It must not listen on the venue Wi-Fi. |
| No auth | Optional `BREAKER_API_KEY` | When set, the two POST routes need `Authorization: Bearer <key>`, compared in constant time. |
| CORS headers for `http://localhost:3000` | Requests with an `Origin` that is not on the list get 403. Unknown `Host` gets 421. `POST /execute` must be `application/json` (415 otherwise). Bodies over 100 kB get 413. | Leaving out CORS headers only hides the answer from the page; the statement would already have run. |
| Tokens `sk_test_FAKE_...`, `xoxb-FAKE-...` | `DEMO_ONLY_NOT_A_REAL_TOKEN_7F3A`, `DEMO_ONLY_NOT_A_REAL_TOKEN_C21B` | Nothing in the project should look like a real credential format. |
| Separate repo, `.env`, `psql` for resets | `core/` inside the dashboard repo, `.env.local` at the root, `sql/apply.ts` instead of `psql` | One repo for the hackathon. `psql` is not required. |
| `GuardResult` has rows or a rule | Every result also carries `rule`, `reason`, `flagsBefore`, `flagsAfter`, `stoppedAt` and `eventId` | A caller can explain the decision without reading the log. |
| Customer tables as plain tables | Row level security is enabled on them, with policies for `breaker_agent` only | The Supabase project's public API key cannot read them. The owner connection is not affected. |

## Known limitations

**Policy and labels**

- Labels follow columns, not data. The guarantee is per session: if a session that holds a secret is allowed to write into an unlabeled table, that table now carries the secret without a label, and another session can read it. `R6_SECRET_SINK` only blocks writes into tables that have untrusted columns. Label every table an agent can write to, or reserve session creation for the trusted app (set `BREAKER_API_KEY`).
- Anyone who can call `POST /sessions` can open a second, clean session. An agent that only has the MCP tool cannot (one session per process, never replaced). Sessions are not bound to an agent identity.
- Resolution is per table, so it over-blocks: reading `service` from `integration_tokens` stamps the session `secret`. Column-level resolution is not built.
- Labels are applied by hand. A missed label is a hole.
- Writes in a tainted session are refused outright. There is no route to a human approval in this layer.
- An injected agent can still produce misleading text. The core contains data access, not model output.
- The function allowlist is matched on the name as Postgres deparses it. A function wrongly declared `IMMUTABLE` can be evaluated at plan time.
- If labels were loaded once and the table is later emptied, the running process keeps serving the cached labels. A fresh process with no labels for `CUSTOMER_SCHEMA` refuses every statement.

**The log**

- The decision log masks string literals and comments. Names and numbers are kept so the log stays readable. Once a session holds secret data its statements are logged by hash only. Because labels follow columns, text copied out of a labeled column by another route can still appear in the log as a name. Do not expose the log publicly.
- Class-42 planner messages are returned to the agent in full. The log copy has its double-quoted part blanked, by pattern.
- The error text of an allowed statement that fails is returned to the agent and can quote row data. The session's stamps already account for it. That text is never logged.

**The HTTP API**

- No authentication unless `BREAKER_API_KEY` is set. Set it whenever anyone else can reach the API.
- `http://localhost:3000` is always an allowed browser origin. Whatever page is served on that port of the same machine may call the Breaker.
- Availability is only partly handled. Two sessions sending slow statements occupy both slots, and everyone else waits or gets 503 once 50 are queued. The limits are per process.
- The 1 MB reply cap is applied after the rows arrive. A statement that builds one huge value still costs memory until the 5 s timeout (measured: resident memory peaked at 190 MB for a 20 MB row). Writes with `RETURNING` are not wrapped in a `LIMIT` and are buffered whole.
- There is no rate limit.
- The dashboard's **Run scenario** button and its Live demo delete earlier scripted runs from the decision log: sessions labeled `replay:` that are older than 4 seconds, with their events. Sessions opened through the HTTP API or the MCP server are never deleted by them. The log is therefore not a permanent record of scripted runs.
- The MCP server builds its requests from the origin of `BREAKER_URL`, so it cannot be pointed at the hosted mirror under `/api/breaker/`.

**The demo**

- The "Breaker off" path runs only the scripted statements. It is confined by `SET LOCAL ROLE` inside a transaction, which a multi-statement script can leave. Never route free text to it. A free-text unprotected mode needs a connection that logs in as the agent role.
- Both databases are one Supabase project today (see above). Behaviour with a real second project is not tested.
- The pitch "one connection string" leaves out that the Customer DB also needs the `breaker_agent` role, its grants and policies (`sql/customer/001_schema.sql`), and label rows in the Breaker DB.

**Not verified**

- The 10 s `lock_timeout` on the session row, the 10 s pool connection timeout, the 503 answer over HTTP (asserted at function level only), the 500 paths, the SIGHUP reload, and the `Origin` check against a real browser (tested with forged headers from Node).
