import { failed, sameOrigin } from "@/lib/breaker-api";
import { resetTickets } from "@/lib/victim/tickets";

// Demo reset between the OFF and ON runs: clear every ticket reply and restore the three seeded tickets.
export async function POST(req: Request) {
  if (!sameOrigin(req)) return failed("Cross-origin request refused.", 403);
  try {
    await resetTickets();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, error: "The replies could not be cleared." }, { status: 500 });
  }
}
