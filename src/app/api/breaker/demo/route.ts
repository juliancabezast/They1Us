import { breakerDemoReply } from "@/lib/breaker-api";

export const maxDuration = 60;

// Clears earlier replays from the Breaker log and runs one scripted scenario in both modes.
// The request names the scenario; it never carries SQL. The handler lives in src/lib/breaker-api.ts.
export const POST = (request: Request) => breakerDemoReply(request);
