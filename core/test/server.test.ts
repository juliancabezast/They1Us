// The HTTP API end to end (plan section 10): a real server on an ephemeral port, both real databases.
// Only sessions opened here are asserted on, and they are removed at the end.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, control } from "../src/db";
import { authorized } from "../src/http";
import { createBreakerServer } from "../src/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READ_TICKETS = "SELECT id, subject, body FROM support_tickets ORDER BY created_at DESC";
const READ_TOKENS = "SELECT service, token FROM integration_tokens";
// Not a credential: a throwaway value that exists only inside this test process.
const TEST_KEY = "demo-only-not-a-real-key";

let server: Server;
let base: string;
const opened: string[] = [];

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

async function newSession(): Promise<string> {
  const res = await post("/sessions");
  expect(res.status).toBe(201);
  const { sessionId } = (await res.json()) as { sessionId: string };
  opened.push(sessionId);
  return sessionId;
}

/** Runs `fn` with BREAKER_API_KEY set, then puts the environment back as it was. */
async function withApiKey(fn: () => Promise<void>) {
  const previous = process.env.BREAKER_API_KEY;
  process.env.BREAKER_API_KEY = TEST_KEY;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.BREAKER_API_KEY;
    else process.env.BREAKER_API_KEY = previous;
  }
}

let keyBefore: string | undefined;

beforeAll(async () => {
  // The suite describes the open API; the key is switched on only inside withApiKey.
  keyBefore = process.env.BREAKER_API_KEY;
  delete process.env.BREAKER_API_KEY;
  server = createBreakerServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (keyBefore !== undefined) process.env.BREAKER_API_KEY = keyBefore;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // Our own sessions only; their events go with them (on delete cascade).
  if (opened.length) await control.query("delete from breaker.sessions where id = any($1::uuid[])", [opened]);
  await closePools();
});

describe("routes", () => {
  it("GET /health answers 200 { ok: true }", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /sessions answers 201 with a uuid", async () => {
    const res = await post("/sessions");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toMatch(UUID);
    opened.push(body.sessionId);
  });

  it("an unknown route answers 404", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await post("/sessions/extra")).status).toBe(404);
  });

  it("a wrong method on a known route answers 405", async () => {
    const res = await fetch(`${base}/execute`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
    expect((await post("/health")).status).toBe(405);
  });
});

describe("POST /execute", () => {
  it("allows the ticket read, then denies the token read in the same session (R2)", async () => {
    const sessionId = await newSession();

    const first = await post("/execute", { sessionId, sql: READ_TICKETS });
    expect(first.status).toBe(200);
    const allow = await first.json();
    expect(allow).toMatchObject({
      ok: true,
      decision: "allow",
      rule: "ALLOW",
      flagsBefore: { hasUntrusted: false, hasSecret: false },
      flagsAfter: { hasUntrusted: true, hasSecret: false },
    });
    expect(Array.isArray(allow.rows)).toBe(true);
    expect(allow.rows.length).toBeGreaterThan(0);
    expect(allow.rows[0]).toHaveProperty("body");

    // A deny is a normal answer: 200, with the rule.
    const second = await post("/execute", { sessionId, sql: READ_TOKENS });
    expect(second.status).toBe(200);
    const deny = await second.json();
    expect(deny).toMatchObject({
      ok: false,
      decision: "deny",
      rule: "R2_TRIFECTA_MIX",
      flagsAfter: { hasUntrusted: true, hasSecret: false },
    });
    expect(deny).not.toHaveProperty("rows");
    expect(JSON.stringify(deny)).not.toContain("DEMO_ONLY");
  });

  it("a body that is not valid JSON answers 400", async () => {
    const res = await post("/execute", "{ not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect((await post("/execute")).status).toBe(400);
  });

  it("a missing or mistyped field answers 400", async () => {
    const sessionId = await newSession();
    const bodies: unknown[] = [
      {},
      { sessionId },
      { sql: "SELECT 1" },
      { sessionId, sql: "" },
      { sessionId, sql: 42 },
      { sessionId: 7, sql: "SELECT 1" },
      [sessionId, "SELECT 1"],
      "SELECT 1",
      null,
    ];
    for (const body of bodies) {
      const res = await post("/execute", JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  it("an unknown session answers 404, well formed or not", async () => {
    for (const sessionId of [randomUUID(), "not-a-uuid", "1' or '1'='1"]) {
      const res = await post("/execute", { sessionId, sql: "SELECT 1" });
      expect(res.status, sessionId).toBe(404);
      expect(await res.json()).toEqual({ error: "Unknown session" });
    }
  });

  it("a body over 100 kB answers 413, and the server keeps serving", async () => {
    const sessionId = await newSession();
    const res = await post("/execute", { sessionId, sql: `SELECT '${"x".repeat(120_000)}'` });
    expect(res.status).toBe(413);
    expect(await res.json()).toHaveProperty("error");
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("a streamed body with no declared length is cut off at 100 kB too", async () => {
    // Chunked upload: the server cannot refuse on Content-Length, it has to count what arrives.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/execute`, { method: "POST", headers: { "content-type": "application/json" } });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      for (let i = 0; i < 15; i++) req.write("x".repeat(10_000));
      req.end();
    });
    expect(status).toBe(413);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("CORS", () => {
  const preflight = (origin: string) =>
    fetch(`${base}/execute`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });

  it("a preflight from http://localhost:3000 gets the CORS headers", async () => {
    const res = await preflight("http://localhost:3000");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    const allowed = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    expect(allowed).toContain("content-type");
    expect(allowed).toContain("authorization");
  });

  it("a preflight from another origin gets none", async () => {
    const res = await preflight("http://evil.example");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("the actual answer names the allowed origin, and only that one", async () => {
    const ok = await fetch(`${base}/health`, { headers: { origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const evil = await fetch(`${base}/health`, { headers: { origin: "http://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("BREAKER_CORS_ORIGINS adds origins", async () => {
    const previous = process.env.BREAKER_CORS_ORIGINS;
    process.env.BREAKER_CORS_ORIGINS = "https://victim.example, http://localhost:3001";
    try {
      for (const origin of ["https://victim.example", "http://localhost:3001", "http://localhost:3000"]) {
        expect((await preflight(origin)).headers.get("access-control-allow-origin"), origin).toBe(origin);
      }
      expect((await preflight("http://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.BREAKER_CORS_ORIGINS;
      else process.env.BREAKER_CORS_ORIGINS = previous;
    }
  });
});

describe("BREAKER_API_KEY", () => {
  it("authorized() is open without a key and exact with one", async () => {
    expect(authorized(undefined)).toBe(true);
    await withApiKey(async () => {
      expect(authorized(undefined)).toBe(false);
      expect(authorized(null)).toBe(false);
      expect(authorized("")).toBe(false);
      expect(authorized(TEST_KEY)).toBe(false);
      expect(authorized(`Bearer ${TEST_KEY}x`)).toBe(false);
      expect(authorized(`Bearer ${TEST_KEY}`)).toBe(true);
    });
  });

  it("when set, POST routes need the header and GET /health stays open", async () => {
    await withApiKey(async () => {
      const bare = await post("/sessions");
      expect(bare.status).toBe(401);
      expect(await bare.json()).toHaveProperty("error");
      expect((await post("/sessions", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
      expect((await post("/execute", { sessionId: randomUUID(), sql: "SELECT 1" })).status).toBe(401);

      expect((await fetch(`${base}/health`)).status).toBe(200);

      const auth = { authorization: `Bearer ${TEST_KEY}` };
      const res = await post("/sessions", undefined, auth);
      expect(res.status).toBe(201);
      const { sessionId } = (await res.json()) as { sessionId: string };
      expect(sessionId).toMatch(UUID);
      opened.push(sessionId);

      // Past the key, the request is judged like any other: an unknown session is still 404.
      expect((await post("/execute", { sessionId: randomUUID(), sql: "SELECT 1" }, auth)).status).toBe(404);
    });
  });
});
