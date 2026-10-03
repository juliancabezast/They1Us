import { clearedCookie, forbidden, operatorCookie, passcodeMatches, sameOrigin } from "@/lib/operator";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  const { passcode } = await request.json().catch(() => ({}));
  if (!passcodeMatches(passcode)) return forbidden("Wrong passcode.", 401);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": operatorCookie() } });
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedCookie() } });
}
