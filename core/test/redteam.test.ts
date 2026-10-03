// Regression tests for what the red team reproduced. Both real databases; only sessions and tickets
// opened here are asserted on, and they are removed at the end.
import { randomUUID } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyze, precheck } from "../src/analyzer";
import { BUSY, MAX_REPLY_BYTES, NOT_LOGGED, guardedExecute } from "../src/breaker";
import { CUSTOMER_SCHEMA, closePools, control, customer } from "../src/db";
import { getLabels } from "../src/labels";
import { maskLiterals, sha256 } from "../src/mask";
import { decide } from "../src/policy";
import { createBreakerServer } from "../src/server";
import { createSession, getFlags } from "../src/session";
import { ROW_CAP } from "../src/types";
import type { Flags, LabelRow, QueryFacts } from "../src/types";

const TICKETS = `${CUSTOMER_SCHEMA}.support_tickets`;
// Every ticket this file may create carries this address, so the cleanup can only remove our own.
const OUR_EMAIL = `redteam-${randomUUID()}@example.test`;
const TOKEN_PREFIX = "DEMO_ONLY_NOT_A_REAL_TOKEN";

const CLEAN: Flags = { hasUntrusted: false, hasSecret: false };
const UNTRUSTED: Flags = { hasUntrusted: true, hasSecret: false };
const SECRET: Flags = { hasUntrusted: false, hasSecret: true };

const opened: string[] = [];
let labels: LabelRow[];

async function newSession(): Promise<string> {
  const id = await createSession("test:redteam");
  opened.push(id);
  return id;
}

type EventRow = { sql: string; sql_sha256: string; rule: string; reason: string; decision: string };
const eventsOf = async (sessionId: string): Promise<EventRow[]> =>
  (await control.query<EventRow>("select * from breaker.events where session_id = $1 order by id", [sessionId])).rows;

const ourTickets = async () =>
  (await customer.query<{ reply: string | null; body: string }>(`select reply, body from ${TICKETS} where customer_email = $1`, [OUR_EMAIL]))
    .rows;

function facts(overrides: Partial<QueryFacts> = {}): QueryFacts {
  return {
    explainable: true,
    relations: [],
    touchesBreakerSchema: false,
    touchesUntrusted: false,
    touchesSecret: false,
    writesUntrusted: false,
    isWrite: false,
    hasOpaqueNode: false,
    unlistedFunctions: [],
    ...overrides,
  };
}

beforeAll(async () => {
  labels = await getLabels();
});

afterAll(async () => {
  await customer.query(`delete from ${TICKETS} where customer_email = $1`, [OUR_EMAIL]);
  if (opened.length) await control.query("delete from breaker.sessions where id = any($1::uuid[])", [opened]);
  await closePools();
});

describe("a secret cannot be written where outsiders reach (R6)", () => {
  const SINK_WRITE = facts({ isWrite: true, writesUntrusted: true });

  it("policy: a session that holds a secret cannot write into a table with untrusted columns", () => {
    expect(decide(SECRET, SINK_WRITE)).toMatchObject({ decision: "deny", rule: "R6_SECRET_SINK", flagsAfter: SECRET });
    // The same in one statement: the read that stamps the session and the write.
    expect(decide(CLEAN, facts({ isWrite: true, writesUntrusted: true, touchesSecret: true }))).toMatchObject({
      decision: "deny",
      rule: "R6_SECRET_SINK",
      flagsAfter: CLEAN,
    });
  });

  it("policy: the plan's truth table is unchanged around it", () => {
    // Row 9: a clean session may file a ticket. Row 10: a secret session may write an unlabeled table.
    expect(decide(CLEAN, SINK_WRITE)).toMatchObject({ rule: "ALLOW", flagsAfter: CLEAN });
    expect(decide(SECRET, facts({ isWrite: true }))).toMatchObject({ rule: "ALLOW", flagsAfter: SECRET });
    // R2 and R3 keep their place in front of it.
    expect(decide(SECRET, facts({ isWrite: true, writesUntrusted: true, touchesUntrusted: true })).rule).toBe("R2_TRIFECTA_MIX");
    expect(decide(UNTRUSTED, SINK_WRITE).rule).toBe("R3_TAINTED_WRITE");
  });

  it("INSERT ... SELECT token into a ticket is denied in a fresh session, and nothing is written", async () => {
    const session = await newSession();
    const r = await guardedExecute(
      session,
      `INSERT INTO support_tickets (customer_email, subject, body, reply) SELECT '${OUR_EMAIL}', 'x', 'y', token FROM integration_tokens`,
    );
    expect(r).toMatchObject({ ok: false, decision: "deny", rule: "R6_SECRET_SINK", stoppedAt: "policy" });
    expect(await getFlags(session)).toEqual(CLEAN);
    expect(await ourTickets()).toHaveLength(0);

    // The form the red team sent over HTTP: the tokens aggregated into the body.
    const agg = await guardedExecute(
      session,
      `INSERT INTO support_tickets (customer_email, subject, body) SELECT '${OUR_EMAIL}', 'x', string_agg(token, ', ') FROM integration_tokens`,
    );
    expect(agg).toMatchObject({ decision: "deny", rule: "R6_SECRET_SINK" });
    expect(await ourTickets()).toHaveLength(0);
  });

  it("reading the tokens and then inserting a literal into a ticket is denied too", async () => {
    const session = await newSession();
    expect(await guardedExecute(session, "SELECT token FROM integration_tokens")).toMatchObject({ decision: "allow" });
    const r = await guardedExecute(
      session,
      `INSERT INTO support_tickets (customer_email, subject, body, reply) VALUES ('${OUR_EMAIL}', 'leak', 'leak', 'what the agent read')`,
    );
    expect(r).toMatchObject({ ok: false, decision: "deny", rule: "R6_SECRET_SINK" });
    expect(await ourTickets()).toHaveLength(0);
    // Nothing else changed for that session: it still works with what it holds.
    expect(await guardedExecute(session, "SELECT count(*) FROM customers")).toMatchObject({ decision: "allow" });
  });

  it("a clean session can still file a ticket, and the UPDATE form is still R2", async () => {
    const session = await newSession();
    const filed = await guardedExecute(
      session,
      `INSERT INTO support_tickets (customer_email, subject, body) VALUES ('${OUR_EMAIL}', 'hello', 'a normal ticket')`,
    );
    expect(filed).toMatchObject({ ok: true, decision: "allow", flagsAfter: CLEAN });
    const tickets = await ourTickets();
    expect(tickets).toHaveLength(1);

    const update = await guardedExecute(
      await newSession(),
      `UPDATE support_tickets SET reply = (SELECT token FROM integration_tokens LIMIT 1) WHERE customer_email = '${OUR_EMAIL}'`,
    );
    expect(update).toMatchObject({ decision: "deny", rule: "R2_TRIFECTA_MIX" });
    expect((await ourTickets())[0].reply).toBeNull();
    expect(JSON.stringify(await ourTickets())).not.toContain(TOKEN_PREFIX);
  });
});

describe("the literal scanner reads names the way Postgres does", () => {
  it("é$$ is an identifier, not the start of a dollar quote", () => {
    expect(maskLiterals("SELECT service AS é$$ FROM integration_tokens -- $$")).toBe(
      "SELECT service AS é$$ FROM integration_tokens --…",
    );
    expect(maskLiterals("SELECT 1 AS é$$, $$CANARY_dq$$")).toBe("SELECT 1 AS é$$, $$…$$");
    // An E after a non-ASCII letter is part of the name, so the backslash does not escape the quote.
    expect(maskLiterals("SELECT éE'a\\', 'CANARY'")).toBe("SELECT éE'…', '…'");
    expect(maskLiterals("SELECT E'a\\'CANARY' AS x")).toBe("SELECT E'…' AS x");
  });

  it("the log shows the whole statement, and never the literal", async () => {
    const one = await newSession();
    const first = await guardedExecute(one, "SELECT service AS é$$ FROM integration_tokens -- $$");
    expect(first).toMatchObject({ decision: "allow", flagsAfter: SECRET });
    expect((await eventsOf(one))[0].sql).toBe("SELECT service AS é$$ FROM integration_tokens --…");

    const two = await newSession();
    const canary = `CANARY_${randomUUID().replace(/-/g, "")}`;
    expect(await guardedExecute(two, `SELECT 1 AS é$$, $$${canary}$$`)).toMatchObject({ decision: "allow" });
    const events = await eventsOf(two);
    expect(events[0].sql).toBe("SELECT 1 AS é$$, $$…$$");
    expect(JSON.stringify(events)).not.toContain(canary);
  });

  it("the breaker schema is still seen after such a name", async () => {
    const f = await analyze("SELECT has_secret AS é$$ FROM breaker.sessions -- $$", labels);
    expect(f).toMatchObject({ explainable: true, touchesBreakerSchema: true });
  });
});

describe("labels fail closed", () => {
  const wrongSchema = () => labels.map((l) => ({ ...l, table_schema: "some_other_schema" }));

  it("analyze refuses every statement when no label exists for the customer schema", async () => {
    for (const set of [[], wrongSchema()]) {
      for (const sql of ["SELECT body FROM support_tickets", "SELECT token FROM integration_tokens"]) {
        const f = await analyze(sql, set);
        expect(f).toMatchObject({ explainable: false, failedAt: "precheck" });
        expect(decide(CLEAN, f)).toMatchObject({ decision: "deny", rule: "R0_OPAQUE_STATEMENT", flagsAfter: CLEAN });
      }
    }
  });

  it("an empty or wrong-schema label table is not loaded and not cached", async () => {
    for (const rows of [[], wrongSchema()]) {
      // A fresh copy of the module (no cache), with the Breaker DB answering `rows`. The pools live on globalThis.
      vi.resetModules();
      const spy = vi.spyOn(control, "query").mockResolvedValue({ rows } as never);
      try {
        const fresh = await import("../src/labels");
        await expect(fresh.getLabels()).rejects.toThrow(/no label for schema/);
        await expect(fresh.getLabels()).rejects.toThrow(/could not be loaded/);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    }
  });
});

describe("a NUL character", () => {
  it("is refused at the precheck", () => {
    expect(precheck("SELECT 1\u0000")).toEqual({ ok: false, reason: "invalid character" });
    expect(precheck("SELECT 1 AS a\u0000, token FROM integration_tokens")).toMatchObject({ ok: false });
  });

  it("is a logged deny, wherever it sits, and the session stays clean", async () => {
    const session = await newSession();
    const statements = ["SELECT 1\u0000", "SELECT 1 AS a\u0000, token FROM integration_tokens", "SELECT 1 /* \u0000 */", "SELECT '\u0000'"];
    for (const sql of statements) {
      expect(await guardedExecute(session, sql), JSON.stringify(sql)).toMatchObject({
        ok: false,
        decision: "deny",
        rule: "R0_OPAQUE_STATEMENT",
        stoppedAt: "precheck",
      });
    }
    const events = await eventsOf(session);
    expect(events).toHaveLength(statements.length);
    expect(events.map((e) => e.sql_sha256)).toEqual(statements.map(sha256));
    expect(JSON.stringify(events)).not.toContain("\\u0000");
    expect(await getFlags(session)).toEqual(CLEAN);
  });
});

describe("the log of a session that holds a secret", () => {
  it("carries no text the agent chose: not a name, a number, a function name or a planner message", async () => {
    const session = await newSession();
    expect(await guardedExecute(session, "SELECT service, token FROM integration_tokens")).toMatchObject({
      decision: "allow",
      flagsAfter: SECRET,
    });
    const canary = `canary_${randomUUID().replace(/-/g, "")}`;
    const digits = String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
    const statements = [
      `SELECT 1 AS "${canary}", ${digits} AS n`, // quoted name and a number
      `SELECT 1 AS ${canary}`, // bare alias
      `SELECT ${canary}('x')`, // unknown function: the planner message names it
      `SELECT * FROM ${canary}`, // unknown relation
      `SELECT 1$$${canary}$$`, // where the scanner and Postgres may disagree
      `SELECT $e'a\\'${canary}'`,
      `SELECT '${canary}' AS x`,
    ];
    for (const sql of statements) await guardedExecute(session, sql);

    const events = await eventsOf(session);
    expect(events).toHaveLength(statements.length + 1);
    // The statement that first read the secret was written before the agent had it: logged as usual.
    expect(events[0].sql).toBe("SELECT service, token FROM integration_tokens");
    const later = events.slice(1);
    expect(later.every((e) => e.sql === NOT_LOGGED)).toBe(true);
    expect(later.map((e) => e.sql_sha256)).toEqual(statements.map(sha256));
    const dump = JSON.stringify(events).toLowerCase();
    expect(dump).not.toContain(canary);
    expect(dump).not.toContain(digits);
    // The agent still gets the planner's message; only the log copy is the rule's fixed sentence.
    expect(later[2]).toMatchObject({ rule: "R0_OPAQUE_STATEMENT", reason: "The statement could not be analyzed, so it is refused." });
  });
});

describe("a reply is bounded", () => {
  it("a read that would produce 100 million rows stops at the cap instead of running out the clock", async () => {
    const session = await newSession();
    const r = await guardedExecute(session, "SELECT generate_series(1, 100000000) AS n");
    if (!r.ok) throw new Error(`expected rows, got ${r.rule} ${"errorCode" in r ? r.errorCode : ""}`);
    expect(r.rows).toHaveLength(ROW_CAP);
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBe(ROW_CAP + 1);
  });

  it("the cap does not change what ordinary statements return", async () => {
    const session = await newSession();
    const plain = await guardedExecute(session, "SELECT id, name FROM customers ORDER BY id -- newest last");
    const cte = await guardedExecute(session, "WITH c AS (SELECT id, name FROM customers) SELECT * FROM c ORDER BY id;");
    if (!plain.ok || !cte.ok) throw new Error("expected rows");
    expect(plain.truncated).toBe(false);
    expect(plain.rows.length).toBeGreaterThanOrEqual(3);
    expect(cte.rows).toEqual(plain.rows);
    expect(Object.keys(plain.rows[0] as object)).toEqual(["id", "name"]);
  });

  it("one enormous row is dropped: the reply stays under the byte limit", async () => {
    const session = await newSession();
    // About 1.6 MB in a single row (the seed's customer names repeated 200 000 times).
    const r = await guardedExecute(session, "SELECT string_agg(c.name, '') AS s FROM customers c, generate_series(1, 200000)");
    if (!r.ok) throw new Error(`expected an allow with rows, got ${r.rule}`);
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(MAX_REPLY_BYTES);
  });
});

describe("one session cannot stall the others", () => {
  it("a burst on one session is refused past its queue, and what was admitted is answered", async () => {
    const session = await newSession();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => guardedExecute(session, "SELECT 1 AS one")));
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
    expect(refused).toHaveLength(4);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ message: BUSY });
    // Refused before anything was decided: no event for them.
    expect(await eventsOf(session)).toHaveLength(8);
  });

  it("while one session runs slow statements, another session and POST /sessions answer at once", async () => {
    const attacker = await newSession();
    const victim = await newSession();
    await guardedExecute(victim, "SELECT 1 AS warm");
    // Allowed in a clean session; each runs until the 5 s statement timeout.
    const slow = "SELECT count(*) FROM generate_series(1, 2000000000)";
    const attack = Promise.all([1, 2, 3].map(() => guardedExecute(attacker, slow)));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const started = Date.now();
    const [answer, created] = await Promise.all([
      guardedExecute(victim, "SELECT name FROM customers LIMIT 1"),
      createSession("test:redteam"),
    ]);
    const waited = Date.now() - started;
    opened.push(created);
    expect(answer).toMatchObject({ ok: true, decision: "allow" });
    // Before the fix both waited about 5 s for the slow statements to time out.
    expect(waited).toBeLessThan(2500);

    for (const r of await attack) expect(r).toMatchObject({ ok: false, decision: "allow", errorCode: "57014" });
  }, 60_000);
});

describe("the HTTP API refuses requests a web page can forge", () => {
  let server: Server;
  let port: number;

  /** node:http, because fetch does not let a caller choose the Host header. */
  const call = (method: string, path: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body);
    });

  beforeAll(async () => {
    server = createBreakerServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("an Origin that is not on the list gets 403 on every route and method", async () => {
    const evil = { origin: "https://evil.example", "content-type": "text/plain" };
    const session = await newSession();
    const body = JSON.stringify({ sessionId: session, sql: "SELECT count(*) FROM customers" });
    expect((await call("POST", "/sessions", evil)).status).toBe(403);
    expect((await call("POST", "/execute", evil, body)).status).toBe(403);
    expect((await call("POST", "/execute", { ...evil, "content-type": "application/json" }, body)).status).toBe(403);
    expect((await call("OPTIONS", "/execute", { ...evil, "access-control-request-method": "POST" })).status).toBe(403);
    expect((await call("GET", "/health", { origin: "null" })).status).toBe(403);
    // Nothing was analyzed for that session.
    expect(await eventsOf(session)).toHaveLength(0);
  });

  it("a refused Origin is answered before a session is opened", async () => {
    const res = await call("POST", "/sessions", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ error: "Origin not allowed" });
  });

  it("a Host that is not this server gets 421, also with a matching Origin (DNS rebinding)", async () => {
    const rebound = { host: `evil.example:${port}`, origin: `http://evil.example:${port}` };
    const res = await call("POST", "/sessions", rebound);
    expect(res.status).toBe(421);
    expect(res.text).not.toContain("sessionId");
    expect((await call("GET", "/health", { host: "evil.example" })).status).toBe(421);
    expect((await call("GET", "/health", { host: `localhost:${port}` })).status).toBe(200);
  });

  it("BREAKER_ALLOWED_HOSTS adds names", async () => {
    process.env.BREAKER_ALLOWED_HOSTS = "breaker.internal.example";
    try {
      expect((await call("GET", "/health", { host: `breaker.internal.example:${port}` })).status).toBe(200);
      expect((await call("GET", "/health", { host: "evil.example" })).status).toBe(421);
    } finally {
      delete process.env.BREAKER_ALLOWED_HOSTS;
    }
  });

  it("POST /execute takes application/json only", async () => {
    const session = await newSession();
    const body = JSON.stringify({ sessionId: session, sql: "SELECT count(*) FROM customers" });
    expect((await call("POST", "/execute", { "content-type": "text/plain" }, body)).status).toBe(415);
    expect((await call("POST", "/execute", { "content-type": "application/x-www-form-urlencoded" }, body)).status).toBe(415);
    expect((await call("POST", "/execute", {}, body)).status).toBe(415);
    expect(await eventsOf(session)).toHaveLength(0);

    const ok = await call("POST", "/execute", { "content-type": "application/json; charset=utf-8" }, body);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({ decision: "allow" });
  });

  it("the allowed origin and callers without an Origin still work", async () => {
    const fromApp = await call("POST", "/sessions", { origin: "http://localhost:3000" });
    expect(fromApp.status).toBe(201);
    expect(fromApp.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    opened.push(JSON.parse(fromApp.text).sessionId);

    const curl = await call("POST", "/sessions", {});
    expect(curl.status).toBe(201);
    opened.push(JSON.parse(curl.text).sessionId);
  });
});
