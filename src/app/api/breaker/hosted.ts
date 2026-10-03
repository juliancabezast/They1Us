import { authorized, type HttpReply } from "@core/http";
import { failed } from "@/lib/breaker-api";

// The hosted mirror of the Breaker API (core/src/server.ts), for a victim app deployed somewhere
// that cannot reach a Breaker on localhost. Server to server: no same-origin rule and no CORS
// headers, so a browser on another site cannot use it. Not a route itself: shared by sessions/ and execute/.

/** Same cap as the Breaker HTTP server. */
export const MAX_BODY_BYTES = 100_000;

/**
 * The mirror exists only where the server has BREAKER_API_KEY, and only for callers that carry it.
 * Returns the refusal to send, or null when the request may proceed.
 */
export function refusal(request: Request): Response | null {
  // Checked here and not left to authorized(): without a key that function lets everyone in.
  if (!process.env.BREAKER_API_KEY) return failed("The hosted Breaker API is not enabled.", 503);
  if (!authorized(request.headers.get("authorization"))) return failed("A valid API key is required.", 401);
  return null;
}

export const send = (reply: HttpReply) =>
  Response.json(reply.body, { status: reply.status, headers: { "cache-control": "no-store" } });
