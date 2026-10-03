import { demoRunReply } from "@/lib/demo-api";

export const maxDuration = 60;

// Clears the previous demo data and replays the attack twice: unprotected sandbox, then protected gateway.
// The whole handler lives in src/lib/demo-api.ts, where core/test/demo.test.ts can call it.
export const POST = (request: Request) => demoRunReply(request);
