# Threat model

This file has two parts. The first covers the operation catalog and its dashboard (`src/lib/gateway.ts`). The second, further down, covers the SQL Breaker (`core/`), which accepts raw SQL.

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
- **Two public routes delete demo data, by design.** See the next section.
- Session ids are unguessable UUIDs but are bearer handles; a real deployment would bind them to an authenticated agent identity.
- No automated labeling, no multi-tenancy.

## Public routes that delete demo data

`POST /api/demo/run` (the Live demo) and `POST /api/breaker/demo` (**Run scenario** in the SQL Breaker tab) need no sign-in and delete rows before they run. This is deliberate: the data is synthetic and the owner wants every demo to start clean. `POST /api/demo/run` truncates the dashboard's demo tables (`tb_events`, `tb_approvals`, `tb_sessions`, `tb_contexts` and the dashboard database's `support_tickets`), which includes pending approvals and anything the operator's workflow wrote. Both routes delete the Breaker sessions labeled `replay:` that are older than 4 seconds, and their rows in the decision log. They cannot delete more than that: they take no SQL and no table name (one takes no body, the other a scenario letter `A` to `F`), they never touch Breaker sessions opened through the HTTP API or the MCP server, never the label rows, and never the customer's tickets other than the one each scripted run files and removes itself. What remains is an availability problem, accepted for the demo: anyone who can reach the dashboard can clear the shared demo board for everyone looking at it, as often as the rate limit allows (12 runs per minute for the Live demo, 40 for the SQL Breaker tab, counted per server process and shared by all anonymous callers). The same-origin check stops other websites, not scripts. A clear that lands while another run is in flight, from another server instance or a test run, can make that run answer 500. A deployment that holds real data must not ship these two routes.

---

## The embedded victim app

`/victim` is a deliberately vulnerable demo target. One weakness is intended: with the Breaker off, an instruction hidden in a ticket makes the support agent copy a fictitious token into a ticket reply. Everything else is meant to hold.

- The browser sends two booleans to `POST /api/victim/process`, never SQL. With the Breaker on, the agent's statements go through `guardedExecute` in a new session per run.
- With the Breaker off, the scripted agent sends three fixed statements. Each runs alone, with the extended protocol, in a transaction as the role `breaker_agent`, which can read and write the three customer tables and nothing else. A statement that ends as another role is rolled back, and the connection is cleaned before it returns to the pool.
- The live model with the Breaker off is disabled unless the server sets `VICTIM_UNSAFE_LIVE_OFF=1`. Reason: the app logs in as the database owner and only switches role, and one model-written statement can borrow that login back (`set_config`) and read as the owner. A public server must not set the flag. The fix that would remove the flag is a separate database login for the agent role; it is not built.
- The form and the run route check the origin and have budgets per visitor (5 tickets and 6 runs per minute) under a ceiling for the whole site (30 and 20). A signed-in operator is not limited. The budgets are counted per server process.
- **Reset replies** clears every reply and puts the three seeded tickets back. It does not delete tickets filed by visitors; `npm run core:reset` does.

What an attacker can still do through it: fill the tickets table within the budgets, change which ticket the scripted run targets by filing a newer ticket with the marker text, and read any ticket's reply by guessing its number (the reply page is public by design).

# Threat model: SQL Breaker (`core/`)

Everything above describes the operation catalog (`src/lib/gateway.ts`). This part describes the second layer, the SQL Breaker, which accepts raw SQL from an agent. The two layers do not share code, tables or sessions.

## What it protects

The same exfiltration path, for an agent that writes its own SQL: it reads a ticket that carries instructions, reads a secret, and writes the secret where the attacker can read it. The Breaker does not look at row text and does not detect the injection. It tracks which labeled tables each session has touched.

## Invariants

1. **No mix.** A session never holds both `untrusted` and `secret` data: in either order, in one statement or across several, and with concurrent statements.
2. **No way out.** A session that has read `untrusted` data cannot write. A session that holds `secret` data cannot write into a table that has `untrusted` columns.
3. **Stamps only accumulate.** No statement and no API call removes a stamp. A deny leaves the stamps as they were. An allow sets them before the statement runs, so a statement that fails after being allowed still counts.
4. **Agent SQL stays inside the customer's tables.** It never touches the `breaker` schema or anything outside `CUSTOMER_SCHEMA`.
5. **Every decision is logged before anything runs**, with rule, reason and stamps before and after. The log does not store string literals, comments or database error text.
6. **Fail closed.** A statement that cannot be analyzed does not run. With no labels loaded, or when bookkeeping fails, nothing runs.

## What each rule stops

| Rule | Stops |
|---|---|
| `R0_OPAQUE_STATEMENT` | Statements the analyzer cannot vouch for: several statements in one string (scenario E), keywords other than `SELECT`, `WITH`, `INSERT`, `UPDATE`, `DELETE`, a NUL byte, `SELECT ... INTO`, a failed `EXPLAIN`, an unknown plan shape, missing labels. |
| `R1_PROTECTED_OBJECT` | Tampering with stamps, labels or the log (scenario F), reads of system catalogs and `information_schema`, and any object the agent role may not use. |
| `R5_UNLISTED_FUNCTION` | Reads that `EXPLAIN` cannot show, through functions such as `query_to_xml`, `current_setting`, `set_config`, `pg_get_viewdef`. Every function not on the allowlist is refused in every session. |
| `R2_TRIFECTA_MIX` | The mix itself: tokens after tickets (scenario A, step 2), tickets after tokens (B), both in one statement (D), including subqueries, joins, `LATERAL` and CTEs, because the plan lists every relation. |
| `R3_TAINTED_WRITE` | The write-back in scenario A step 3, and any `UPDATE` or `DELETE` that scans an untrusted table. |
| `R6_SECRET_SINK` | Copying a secret into a table outsiders read back: `INSERT INTO support_tickets ... SELECT token ...`, or a token read followed by an `INSERT` of the literal. |
| `R4_OPAQUE_IN_FLAGGED_SESSION` | Plans with nodes the analyzer cannot see into (Function Scan, Foreign Scan, Table Function Scan) once the session carries a stamp. |

## What the agent role and the read-only transaction add

The policy is the first control. Two more sit under it in Postgres and do not depend on the analyzer being right.

- **Role `breaker_agent`.** The `EXPLAIN` and the execution run as this role (`SET LOCAL ROLE` inside a transaction). It has `SELECT`, `INSERT`, `UPDATE`, `DELETE` on `support_tickets`, `SELECT` on `integration_tokens` and `customers`, and nothing else: no DDL, no other schema. Postgres answers SQLSTATE 42501 for the rest. This is why scenario E fails even with the Breaker off, and why `pg_read_file` is refused.
- **Read-only transaction.** A statement the analyzer classified as a read runs in `BEGIN TRANSACTION READ ONLY`. If the analyzer missed a write, Postgres refuses it with SQLSTATE 25006. The red team observed this for `nextval(...)`, `SELECT ... FOR UPDATE` and a hidden `SELECT ... INTO TEMP`.
- **Extended protocol.** Agent SQL is sent as a single prepared statement. Postgres rejects a second statement in the same string (SQLSTATE 42601).
- **Statement timeout** of 5 s, a cap of 200 rows and 1 MB per reply.
- **Row level security** is enabled on the customer tables with policies for `breaker_agent` only, so the Supabase project's public API key cannot read them.

## The HTTP API

`POST /execute` accepts SQL over HTTP. That is the product, and it is the only place in the repository where SQL arrives over HTTP without a key.

- **No authentication by default.** Anyone who can reach the port can open a session and run statements, within the rules above. For that reason the server binds to `127.0.0.1` unless `HOST` is set, and prints a warning when it listens elsewhere without `BREAKER_API_KEY`.
- **`BREAKER_API_KEY`** (optional): the POST routes then require `Authorization: Bearer <key>`. The comparison is on SHA-256 digests in constant time.
- **Browsers on other sites.** A request with an `Origin` that is not allowed is refused with 403 before anything runs, preflight included. A `Host` that is not `localhost`, `127.0.0.1`, `[::1]`, `HOST` or in `BREAKER_ALLOWED_HOSTS` gets 421 (DNS rebinding). `POST /execute` requires `application/json`, which a page cannot send to another site without a preflight.
- **Bodies** are capped at 100 kB, also when chunked.
- **The hosted mirror** (`/api/breaker/sessions`, `/api/breaker/execute` in the Next.js app) exists only when `BREAKER_API_KEY` is set and the caller sends it. It does not apply the Origin, Host and content-type checks of `core/src/server.ts`.
- **The dashboard's own routes** take a scenario id, never SQL. `POST /api/breaker/demo` is public and deletes earlier scripted runs from the decision log before it runs (see "Public routes that delete demo data" above). `GET /api/breaker/state` is public and returns the decision log with session ids cut to 8 characters, because a full session id is all the Breaker API asks for to act on a session.

## Trusted components

The Breaker process, its two connection strings, the Breaker DB, the label rows, and whoever may call `POST /sessions`. The agent is untrusted and, in the intended deployment, holds only a session id or the MCP tool.

## What it does not protect

- **What the agent says.** An injected agent can still write a misleading summary.
- **Mislabeled or unlabeled data.** Labels are applied by hand and resolved per table.
- **Paths around the Breaker.** Any other database credential, any other tool. The demo's "Breaker off" lane is such a path on purpose.
- **Memory outside the session.** An agent that carries what it read into a different session is not seen.

## Residual risks

- **Secret copied through an unlabeled table.** `R6_SECRET_SINK` covers only tables with untrusted columns. A session that holds a secret may write into an unlabeled table (row 10 of the plan's truth table), and a different session may then read it together with untrusted data. Closing it means "a session that holds a secret cannot write", which is a product decision not taken.
- **Second session.** Anyone who can call `POST /sessions` gets a clean session. Without `BREAKER_API_KEY` that is anyone who can reach the API.
- **The "Breaker off" lane** is confined by `SET LOCAL ROLE` inside a transaction. A multi-statement script sent with the simple protocol can end that transaction and continue as the connection's owner. It is unreachable today because that lane only runs the fixed SQL of `core/src/scenarios.ts`. Never route free text to it.
- **The log** masks string literals and comments. Identifiers and numbers are stored as written, so text can be put in the log as a name. Sessions that hold a secret are logged by hash only. The public state endpoint republishes the log.
- **Class-42 planner messages** go back to the agent in full. The logged copy is scrubbed by pattern (the double-quoted part).
- **Execution error text** goes back to the agent and can quote row data. The stamps already account for it.
- **Availability.** Two slow sessions occupy both execution slots. Others wait, and get 503 once 50 are queued. There is no per-client rate limit. Memory is not bounded for a single huge value or for a write with `RETURNING`.
- **`http://localhost:3000`** is always an allowed browser origin. Any page served on that port of the same machine may call the Breaker.
- **Stale labels.** A label change takes up to 60 s per process (or `kill -HUP`). If the label table is emptied after a process loaded it, that process keeps the old labels.
- **Function allowlist** is matched on the deparsed name. A function wrongly declared `IMMUTABLE` can run at plan time.
- **Covert channels**: timing, planner statistics, which rows a read returns.
- **One Supabase project today.** Both connection strings point at one project, with the customer tables in schema `demo`. The separation between the two databases is by schema, role and code path, not by server. Behaviour with a second project is not tested.
- **Not verified:** the session lock timeout, the pool connection timeout, the 503 path over HTTP, the SIGHUP reload, the Origin check against a real browser, the hosted mirror with a key set, the MCP server with a real agent host.
