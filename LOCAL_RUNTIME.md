# Local runtime

- **Port: 3140**, loopback only, fixed in `package.json` (`next dev -p 3140 -H 127.0.0.1`). Next.js does not move to another port when one is passed explicitly; it fails if the port is taken.
- **Why 3140 and not a new 43xxx port:** the owner keeps a one-port-per-project table and assigned 3140 to this project on 2026-10-03. That table is the registry; no other project in it uses 3140.
- **Start:** `npm run dev`
- **URL:** http://localhost:3140

Checks on 2026-10-03:

- `lsof -tiTCP:3140 -sTCP:LISTEN` showed only this project's dev server.
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3140` returned `200`.
- `curl http://localhost:3140/api/state` returned `200` with data read from the Supabase project.
- The listener is bound to `127.0.0.1` only, not `0.0.0.0`.

## Breaker HTTP API (SQL Breaker)

- **Port: 3150**, loopback only by default. Set in `core/src/server.ts` (`PORT` overrides the port, `HOST` the bind address). The plan document says 4000. This machine keeps one fixed port per project and 3150 was the next free one after 3140.
- **Start:** `npm run breaker`. It prints `Breaker API listening on http://127.0.0.1:3150` and the number of labels loaded. If the port is taken it prints `Breaker API could not start: ...` and exits; it does not move to another port.
- **Stop:** Ctrl+C, or SIGTERM. Stop it when you are done: nothing else should be left listening on 3150.
- **URL for clients:** `BREAKER_URL=http://127.0.0.1:3150`
- The dashboard on 3140 does not need this server. The SQL Breaker tab calls the core in process. The MCP server (`npm run -s mcp`) and the victim app do need it.

Commands (all from the repository root, all read `.env.local`):

| Command | Does | Port |
|---|---|---|
| `npm run dev` | Dashboard. The Live demo (top of Overview) and **Run scenario** (SQL Breaker tab) delete demo rows on every run. | 3140 |
| `npm run breaker` | Breaker HTTP API | 3150 |
| `npm run -s mcp` | MCP server on stdio; calls the Breaker HTTP API | none |
| `npm run replay -- A --protected` | One scripted scenario in the terminal (`A` to `F` or `all`; `--unprotected`; `--keep`) | none |
| `npm run test:core` | Core tests (vitest). Test servers listen on port 0 (ephemeral). | none fixed |
| `npm run core:db` | Applies `core/sql` schema, labels and seed to both databases. Additive. | none |
| `npm run core:reset` | Empties the Breaker log and sessions, deletes tickets with id above 3, clears replies | none |
| `npm run attack` | `core:reset`, then scenario A unprotected, then protected | none |

Checks on 2026-10-03:

- Before starting, `lsof -tiTCP:3150 -sTCP:LISTEN` printed nothing.
- `npm run breaker` printed `Breaker API listening on http://127.0.0.1:3150` and `4 column labels loaded (demo: 4); customer schema is demo`. `lsof` showed the listener on `127.0.0.1:3150` only.
- `curl http://localhost:3150/health` returned `200` with `{"ok":true}`.
- `curl -X POST http://localhost:3150/sessions` returned `201` with a session id. `POST /execute` with `SELECT body FROM support_tickets` returned `200`, `decision: allow`, 3 rows. The same session asking for `integration_tokens` returned `200`, `decision: deny`, `R2_TRIFECTA_MIX`.
- After SIGTERM, `lsof -tiTCP:3150 -sTCP:LISTEN` printed nothing, `curl` to 3150 got no connection, and `http://127.0.0.1:3140` still returned `200`.
- `npm run test:core`: 7 files, 175 tests passed.
- Later the same day, after `core/test/demo.test.ts` was added: `npx vitest run`, 8 files, 179 tests passed (run once, by the backend engineer).
- `curl -X POST http://127.0.0.1:3140/api/demo/run` with a same-origin `Origin` header returned `200` with `{ off, on }`; without the header, `403`. `POST /api/breaker/demo` with `{"scenario":"A"}` returned `200` with `{ off, on }`.

## Demo data is deleted on every run

- **Run live demo** (Overview) calls `POST /api/demo/run`. It truncates `tb_events`, `tb_approvals`, `tb_sessions`, `tb_contexts` and `support_tickets` in the dashboard database, deletes the scripted runs older than 4 seconds from the Breaker log, then writes two new contexts.
- **Run scenario** (SQL Breaker tab) calls `POST /api/breaker/demo`. It deletes the scripted runs older than 4 seconds from the Breaker log, then runs the scenario in both modes.
- Neither needs the operator sign-in. Neither touches Breaker sessions opened through the HTTP API on 3150 or the MCP server.
- `core/test/demo.test.ts` calls the same code, so `npm run test:core` also clears the dashboard's demo history. Do not run it during a presentation.
