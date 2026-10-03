import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthContext } from "./gateway";

// Minimal operator/agent separation for the demo. The operator proves who they
// are with a passcode and gets an httpOnly cookie. The agent runtime never sees
// a request, a cookie or the passcode: it only ever holds a session id.

const COOKIE = "tb_operator";
const TTL_SECONDS = 8 * 60 * 60;

const sign = (payload: string) =>
  createHmac("sha256", process.env.SESSION_SECRET ?? "").update(payload).digest("hex");

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function passcodeMatches(candidate: unknown): boolean {
  const expected = process.env.OPERATOR_PASSCODE;
  return Boolean(expected && process.env.SESSION_SECRET && typeof candidate === "string" && safeEqual(candidate, expected));
}

export function operatorCookie(): string {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${expires}.${sign(String(expires))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_SECONDS}${secure}`;
}

export const clearedCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function operatorFrom(request: Request): AuthContext | null {
  if (!process.env.SESSION_SECRET) return null;
  const raw = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const [expires, mac] = raw?.split(".") ?? [];
  if (!expires || !mac || !safeEqual(mac, sign(expires)) || Number(expires) < Date.now() / 1000) return null;
  return { role: "operator", operatorId: "operator:demo" };
}

/** State-changing requests must come from this site's own pages. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const forbidden = (message: string, status = 403) => Response.json({ error: message }, { status });

/** Guard for operator-only routes. Returns the operator or the response to send. */
export function requireOperator(request: Request): AuthContext | Response {
  if (!sameOrigin(request)) return forbidden("Cross-origin request refused.");
  return operatorFrom(request) ?? forbidden("Operator sign-in required.", 401);
}

/** The demo runtime that launches public attack replays. It cannot approve anything. */
export const DEMO_RUNTIME: AuthContext = { role: "operator", operatorId: "runtime:public-replay" };
