import { breakerState, failed, logFailure } from "@/lib/breaker-api";

// Read on every request: the dashboard polls this while a scenario runs.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await breakerState(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    logFailure("state", err);
    return failed("The Breaker state could not be read.", 500);
  }
}
