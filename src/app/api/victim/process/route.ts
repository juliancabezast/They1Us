import { failed, sameOrigin } from "@/lib/breaker-api";
import { operatorFrom } from "@/lib/operator";
import { runAgent, type AgentEvent } from "@/lib/victim/agent";
import { runBudget, visitorKey } from "@/lib/victim/limits";

export const dynamic = "force-dynamic";

// Only two booleans are accepted. SQL never comes from the request.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return failed("Cross-origin request refused.", 403);
  // The console is public in the demo: each visitor has a budget of runs, under a ceiling for the whole site.
  // The presenter signs in as operator and is never locked out by what other visitors do.
  if (operatorFrom(req) === null && !runBudget.take(visitorKey(req.headers))) {
    return failed("Too many runs right now. Try again in a minute.", 429);
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const breakerOn = body?.breakerOn === true;
  const scripted = body?.scripted === true;

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: AgentEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          // The client went away; let the run finish quietly.
        }
      };
      runAgent({ breakerOn, scripted, emit: send })
        .catch((e: unknown) => {
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
          send({ type: "done" });
        })
        .finally(() => {
          try {
            controller.close();
          } catch {}
        });
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
