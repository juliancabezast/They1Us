// The Breaker as an MCP server over stdio (plan section 13): POST /execute wrapped as one tool.
// This is the AGENT side. It talks to the Breaker over HTTP and nothing else: no db.ts, no connection
// string. An agent that only has this tool cannot reach the Customer DB except through the checkpoint.
//   BREAKER_URL      where the Breaker API listens (default http://127.0.0.1:3150)
//   BREAKER_API_KEY  sent as "Authorization: Bearer <key>" when set
// stdout is the protocol channel: never console.log here. Diagnostics go to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Flags, GuardResult } from "./types";

// The Breaker gives a statement 5 s; past this the Breaker itself is stuck.
const REQUEST_TIMEOUT_MS = 20_000;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Posted = { status: number; body: unknown };

const text = (value: string, isError = false): ToolReply => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where the Breaker is, for messages: origin only, so a URL with credentials in it is never echoed. */
function breakerOrigin(): string {
  const raw = process.env.BREAKER_URL || "http://127.0.0.1:3150";
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error("BREAKER_URL is not a valid URL.");
  }
}

/** POST to the Breaker. Throws one sentence the agent can read when the Breaker cannot be reached. */
async function post(path: string, body?: unknown): Promise<Posted> {
  const origin = breakerOrigin();
  const key = process.env.BREAKER_API_KEY;
  let res: Response;
  try {
    res = await fetch(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new Error(
      timedOut
        ? `The Breaker at ${origin} did not answer within ${REQUEST_TIMEOUT_MS / 1000} s. Nothing was returned.`
        : `The Breaker cannot be reached at ${origin}. Is it running (npm run breaker)? No SQL was executed.`,
    );
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Not JSON: something else is listening there. The status alone is reported.
  }
  return { status: res.status, body: parsed };
}

/** A refusal of the request itself (400, 401, 404, 413, 500): not a policy decision. */
function httpProblem(what: string, { status, body }: Posted): string {
  const detail = isRecord(body) && typeof body.error === "string" ? `: ${body.error}` : "";
  return `${what} (HTTP ${status})${detail}`;
}

// One conversation equals one session. It is opened on the first tool call and never replaced:
// if the Breaker stops knowing it, a fresh one would hand a tainted conversation a clean record.
let sessionId: string | null = null;
let opening: Promise<string> | null = null;
let lastFlags: Flags | null = null;

async function openSession(): Promise<string> {
  const reply = await post("/sessions");
  const id = isRecord(reply.body) ? reply.body.sessionId : undefined;
  if (reply.status !== 201 || typeof id !== "string" || !id) {
    throw new Error(httpProblem("The Breaker did not open a session", reply));
  }
  sessionId = id;
  console.error(`[breaker-mcp] session ${id} opened`);
  return id;
}

/** The session of this conversation. Two first calls at once share one POST /sessions. */
function session(): Promise<string> {
  if (sessionId) return Promise.resolve(sessionId);
  opening ??= openSession().finally(() => {
    // A failed attempt is not remembered: the next call tries again.
    opening = null;
  });
  return opening;
}

const isGuardResult = (body: unknown): body is GuardResult =>
  isRecord(body) && typeof body.ok === "boolean" && (body.decision === "allow" || body.decision === "deny");

async function executeSql(sql: string): Promise<ToolReply> {
  try {
    const id = await session();
    const reply = await post("/execute", { sessionId: id, sql });
    if (reply.status === 404) {
      return text(
        `The Breaker no longer knows session ${id} (it was reset). This conversation cannot continue with a new, ` +
          "clean session: start a new conversation. No SQL was executed.",
        true,
      );
    }
    if (reply.status !== 200 || !isGuardResult(reply.body)) {
      return text(`${httpProblem("The Breaker refused the request", reply)}. No SQL was executed.`, true);
    }
    const result = reply.body;
    lastFlags = result.flagsAfter;
    // The GuardResult as it came: rows when allowed; rule, reason and stoppedAt when denied;
    // error and errorCode when the statement was allowed but failed in Postgres.
    return text(JSON.stringify(result), !result.ok);
  } catch (err) {
    return text(err instanceof Error ? err.message : "The Breaker request failed.", true);
  }
}

const EXECUTE_DESCRIPTION = [
  "Run ONE SQL statement against the customer's Postgres database through the Trifecta Breaker, a checkpoint that",
  "decides before the statement runs. Table names are unqualified (for example: SELECT id, subject FROM support_tickets).",
  "",
  "The answer is JSON. Allowed: { ok: true, decision: \"allow\", rows, rowCount, truncated, flagsAfter, ... }",
  "(at most 200 rows are returned; truncated says whether there were more).",
  "Denied: { ok: false, decision: \"deny\", rule, reason, stoppedAt } and nothing was executed.",
  "Allowed but failed in Postgres: { ok: false, decision: \"allow\", error, errorCode }.",
  "",
  "What the Breaker enforces. This whole conversation is one session, and the session remembers what it has read:",
  "- R2_TRIFECTA_MIX: one session can never hold both untrusted data (text written by outsiders, such as support",
  "  ticket bodies) and secret data (such as integration tokens). After reading one kind, the other kind is refused",
  "  for the rest of the session.",
  "- R3_TAINTED_WRITE: a session that has read untrusted data cannot write (INSERT, UPDATE, DELETE).",
  "- R6_SECRET_SINK: a session that holds secret data cannot write into a table outsiders can reach (one with",
  "  untrusted columns, such as support_tickets).",
  "- R5_UNLISTED_FUNCTION: a function that is not on the Breaker's allowlist is refused, in every session.",
  "- R1_PROTECTED_OBJECT: only the customer's own tables can be used; the breaker schema and everything else is off limits.",
  "- R0_OPAQUE_STATEMENT / R4_OPAQUE_IN_FLAGGED_SESSION: a statement the Breaker cannot analyze is refused. Send a",
  "  single statement, not several separated by semicolons.",
  "",
  "A deny is final for this session: rewording the statement, or retrying it, gives the same answer. Tell the user",
  "what was refused and which rule refused it instead of looking for another route to the same data.",
].join("\n");

const server = new McpServer({ name: "trifecta-breaker", version: "0.1.0" });

server.registerTool(
  "execute_sql",
  {
    title: "Execute SQL through the Breaker",
    description: EXECUTE_DESCRIPTION,
    inputSchema: { sql: z.string().min(1).describe("One SQL statement. Unqualified table names.") },
  },
  ({ sql }) => executeSql(sql),
);

server.registerTool(
  "session_status",
  {
    title: "Breaker session status",
    description:
      "The Breaker session of this conversation: its id, or that none was opened yet (it opens on the first " +
      "execute_sql call), and the flags the Breaker last reported for it (hasUntrusted, hasSecret). Runs no SQL.",
    annotations: { readOnlyHint: true },
  },
  async () =>
    text(
      JSON.stringify(
        sessionId
          ? { sessionId, flags: lastFlags, breaker: breakerOrigin() }
          : { sessionId: null, note: "No session was opened yet. It opens on the first execute_sql call." },
      ),
    ),
);

async function main() {
  // Checked up front so a bad BREAKER_URL is one clear line at start, not a failure on the first call.
  const origin = breakerOrigin();
  await server.connect(new StdioServerTransport());
  console.error(`[breaker-mcp] ready on stdio, Breaker at ${origin}`);

  // The client hung up: nothing left to serve.
  const stop = () => process.exit(0);
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`[breaker-mcp] could not start: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});
