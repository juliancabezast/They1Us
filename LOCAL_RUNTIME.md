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
