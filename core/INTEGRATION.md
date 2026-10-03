# Integrating the victim app (acme-support) with the Breaker

For the developer of the app that owns the tickets and runs the AI agent. The Breaker runs the agent's SQL for you and decides, before each statement runs, whether the session may have it.

## Where the Breaker is

| Setup | `BREAKER_URL` | Session | Execute |
|---|---|---|---|
| Local (`npm run breaker` in the Breaker repo) | `http://127.0.0.1:3150` | `POST /sessions` | `POST /execute` |
| Hosted mirror on the dashboard deployment | `https://<dashboard host>/api/breaker` | `POST /api/breaker/sessions` | `POST /api/breaker/execute` |

- Local: no key by default. If the Breaker was started with `BREAKER_API_KEY`, send `Authorization: Bearer <key>` on both POST routes (401 without it). `http://localhost:3150` also answered in the curl test on this machine.
- Hosted mirror: exists only when the dashboard server has `BREAKER_API_KEY` set (503 otherwise) and the request carries it (401 otherwise). Call it from your server, not from a browser page: it sends no CORS headers. The mirror has not been exercised over HTTP with a key set.

## The two endpoints

### `POST /sessions`

No body. Returns a new, clean session.

```
201 {"sessionId":"<uuid>"}
```

### `POST /execute`

Body: `{"sessionId":"<uuid>","sql":"<one statement>"}` with `content-type: application/json`, at most 100 kB. Table names are unqualified (`support_tickets`, not `public.support_tickets`). One statement per call, starting with `SELECT`, `WITH`, `INSERT`, `UPDATE` or `DELETE`.

**Allow** (HTTP 200):

```json
{"ok":true,"decision":"allow",
 "rows":[{"body":"I reset my password twice and still cannot log in."}, "..."],
 "rowCount":3,"truncated":false,
 "rule":"ALLOW","reason":"No policy violated.",
 "flagsBefore":{"hasUntrusted":false,"hasSecret":false},
 "flagsAfter":{"hasUntrusted":true,"hasSecret":false},
 "stoppedAt":null,"eventId":1211}
```

**Deny** (HTTP 200: a deny is a normal answer, not an error). Nothing ran.

```json
{"ok":false,"decision":"deny",
 "rule":"R2_TRIFECTA_MIX","reason":"A session cannot hold both untrusted and secret data.",
 "flagsBefore":{"hasUntrusted":true,"hasSecret":false},
 "flagsAfter":{"hasUntrusted":true,"hasSecret":false},
 "stoppedAt":"policy","eventId":1212}
```

**Allowed, but the SQL failed in Postgres** (HTTP 200). The session keeps the new stamps.

```json
{"ok":false,"decision":"allow",
 "error":"invalid input syntax for type integer: \"Cannot log in\"","errorCode":"22P02",
 "rule":"ALLOW","reason":"No policy violated.",
 "flagsBefore":{"hasUntrusted":false,"hasSecret":false},
 "flagsAfter":{"hasUntrusted":true,"hasSecret":false},
 "stoppedAt":null,"eventId":1218}
```

**Request errors.** The body is `{"error":"<sentence>"}`.

| Status | When | Example body |
|---|---|---|
| 400 | Body is not JSON, or `sessionId` / `sql` is missing or not a string | `{"error":"sql is required and must be a non-empty string."}` |
| 404 | The session id is unknown or malformed | `{"error":"Unknown session"}` |
| 401 | A key is required and missing or wrong | `{"error":"Missing or wrong API key"}` |
| 403 | The request has an `Origin` that is not allowed | `{"error":"Origin not allowed"}` |
| 413 | Body over 100 kB | `{"error":"The body is larger than 100 kB"}` |
| 415 | `POST /execute` without `content-type: application/json` | `{"error":"The body must be sent as application/json"}` |
| 421 | The `Host` header is not a name the Breaker answers to | `{"error":"Unknown Host"}` |
| 503 | The Breaker is saturated. Nothing ran. Retry shortly. | `{"error":"The Breaker is busy. Try again shortly."}` |
| 500 | The Breaker could not do its bookkeeping. Nothing ran. | `{"error":"The Breaker could not process the statement."}` |

To tell the three 200 answers apart: `ok` true means rows. `ok` false with `decision: "deny"` means refused. `ok` false with `decision: "allow"` means it ran and failed.

## What to show in the UI

| Field | Meaning |
|---|---|
| `decision` | `allow` or `deny`. |
| `rule` | Which rule decided: `ALLOW`, `R0_OPAQUE_STATEMENT`, `R1_PROTECTED_OBJECT`, `R2_TRIFECTA_MIX`, `R3_TAINTED_WRITE`, `R4_OPAQUE_IN_FLAGGED_SESSION`, `R5_UNLISTED_FUNCTION`, `R6_SECRET_SINK`. |
| `reason` | One sentence for a human. Safe to display. |
| `flagsBefore`, `flagsAfter` | The session's stamps (`hasUntrusted`, `hasSecret`) before and after. On a deny they are equal. |
| `stoppedAt` | `precheck`, `explain` or `policy` for a deny. `null` for an allow. |
| `rows`, `rowCount`, `truncated` | At most 200 rows and 1 MB. When `truncated` is true, `rowCount` is 201 (rows fetched), not the true total. |
| `error`, `errorCode` | Postgres message and SQLSTATE of an allowed statement that failed. The message can quote row data: treat it like rows. |
| `eventId` | The row in `breaker.events`, to link to the decision log. |

Give the whole result back to the model as the tool result. The `rule` and `reason` tell it why a statement was refused.

## One session per button click

Call `POST /sessions` once when the staff member presses the button that starts the agent. Send every `execute_sql` tool call of that agent run to `POST /execute` with that `sessionId`. Do not open a new session mid-run and do not retry a refused statement in a fresh session: the stamps are the protection, and a fresh session has none. Do not send the session id to the browser if you can avoid it. The id is all the Breaker asks for to act on a session.

## CORS and Host

Server-to-server calls (your API route calling the Breaker) send no `Origin` header and need nothing.

A browser page calling the Breaker directly must be on the allowlist: `http://localhost:3000` is built in. To add another origin, start the Breaker with `BREAKER_CORS_ORIGINS=http://localhost:3001,https://app.example` (comma separated, exact match on scheme, host and port). Any other `Origin` gets 403, preflight included.

By default the Breaker listens on `127.0.0.1` only and answers only to `localhost`, `127.0.0.1` and `[::1]` in the `Host` header (421 otherwise). To reach it from another machine it must be started with `HOST` set to an address it should listen on, and every name or address you call it by must be the value of `HOST` or be listed in `BREAKER_ALLOWED_HOSTS` (comma separated, no port). With `HOST=0.0.0.0` that includes the LAN IP. Set `BREAKER_API_KEY` in that case.

## OFF mode

OFF mode sends the agent's SQL straight to the Customer DB to show the attack. Do not run it as the database owner. Scenario E (`SELECT 1; DROP TABLE support_tickets`) would drop the table. Run it as the `breaker_agent` role, the way the Breaker does in `core/src/db.ts`:

```sql
begin;
set local role breaker_agent;
set local search_path = demo;          -- the value of CUSTOMER_SCHEMA
set local statement_timeout = '5s';
-- the agent's statement
commit;
```

As that role the `DROP TABLE` fails with SQLSTATE 42501. One limit you must know: `SET LOCAL ROLE` lasts until the transaction ends, and a string with several statements sent with the simple protocol can end it (`...; commit; ...`) and continue as the owner. Send one statement per transaction with the extended protocol (in `pg`: `client.query({ text, queryMode: "extended" })`), where Postgres rejects a second statement (SQLSTATE 42601). This mirrors `asAgent()` and `single()` in the core; it has not been tested inside the victim app. A connection that logs in as the agent role would remove the problem; that login role does not exist yet (`breaker_agent` is `nologin`).

## The customer tables

`core/sql/customer/001_schema.sql` and `002_seed.sql` are the single source of truth for `support_tickets`, `integration_tokens` and `customers`. Use those tables. Do not create your own and do not change their columns without updating those files and the labels in `core/sql/breaker/002_labels.sql`: a column outsiders can write to that has no label is a hole.

- Today the tables live in schema `demo` of the shared Supabase project, not in `public`. Your own queries (the ticket form, the `/ticket/[id]` page) need `demo.support_tickets` or `search_path = demo`. Agent SQL sent through the Breaker stays unqualified.
- Row level security is on for all three tables. The only policies are for `breaker_agent`. The owner connection string is not affected. No policy exists for the project's public API key, so it cannot read or write them, and the public ticket form must insert through your server with the owner connection, not from the browser with the Supabase client.
- The seed has three tickets (ids 1 to 3, the third one malicious) and two fictitious tokens (`DEMO_ONLY_NOT_A_REAL_TOKEN_...`). `003_reset.sql` deletes tickets with id above 3 and clears every reply. Never store a real credential in these tables.
- Tickets submitted through your form get new ids. Nothing in the Breaker depends on a ticket id.
