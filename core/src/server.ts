// The Breaker API over plain node:http. JSON in, JSON out:
//   POST /sessions                      -> 201 { sessionId }
//   POST /execute { sessionId, sql }    -> 200 GuardResult (allow and deny)
//   GET  /health                        -> 200 { ok: true }
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { assertEnv, closePools, CUSTOMER_SCHEMA } from "./db";
import { authorized, createSessionReply, executeReply, type HttpReply } from "./http";
import { getLabels, reloadLabels } from "./labels";

const MAX_BODY_BYTES = 100_000;
// After a 413 the rest of the upload is discarded, never buffered. Past this, the connection is cut.
const MAX_DISCARDED_BYTES = 1_000_000;

const ROUTES: Record<string, "GET" | "POST"> = { "/sessions": "POST", "/execute": "POST", "/health": "GET" };

/** The victim app in development, plus whatever BREAKER_CORS_ORIGINS lists (comma separated). */
function allowedOrigins(): string[] {
  const extra = (process.env.BREAKER_CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim());
  return ["http://localhost:3000", ...extra.filter(Boolean)];
}

/**
 * The names this server answers to: this machine, HOST when it is a name, and BREAKER_ALLOWED_HOSTS
 * (comma separated, without port). A page on another site whose DNS name is re-pointed at 127.0.0.1
 * would be "same origin" for the browser; its Host header still carries the other name.
 */
function allowedHosts(): string[] {
  const extra = `${process.env.HOST ?? ""},${process.env.BREAKER_ALLOWED_HOSTS ?? ""}`.split(",");
  return ["localhost", "127.0.0.1", "[::1]", ...extra.map((host) => host.trim().toLowerCase()).filter(Boolean)];
}

const hostName = (header: string | undefined) => (header ?? "").toLowerCase().replace(/:\d+$/, "");

function send(res: ServerResponse, { status, body }: HttpReply) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const fail = (res: ServerResponse, status: number, error: string) => send(res, { status, body: { error } });

/** The body as text, or null when it is over the cap (it stops being kept the moment it crosses it). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    // A declared length over the cap is refused before a single byte is kept.
    let over = Number(req.headers["content-length"]) > MAX_BODY_BYTES;
    if (over) resolve(null);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (!over && size > MAX_BODY_BYTES) {
        over = true;
        chunks = [];
        resolve(null);
      }
      if (!over) chunks.push(chunk);
      else if (size > MAX_DISCARDED_BYTES) req.destroy();
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    // The client went away mid-body: settle anyway (the answer goes nowhere) so the handler does not hang.
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(null));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";

  // Refused before anything is read, created or analyzed: a request under a name that is not ours.
  if (!allowedHosts().includes(hostName(req.headers.host))) return fail(res, 421, "Unknown Host");

  // A browser names the page a request comes from. Leaving out the CORS headers only hides the answer:
  // the statement would already have run. So a page that is not on the list is refused outright,
  // preflight included. Callers that are not browsers (curl, the MCP server, the app's server) send no Origin.
  const origin = req.headers.origin;
  res.setHeader("vary", "Origin");
  if (origin !== undefined) {
    if (!allowedOrigins().includes(origin)) return fail(res, 403, "Origin not allowed");
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-max-age", "600");
  }

  const expected = ROUTES[path];
  if (!expected) return fail(res, 404, "Not found");
  if (method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (method !== expected) {
    res.setHeader("allow", `${expected}, OPTIONS`);
    return fail(res, 405, "Method not allowed");
  }
  if (path === "/health") return send(res, { status: 200, body: { ok: true } });

  if (!authorized(req.headers.authorization)) {
    res.setHeader("www-authenticate", "Bearer");
    return fail(res, 401, "Missing or wrong API key");
  }
  if (path === "/sessions") return send(res, await createSessionReply());

  // JSON only: a form or text/plain body is what a page can send to another site without a preflight.
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    return fail(res, 415, "The body must be sent as application/json");
  }

  const text = await readBody(req);
  if (text === null) {
    // The response goes out now; what is still arriving is counted and dropped by readBody.
    return fail(res, 413, "The body is larger than 100 kB");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(res, 400, "The body is not valid JSON");
  }
  return send(res, await executeReply(body));
}

/** The server, not listening yet: the caller picks the port (tests use 0). */
export function createBreakerServer(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Message only: a pg error object can carry connection details.
      console.error(`[breaker] ${req.method} ${req.url}: ${err instanceof Error ? err.message : "unknown error"}`);
      if (res.headersSent) res.destroy();
      else fail(res, 500, "The Breaker could not process the request.");
    });
  });
}

/** Says what is protected, per schema: labels written for the wrong schema show up here. */
function report(labels: { table_schema: string }[]) {
  const perSchema = new Map<string, number>();
  for (const l of labels) perSchema.set(l.table_schema, (perSchema.get(l.table_schema) ?? 0) + 1);
  const detail = [...perSchema].map(([schema, n]) => `${schema}: ${n}`).join(", ");
  console.log(`${labels.length} column labels loaded (${detail}); customer schema is ${CUSTOMER_SCHEMA}`);
}

function main() {
  assertEnv();
  // 127.0.0.1 unless told otherwise: this endpoint runs SQL, it must not listen on the venue Wi-Fi by default.
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT) || 3150;
  const server = createBreakerServer();

  server.on("error", (err) => {
    console.error(`Breaker API could not start: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`Breaker API listening on http://${host}:${port}`);
    if (!process.env.BREAKER_API_KEY && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      console.warn("Warning: listening beyond this machine with no BREAKER_API_KEY. Anyone who can reach it can run SQL.");
    }
    // Warm the label cache so the first statement does not pay for it. Without labels every statement is refused.
    getLabels().then(report, (err: Error) =>
      console.error(`Warning: ${err.message} Statements are refused until they load.`),
    );
  });

  // Labels are cached for 60 s. After changing breaker.column_labels: kill -HUP <pid> applies them now.
  process.on("SIGHUP", () => {
    reloadLabels().then(report, (err: Error) => console.error(`Warning: ${err.message}`));
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      closePools().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    // Idle keep-alive connections would hold close() open.
    server.closeIdleConnections();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Only when run directly (npm run breaker): the tests import this file.
if (/(^|[\\/])core[\\/]src[\\/]server\.ts$/.test(process.argv[1] ?? "")) main();
