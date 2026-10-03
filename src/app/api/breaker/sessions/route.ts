import { createSessionReply } from "@core/http";
import { failed, logFailure } from "@/lib/breaker-api";
import { refusal, send } from "../hosted";

// Mirror of POST /sessions on the Breaker API: a new, clean session for one agent conversation.
export async function POST(request: Request) {
  const refused = refusal(request);
  if (refused) return refused;
  try {
    return send(await createSessionReply());
  } catch (err) {
    logFailure("sessions", err);
    return failed("The session could not be created.", 500);
  }
}
