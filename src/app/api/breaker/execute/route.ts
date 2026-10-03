import { executeReply } from "@core/http";
import { failed, logFailure, readBody } from "@/lib/breaker-api";
import { MAX_BODY_BYTES, refusal, send } from "../hosted";

export const maxDuration = 60;

// Mirror of POST /execute on the Breaker API: { sessionId, sql } in, a GuardResult out (allow and deny are both 200).
// The one place in this app where SQL arrives over HTTP, and only from a server that holds the API key.
export async function POST(request: Request) {
  const refused = refusal(request);
  if (refused) return refused;

  const text = await readBody(request, MAX_BODY_BYTES).catch(() => "");
  if (text === null) return failed("Request body too large.", 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failed("The body must be JSON: { sessionId, sql }.", 400);
  }

  try {
    return send(await executeReply(body));
  } catch (err) {
    logFailure("execute", err);
    return failed("The statement could not be processed.", 500);
  }
}
