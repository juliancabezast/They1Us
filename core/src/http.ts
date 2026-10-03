// The Breaker API as plain functions: what each route answers, with no HTTP server attached.
// core/src/server.ts serves them with node:http; the Next.js mirror routes serve the same replies.
import { createHash, timingSafeEqual } from "node:crypto";
import { BUSY, guardedExecute } from "./breaker";
import { createSession } from "./session";
import type { CreateSessionResponse } from "./types";

export type HttpReply = { status: number; body: unknown };

const fail = (status: number, error: string): HttpReply => ({ status, body: { error } });

// Message only: a pg error object can carry connection details.
const report = (where: string, err: unknown) =>
  console.error(`[breaker] ${where}: ${err instanceof Error ? err.message : "unknown error"}`);

const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * true when BREAKER_API_KEY is unset, or the header is "Bearer <that key>".
 * Both sides are hashed first, so the comparison takes the same time whatever the header's length.
 */
export function authorized(header: string | null | undefined): boolean {
  const key = process.env.BREAKER_API_KEY;
  if (!key) return true;
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${key}`));
}

/** POST /sessions: a new, clean session. */
export async function createSessionReply(): Promise<HttpReply> {
  try {
    const body: CreateSessionResponse = { sessionId: await createSession("http") };
    return { status: 201, body };
  } catch (err) {
    report("POST /sessions", err);
    return fail(500, "The Breaker could not create a session.");
  }
}

/** POST /execute: allow and deny are both 200. A deny is a normal answer, not an error. */
export async function executeReply(body: unknown): Promise<HttpReply> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "The body must be a JSON object: { sessionId, sql }.");
  }
  const { sessionId, sql } = body as Record<string, unknown>;
  if (typeof sessionId !== "string" || !sessionId) return fail(400, "sessionId is required and must be a string.");
  if (typeof sql !== "string" || !sql.trim()) return fail(400, "sql is required and must be a non-empty string.");

  try {
    return { status: 200, body: await guardedExecute(sessionId, sql) };
  } catch (err) {
    if (err instanceof Error && err.message === "Unknown session") return fail(404, "Unknown session");
    // Saturated: refused at once instead of queued without limit. Nothing ran.
    if (err instanceof Error && err.message === BUSY) return fail(503, "The Breaker is busy. Try again shortly.");
    // Nothing ran. The caller gets a fixed sentence: the detail may describe our infrastructure.
    report("POST /execute", err);
    return fail(500, "The Breaker could not process the statement.");
  }
}
