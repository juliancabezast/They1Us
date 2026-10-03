import { runReply } from "@/lib/breaker-api";

export const maxDuration = 60;

// Runs one scripted scenario. The request names it; it never carries SQL.
// The whole handler lives in src/lib/breaker-api.ts, where core/test/web.test.ts can call it.
export const POST = (request: Request) => runReply(request);
