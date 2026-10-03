// The dashboard's routes under /api/breaker (src/lib/breaker-api.ts): regression tests for what the red team broke.
// The handlers are called directly with a Request, no Next.js server. Only sessions opened here are asserted on,
// and they are removed at the end.
import { afterAll, describe, expect, it } from "vitest";
import { guardedExecute } from "../src/breaker";
import { closePools, control } from "../src/db";
import { runScenario } from "../src/runner";
import type { Mode, ScenarioId, ScenarioRun } from "../src/scenarios";
import { createSession } from "../src/session";
import {
  breakerState,
  createRunLimiter,
  forCaller,
  readBody,
  runReply,
  sameOrigin,
  type DashboardRun,
} from "../../src/lib/breaker-api";
import { operatorCookie } from "../../src/lib/operator";

// Not a credential: only so the operator cookie can be signed when .env.local has no SESSION_SECRET.
process.env.SESSION_SECRET ||= "demo-only-not-a-real-secret";

const SITE = "http://127.0.0.1:3140";
const HOST = "127.0.0.1:3140";
const FULL_ID = "0b6f3c1e-1111-4222-8333-444455556666";
// Shaped like nothing in particular, and not the seed's fictitious form: stands in for a real secret.
const REAL_LOOKING = "NOT_THE_SEED_VALUE_0123456789abcdef";
const SEED_REPLY = "DEMO_ONLY_NOT_A_REAL_TOKEN_7F3A, DEMO_ONLY_NOT_A_REAL_TOKEN_C21B";

const opened: string[] = [];

const runRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SITE}/api/breaker/run`, {
    method: "POST",
    headers: { origin: SITE, host: HOST, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** The operator's cookie as a browser would send it back. */
const operatorHeaders = () => ({ cookie: operatorCookie().split(";")[0] });

const fakeRun = (scenario: ScenarioId, mode: Mode, reply: string | null): ScenarioRun => ({
  scenario,
  mode,
  sessionId: FULL_ID,
  steps: [],
  ticket: { id: 1, reply },
  leaked: reply !== null,
  asExpected: mode === "protected" ? true : null,
});

/** A run route that needs no database: counts its calls and answers with `reply` in the ticket. */
function fakeDeps(reply: string | null, limit = 40) {
  const calls: unknown[][] = [];
  return {
    calls,
    deps: {
      limiter: createRunLimiter(limit),
      run: async (...args: [ScenarioId, Mode]) => {
        calls.push(args);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return fakeRun(args[0], args[1], reply);
      },
    },
  };
}

afterAll(async () => {
  if (opened.length) await control.query("delete from breaker.sessions where id = any($1::uuid[])", [opened]);
  await closePools();
});

describe("GET /api/breaker/state never hands out a session id", () => {
  it("shows sessions and events by the first 8 characters of the id only", async () => {
    const id = await createSession("test:web");
    opened.push(id);
    await guardedExecute(id, "SELECT count(*) FROM customers");

    const state = await breakerState();
    const text = JSON.stringify(state);
    expect(text).not.toContain(id);
    expect(text).not.toContain(id.slice(9));
    for (const s of state.sessions) expect(s.id).toMatch(/^[0-9a-f]{8}$/);
    for (const e of state.events) expect(e.session_id).toMatch(/^[0-9a-f]{8}$/);
    // Still enough for the dashboard to group a session's rows.
    expect(state.events.some((e) => e.session_id === id.slice(0, 8))).toBe(true);
  });
});

describe("run rate limit", () => {
  it("counts and reserves in one step, and frees a slot when the window has passed", () => {
    const limiter = createRunLimiter(3, 1_000);
    expect([limiter.take(0), limiter.take(0), limiter.take(500)]).toEqual([true, true, true]);
    expect(limiter.take(999)).toBe(false);
    // The two slots taken at 0 are a full window old: two are free again.
    expect([limiter.take(1_000), limiter.take(1_001)]).toEqual([true, true]);
    expect(limiter.take(1_002)).toBe(false);
    expect(limiter.take(1_500)).toBe(true);
  });

  it("lets exactly 40 of 60 concurrent runs through", async () => {
    const { calls, deps } = fakeDeps(null);
    const replies = await Promise.all(
      Array.from({ length: 60 }, () => runReply(runRequest({ scenario: "D", mode: "protected" }), deps)),
    );
    const statuses = replies.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(40);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    expect(calls).toHaveLength(40);
  });

  it("never locks the operator out, and requests that are refused take no slot", async () => {
    const { calls, deps } = fakeDeps(null, 1);
    // None of these is a run: wrong origin, not a scenario, too large.
    await runReply(runRequest({ scenario: "D", mode: "protected" }, { origin: "http://evil.example" }), deps);
    await runReply(runRequest({ scenario: "zz", mode: "protected" }), deps);
    await runReply(runRequest({ scenario: "D", mode: "protected", pad: "x".repeat(5_000) }), deps);
    expect(calls).toHaveLength(0);

    expect((await runReply(runRequest({ scenario: "D", mode: "protected" }), deps)).status).toBe(200);
    expect((await runReply(runRequest({ scenario: "D", mode: "protected" }), deps)).status).toBe(429);
    const asOperator = await runReply(runRequest({ scenario: "D", mode: "protected" }, operatorHeaders()), deps);
    expect(asOperator.status).toBe(200);
    // A cookie that was not signed by this server is not the operator.
    const forged = await runReply(runRequest({ scenario: "D", mode: "protected" }, { cookie: "tb_operator=9999999999.00" }), deps);
    expect(forged.status).toBe(429);
  });
});

describe("what a run answers to a caller who is not the operator", () => {
  it("cuts a reply that is not the seed's fictitious tokens, for everyone but the operator", async () => {
    const { deps } = fakeDeps(REAL_LOOKING);
    const body = { scenario: "A", mode: "unprotected" };

    const anonymous = await runReply(runRequest(body), deps);
    const text = await anonymous.text();
    const run = JSON.parse(text) as DashboardRun;
    expect(anonymous.status).toBe(200);
    expect(run.leaked).toBe(true);
    expect(run.replyRedacted).toBe(true);
    expect(run.ticket.reply).toBe("NOT_THE_SEED…");
    expect(text).not.toContain(REAL_LOOKING);

    const operator = (await (await runReply(runRequest(body, operatorHeaders()), deps)).json()) as DashboardRun;
    expect(operator.ticket.reply).toBe(REAL_LOOKING);
    expect(operator.replyRedacted).toBe(false);
  });

  it("keeps the fictitious tokens of the seed readable, and never shows more than half of a short reply", () => {
    const seed = forCaller(fakeRun("A", "unprotected", SEED_REPLY), false);
    expect(seed.ticket.reply).toBe(SEED_REPLY);
    expect(seed.replyRedacted).toBe(false);

    // One real value next to a fictitious one is still a real value.
    expect(forCaller(fakeRun("A", "unprotected", `${SEED_REPLY}, ${REAL_LOOKING}`), false).ticket.reply).toBe("DEMO_ONLY_NO…");
    expect(forCaller(fakeRun("A", "unprotected", "abcdef"), false).ticket.reply).toBe("abc…");
    expect(forCaller(fakeRun("A", "unprotected", "a"), false).ticket.reply).toBe("…");

    const none = forCaller(fakeRun("A", "protected", null), false);
    expect(none.ticket.reply).toBeNull();
    expect(none.replyRedacted).toBe(false);
  });

  it("cuts the session id for everyone, the operator included", () => {
    expect(forCaller(fakeRun("C", "protected", null), false).sessionId).toBe("0b6f3c1e");
    expect(forCaller(fakeRun("C", "protected", null), true).sessionId).toBe("0b6f3c1e");
  });

  it("reads only the scenario and the mode from the body", async () => {
    const { calls, deps } = fakeDeps(null);
    const reply = await runReply(
      runRequest({ scenario: "A", mode: "unprotected", keep: true, sql: "SELECT 1", steps: [{ sql: "DROP TABLE x" }] }),
      deps,
    );
    expect(reply.status).toBe(200);
    expect(calls).toEqual([["A", "unprotected"]]);
  });
});

describe("same-origin check and body cap", () => {
  const withOrigin = (origin: string | null, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { host: HOST, ...extra };
    if (origin !== null) headers.origin = origin;
    return new Request(`${SITE}/api/breaker/run`, { method: "POST", headers });
  };

  it("compares scheme, host and port", () => {
    expect(sameOrigin(withOrigin(SITE))).toBe(true);
    expect(sameOrigin(withOrigin("https://127.0.0.1:3140"))).toBe(false);
    expect(sameOrigin(withOrigin("http://127.0.0.1:3141"))).toBe(false);
    expect(sameOrigin(withOrigin("http://127.0.0.1"))).toBe(false);
    expect(sameOrigin(withOrigin("http://evil.example"))).toBe(false);
    expect(sameOrigin(withOrigin("null"))).toBe(false);
    expect(sameOrigin(withOrigin(null))).toBe(false);
    // Behind a TLS proxy: the browser was on https, the request reached the server as http.
    expect(sameOrigin(withOrigin("https://127.0.0.1:3140", { "x-forwarded-proto": "https" }))).toBe(true);
    expect(sameOrigin(withOrigin(SITE, { "x-forwarded-proto": "https" }))).toBe(false);
  });

  it("answers 403 to an https origin on an http host before looking at the body", async () => {
    const { calls, deps } = fakeDeps(null);
    const reply = await runReply(runRequest({ scenario: "zz", mode: "protected" }, { origin: "https://127.0.0.1:3140" }), deps);
    expect(reply.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("answers 413 to a body over the cap, with or without a Content-Length", async () => {
    const { calls, deps } = fakeDeps(null);
    const big = JSON.stringify({ scenario: "A".repeat(3_000_000), mode: "protected" });
    expect((await runReply(runRequest(big, { "content-length": String(big.length) }), deps)).status).toBe(413);
    expect((await runReply(runRequest(big), deps)).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("stops reading a streamed body at the cap", async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(1_000));
      },
    });
    const request = new Request(`${SITE}/api/breaker/run`, { method: "POST", body: endless, duplex: "half" } as RequestInit);
    expect(await readBody(request, 4_096)).toBeNull();
    // 5 chunks cross the cap; the stream may have one or two more queued, never the whole body.
    expect(sent).toBeLessThan(10);

    const small = new Request(`${SITE}/api/breaker/run`, { method: "POST", body: '{"a":"ñ"}' });
    expect(await readBody(small, 4_096)).toBe('{"a":"ñ"}');
  });
});

describe("the run route against the real databases", () => {
  // Same handler, real runner; its own limiter so the test does not depend on what else ran this minute.
  const deps = () => ({
    limiter: createRunLimiter(),
    run: async (scenario: ScenarioId, mode: Mode) => {
      const run = await runScenario(scenario, mode);
      opened.push(run.sessionId);
      return run;
    },
  });

  it("scenario A still leaks unprotected and still holds protected", async () => {
    const off = (await (await runReply(runRequest({ scenario: "A", mode: "unprotected" }), deps())).json()) as DashboardRun;
    expect(off.leaked).toBe(true);
    expect(off.ticket.reply).toContain("DEMO_ONLY_NOT_A_REAL_TOKEN");
    expect(off.replyRedacted).toBe(false);
    expect(off.sessionId).toMatch(/^[0-9a-f]{8}$/);

    const reply = await runReply(runRequest({ scenario: "A", mode: "protected" }), deps());
    const on = (await reply.json()) as DashboardRun;
    expect(reply.status).toBe(200);
    expect(on.steps.map((s) => s.rule)).toEqual(["ALLOW", "R2_TRIFECTA_MIX", "R3_TAINTED_WRITE"]);
    expect(on.asExpected).toBe(true);
    expect(on.leaked).toBe(false);
    expect(on.ticket.reply).toBeNull();
    expect(on.sessionId).toMatch(/^[0-9a-f]{8}$/);
  });
});
