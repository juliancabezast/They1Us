import { replayResponse } from "@/lib/replay-api";

export const maxDuration = 60;

// Protected path: every operation goes through guardedExecute.
export const POST = (request: Request) => replayResponse(request, "protected");
