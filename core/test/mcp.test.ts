// The MCP server end to end (plan section 13): a real Breaker API on an ephemeral port, the MCP server
// spawned as its own process over stdio, driven by the SDK client the way an agent host would.
// Only the session this file opens is asserted on, and it is removed at the end.
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, control } from "../src/db";
import { createBreakerServer } from "../src/server";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READ_TICKETS = "SELECT id, subject, body FROM support_tickets ORDER BY created_at DESC";
const READ_TOKENS = "SELECT service, token FROM integration_tokens";
// Not a credential: a throwaway value that exists only inside this test and the process it spawns.
const TEST_KEY = "demo-only-not-a-real-key";

type Called = { isError: boolean; text: string };

let server: Server;
let base: string;
let keyBefore: string | undefined;
let sessionId: string | null = null;
const clients: Client[] = [];
const stderr: string[] = [];

/**
 * Spawns the MCP server pointed at `breakerUrl`. Its environment is PATH, HOME and the like plus the two
 * Breaker variables: no connection string reaches the agent side, and it works anyway.
 */
async function connect(breakerUrl: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "core/src/mcp.ts"],
    cwd: REPO,
    env: { ...getDefaultEnvironment(), BREAKER_URL: breakerUrl, BREAKER_API_KEY: TEST_KEY },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe("text");
  return { isError: result.isError === true, text: content[0].text ?? "" };
}

let mcp: Client;

beforeAll(async () => {
  // The Breaker runs with a key here, so the Authorization header the MCP server sends is exercised too.
  keyBefore = process.env.BREAKER_API_KEY;
  process.env.BREAKER_API_KEY = TEST_KEY;
  server = createBreakerServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mcp = await connect(base);
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  if (keyBefore === undefined) delete process.env.BREAKER_API_KEY;
  else process.env.BREAKER_API_KEY = keyBefore;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // Our own session only; its events go with it (on delete cascade).
  if (sessionId) await control.query("delete from breaker.sessions where id = $1::uuid", [sessionId]);
  await closePools();
});

describe("the agent side", () => {
  it("holds no database access: mcp.ts imports nothing that opens a connection", () => {
    const source = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toContain("./types");
    for (const forbidden of ["./db", "./breaker", "./session", "./labels", "./analyzer", "./http", "./server", "pg"]) {
      expect(imports, forbidden).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/DATABASE_URL/);
    expect(source).not.toMatch(/console\.log\(/);
  });
});

describe("tools", () => {
  it("lists execute_sql and session_status, and the description says what is enforced", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["execute_sql", "session_status"]);

    const execute = tools.find((tool) => tool.name === "execute_sql")!;
    expect(execute.inputSchema.required).toEqual(["sql"]);
    expect(execute.inputSchema.properties).toHaveProperty("sql");
    for (const said of [
      "R2_TRIFECTA_MIX",
      "never hold both untrusted",
      "R3_TAINTED_WRITE",
      "read untrusted data cannot write",
      "R5_UNLISTED_FUNCTION",
      "allowlist",
    ]) {
      expect(execute.description, said).toContain(said);
    }
  });

  it("session_status says no session was opened before the first statement", async () => {
    const status = await call(mcp, "session_status");
    expect(status.isError).toBe(false);
    expect(JSON.parse(status.text).sessionId).toBeNull();
  });

  it("execute_sql reads the tickets: allowed, with rows", async () => {
    const reply = await call(mcp, "execute_sql", { sql: READ_TICKETS });
    expect(reply.isError).toBe(false);
    const result = JSON.parse(reply.text);
    expect(result).toMatchObject({
      ok: true,
      decision: "allow",
      rule: "ALLOW",
      stoppedAt: null,
      flagsBefore: { hasUntrusted: false, hasSecret: false },
      flagsAfter: { hasUntrusted: true, hasSecret: false },
    });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]).toHaveProperty("body");
    expect(result.rowCount).toBeGreaterThanOrEqual(result.rows.length);
  });

  it("session_status now names the session, and the Breaker knows it", async () => {
    const status = JSON.parse((await call(mcp, "session_status")).text);
    expect(status.sessionId).toMatch(UUID);
    expect(status.flags).toEqual({ hasUntrusted: true, hasSecret: false });
    sessionId = status.sessionId;

    const { rows } = await control.query("select has_untrusted, has_secret from breaker.sessions where id = $1::uuid", [
      sessionId,
    ]);
    expect(rows).toEqual([{ has_untrusted: true, has_secret: false }]);
  });

  it("execute_sql then reads the tokens: denied with R2_TRIFECTA_MIX, as an error the agent can read", async () => {
    const reply = await call(mcp, "execute_sql", { sql: READ_TOKENS });
    expect(reply.isError).toBe(true);
    const result = JSON.parse(reply.text);
    expect(result).toMatchObject({
      ok: false,
      decision: "deny",
      rule: "R2_TRIFECTA_MIX",
      stoppedAt: "policy",
      flagsAfter: { hasUntrusted: true, hasSecret: false },
    });
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("rows");
    expect(reply.text).not.toContain("DEMO_ONLY");
  });

  it("a write in the same conversation is denied with R3_TAINTED_WRITE", async () => {
    // Denied before it runs: no row is touched (id 0 does not exist either).
    const reply = await call(mcp, "execute_sql", { sql: "UPDATE support_tickets SET reply = 'x' WHERE id = 0" });
    expect(reply.isError).toBe(true);
    expect(JSON.parse(reply.text)).toMatchObject({ ok: false, decision: "deny", rule: "R3_TAINTED_WRITE" });
  });

  it("the whole conversation was one session: three statements, three events, one POST /sessions", async () => {
    expect(JSON.parse((await call(mcp, "session_status")).text).sessionId).toBe(sessionId);
    const { rows } = await control.query(
      "select decision, rule from breaker.events where session_id = $1::uuid order by id",
      [sessionId],
    );
    expect(rows).toEqual([
      { decision: "allow", rule: "ALLOW" },
      { decision: "deny", rule: "R2_TRIFECTA_MIX" },
      { decision: "deny", rule: "R3_TAINTED_WRITE" },
    ]);
  });

  it("an empty statement is refused by the tool's own schema, without calling the Breaker", async () => {
    const reply = await call(mcp, "execute_sql", { sql: "" });
    expect(reply.isError).toBe(true);
    const { rows } = await control.query("select count(*)::int as n from breaker.events where session_id = $1::uuid", [
      sessionId,
    ]);
    expect(rows[0].n).toBe(3);
  });

  it("writes nothing but protocol messages to stdout", () => {
    // A stray console.log would have broken the JSON-RPC stream and failed the calls above; the
    // diagnostics that did come out went to stderr.
    expect(stderr.join("")).toContain("[breaker-mcp]");
  });
});

describe("when the Breaker cannot be reached", () => {
  it("execute_sql answers a clear text error and no session is opened", async () => {
    // A port that was just free: nothing listens there.
    const closed = createBreakerServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const lonely = await connect(`http://127.0.0.1:${port}`);
    const reply = await call(lonely, "execute_sql", { sql: READ_TICKETS });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("cannot be reached");
    expect(reply.text).toContain(`http://127.0.0.1:${port}`);
    expect(JSON.parse((await call(lonely, "session_status")).text).sessionId).toBeNull();
  });
});
