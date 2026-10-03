import { failed, logFailure, resetBreaker, sameOrigin } from "@/lib/breaker-api";
import { forbidden, requireOperator } from "@/lib/operator";

// Restores the demo state between runs, in both databases: the Breaker's log and sessions,
// and the customer's rehearsal tickets and replies. Operator only: it empties the decision log.
export async function POST(request: Request) {
  // Stricter than the check inside requireOperator: scheme and port count too.
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  const operator = requireOperator(request);
  if (operator instanceof Response) return operator;
  try {
    await resetBreaker();
    return Response.json({ ok: true });
  } catch (err) {
    logFailure("reset", err);
    return failed("The demo state could not be reset.", 500);
  }
}
