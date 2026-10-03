import { replayResponse } from "@/lib/replay-api";

export const maxDuration = 60;

// Unprotected sandbox: a separate executor over synthetic fixtures only.
export const POST = (request: Request) => replayResponse(request, "sandbox");
