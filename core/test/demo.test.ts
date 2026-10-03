// The two demo routes (POST /api/demo/run and POST /api/breaker/demo): each clears the previous demo data
// and plays both halves on the server. The handlers are called directly with a Request, no Next.js server.
// Real databases. These tests DELETE demo rows on purpose: the data is synthetic.
import { afterAll, describe, expect, it } from "vitest";
import { closePools, control } from "../src/db";
import { runScenario } from "../src/runner";
import type { Mode, ScenarioId } from "../src/scenarios";
import { breakerDemoReply, clearReplaySessions, createRunLimiter, type DashboardRun } from "../../src/lib/breaker-api";
import { pool } from "../../src/lib/db";
import { demoRunReply, type Replay } from "../../src/lib/demo-api";
import { DEMO_RUNTIME } from "../../src/lib/operator";
import { runAttackReplay } from "../../src/lib/runs";

const SITE = "http://127.0.0.1:3140";
const HOST = "127.0.0.1:3140";

/** Breaker sessions opened here, removed at the end. */
const opened: string[] = [];

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { origin: SITE, host: HOST, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterAll(async () => {
  if (opened.length) await control.query("delete from breaker.sessions where id = any($1::uuid[])", [opened]);
  await closePools();
  await pool.end();
});

describe("POST /api/demo/run", () => {
  it("refuses a cross-origin request and a request over the limit before touching any data", async () => {
    const crossOrigin = await demoRunReply(post("/api/demo/run", undefined, { origin: "http://evil.example" }));
    expect(crossOrigin.status).toBe(403);
    const overLimit = await demoRunReply(post("/api/demo/run"), createRunLimiter(0));
    expect(overLimit.status).toBe(429);
    expect(await overLimit.json()).toEqual({ error: expect.any(String) });
  });

  it("deletes the earlier history and answers with both replays", async () => {
    // Some history to delete.
    const earlier = await runAttackReplay(DEMO_RUNTIME, "sandbox", 0);

    const reply = await demoRunReply(post("/api/demo/run"), createRunLimiter());
    expect(reply.status).toBe(200);
    const { off, on } = (await reply.json()) as { off: Replay; on: Replay };

    expect(off.events.map((e) => e.decision)).toEqual(["UNCHECKED", "UNCHECKED", "UNCHECKED"]);
    expect(off.events.every((e) => e.context_id === off.contextId)).toBe(true);
    expect(off.ticket.reply).toContain("DEMO_ONLY_NOT_A_REAL_TOKEN");

    expect(on.events.map((e) => e.decision)).toEqual(["ALLOWED", "DENIED", "APPROVAL_REQUIRED"]);
    expect(on.events.every((e) => e.context_id === on.contextId)).toBe(true);
    expect(on.ticket.reply).toBeNull();

    // Exactly this run's two contexts, the protected one newest.
    const contexts = await pool.query(`select id, mode from tb_contexts order by created_at`);
    expect(contexts.rows).toEqual([
      { id: off.contextId, mode: "sandbox" },
      { id: on.contextId, mode: "protected" },
    ]);
    expect(contexts.rows.map((c) => c.id)).not.toContain(earlier.contextId);
  });
});

describe("POST /api/breaker/demo", () => {
  // The real runner and the real clear; a limiter of its own so the test does not depend on what else ran this minute.
  const deps = () => ({
    limiter: createRunLimiter(),
    clear: clearReplaySessions,
    run: async (scenario: ScenarioId, mode: Mode) => {
      const run = await runScenario(scenario, mode);
      opened.push(run.sessionId);
      return run;
    },
  });

  it("answers 400 to anything that is not a scenario, 403 cross-origin, and runs nothing", async () => {
    let runs = 0;
    const counting = { ...deps(), clear: async () => void runs++, run: async () => Promise.reject(new Error(String(runs++))) };
    expect((await breakerDemoReply(post("/api/breaker/demo", { scenario: "zz" }), counting)).status).toBe(400);
    expect((await breakerDemoReply(post("/api/breaker/demo", { sql: "SELECT 1" }), counting)).status).toBe(400);
    expect((await breakerDemoReply(post("/api/breaker/demo"), counting)).status).toBe(400);
    const crossOrigin = await breakerDemoReply(post("/api/breaker/demo", { scenario: "A" }, { origin: "http://evil.example" }), counting);
    expect(crossOrigin.status).toBe(403);
    const tooLarge = await breakerDemoReply(post("/api/breaker/demo", { scenario: "A", pad: "x".repeat(5_000) }), counting);
    expect(tooLarge.status).toBe(413);
    const overLimit = await breakerDemoReply(post("/api/breaker/demo", { scenario: "A" }), { ...counting, limiter: createRunLimiter(0) });
    expect(overLimit.status).toBe(429);
    expect(runs).toBe(0);
  });

  it("clears old replay sessions only, and runs scenario A in both modes", async () => {
    const insert = (label: string) =>
      control
        .query(`insert into breaker.sessions (label, created_at) values ($1, now() - interval '1 minute') returning id`, [label])
        .then((r) => r.rows[0].id as string);
    const [oldReplay, http] = await Promise.all([insert("replay:A:protected"), insert("http")]);
    opened.push(oldReplay, http);

    // Extra keys are ignored: the statements come from the scenario, never from the request.
    const reply = await breakerDemoReply(post("/api/breaker/demo", { scenario: "A", sql: "SELECT 1", mode: "unprotected" }), deps());
    expect(reply.status).toBe(200);
    const { off, on } = (await reply.json()) as { off: DashboardRun; on: DashboardRun };

    expect(off.mode).toBe("unprotected");
    expect(off.leaked).toBe(true);
    expect(off.ticket.reply).toContain("DEMO_ONLY_NOT_A_REAL_TOKEN");
    expect(on.mode).toBe("protected");
    expect(on.steps.map((s) => s.rule)).toEqual(["ALLOW", "R2_TRIFECTA_MIX", "R3_TAINTED_WRITE"]);
    expect(on.leaked).toBe(false);
    expect(on.ticket.reply).toBeNull();
    // Never a full session id.
    for (const run of [off, on]) expect(run.sessionId).toMatch(/^[0-9a-f]{8}$/);

    const left = await control.query("select id from breaker.sessions where id = any($1::uuid[])", [[oldReplay, http]]);
    expect(left.rows.map((r) => r.id)).toEqual([http]);
  });
});
