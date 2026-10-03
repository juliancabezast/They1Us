// The analyzer against the real Customer DB. EXPLAIN only: nothing here executes a statement,
// so no row is read, written or left behind.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze, precheck } from "../src/analyzer";
import { closePools, CUSTOMER_SCHEMA } from "../src/db";
import { getLabels, reloadLabels } from "../src/labels";
import { SCENARIOS } from "../src/scenarios";
import type { LabelRow, QueryFacts } from "../src/types";

let labels: LabelRow[] = [];
const facts = (sql: string): Promise<QueryFacts> => analyze(sql, labels);

/** The statement a scenario step sends, built as the scripted agent would. */
const step = (id: keyof typeof SCENARIOS, n: number) => SCENARIOS[id].steps[n - 1].build({ ticketId: 1, token: null });

const tickets = { schema: CUSTOMER_SCHEMA, name: "support_tickets" };
const tokens = { schema: CUSTOMER_SCHEMA, name: "integration_tokens" };
const customers = { schema: CUSTOMER_SCHEMA, name: "customers" };

/** Everything false and empty: what a statement must look like when nothing about it is remarkable. */
const clean = {
  explainable: true,
  touchesBreakerSchema: false,
  touchesUntrusted: false,
  touchesSecret: false,
  writesUntrusted: false,
  isWrite: false,
  hasOpaqueNode: false,
  unlistedFunctions: [],
};

// Naming the breaker schema is refused on the text alone, before EXPLAIN is asked.
const protectedObject = { ...clean, relations: [], touchesBreakerSchema: true, failedAt: "precheck" };

beforeAll(async () => {
  labels = await getLabels();
});

afterAll(async () => {
  await closePools();
});

describe("precheck", () => {
  const ok = (sql: string) => precheck(sql).ok;

  it("accepts one statement and drops one trailing semicolon", () => {
    expect(precheck("SELECT 1;")).toEqual({ ok: true, sql: "SELECT 1" });
    expect(precheck("SELECT 1 ; ")).toEqual({ ok: true, sql: "SELECT 1" });
  });

  it("accepts lower case and leading whitespace", () => {
    expect(precheck("  \n\tselect 1")).toEqual({ ok: true, sql: "select 1" });
    for (const sql of ["with x as (select 1) select * from x", "insert into t values (1)", "Update t set a = 1", "delete from t"]) {
      expect(ok(sql), sql).toBe(true);
    }
  });

  it("refuses a second statement", () => {
    expect(precheck("SELECT 1; DROP TABLE support_tickets")).toEqual({ ok: false, reason: "multiple statements" });
    expect(ok("SELECT 1;;")).toBe(false);
  });

  it("refuses a semicolon inside a string literal: fail closed", () => {
    expect(ok("SELECT 'a;b'")).toBe(false);
  });

  it.each(["DROP", "CREATE", "COPY", "SET", "DO", "CALL", "EXPLAIN", "TRUNCATE", "GRANT"])("refuses %s", (keyword) => {
    expect(ok(`${keyword} something`)).toBe(false);
    expect(ok(`${keyword.toLowerCase()} something`)).toBe(false);
  });

  it("refuses anything that does not start with the keyword itself", () => {
    expect(ok("-- hello\nSELECT 1")).toBe(false);
    expect(ok("/* hello */ SELECT 1")).toBe(false);
    expect(ok("(SELECT 1)")).toBe(false);
    expect(ok("SELECTED 1")).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok(";")).toBe(false);
  });
});

describe("labels", () => {
  it("loads the demo sticker list from the Breaker DB", async () => {
    const of = (label: string) => labels.filter((l) => l.table_schema === CUSTOMER_SCHEMA && l.label === label);
    expect(of("secret").map((l) => `${l.table_name}.${l.column_name}`)).toContain("integration_tokens.token");
    expect(of("untrusted").map((l) => `${l.table_name}.${l.column_name}`)).toEqual(
      expect.arrayContaining(["support_tickets.body", "support_tickets.subject", "support_tickets.customer_email"]),
    );
  });

  it("serves the cache until reloaded", async () => {
    expect(await getLabels()).toBe(labels);
    expect(await reloadLabels()).toEqual(labels);
  });
});

describe("scenario statements", () => {
  it("A1 reads untrusted", async () => {
    expect(await facts(step("A", 1))).toEqual({
      ...clean,
      relations: [{ ...tickets, scanned: true, written: false }],
      touchesUntrusted: true,
    });
  });

  it("A2 reads secret", async () => {
    expect(await facts(step("A", 2))).toEqual({
      ...clean,
      relations: [{ ...tokens, scanned: true, written: false }],
      touchesSecret: true,
    });
  });

  it("A3 is a write that also reads untrusted: UPDATE scans its target", async () => {
    expect(await facts(step("A", 3))).toEqual({
      ...clean,
      relations: [{ ...tickets, scanned: true, written: true }],
      writesUntrusted: true,
      touchesUntrusted: true,
      isWrite: true,
    });
  });

  it("B is the same two reads in the other order", async () => {
    expect(await facts(step("B", 1))).toMatchObject({ ...clean, touchesSecret: true });
    expect(await facts(step("B", 2))).toMatchObject({ ...clean, touchesUntrusted: true });
  });

  it("C never touches a secret", async () => {
    for (const n of [1, 2]) expect(await facts(step("C", n))).toMatchObject({ ...clean, touchesUntrusted: true });
    expect(await facts(step("C", 3))).toEqual({ ...clean, relations: [{ ...customers, scanned: true, written: false }] });
  });

  it("D reads both labels in one statement", async () => {
    const f = await facts(step("D", 1));
    expect(f).toMatchObject({ ...clean, touchesUntrusted: true, touchesSecret: true });
    expect(f.relations).toHaveLength(2);
    expect(f.relations).toEqual(
      expect.arrayContaining([
        { ...tickets, scanned: true, written: false },
        { ...tokens, scanned: true, written: false },
      ]),
    );
  });

  it("E is not explainable, and stops at the precheck", async () => {
    expect(await facts(step("E", 1))).toEqual({
      ...clean,
      relations: [],
      explainable: false,
      failedAt: "precheck",
      opaqueReason: "multiple statements",
    });
  });

  it("F is a protected object", async () => {
    expect(await facts(step("F", 1))).toEqual(protectedObject);
  });
});

describe("reads and writes", () => {
  it("a count over an unlabeled table is clean", async () => {
    expect(await facts("SELECT count(*) FROM customers")).toEqual({
      ...clean,
      relations: [{ ...customers, scanned: true, written: false }],
    });
  });

  it("INSERT ... VALUES writes its target without reading it", async () => {
    const f = await facts("INSERT INTO support_tickets (customer_email, subject, body) VALUES ('a@example.com', 's', 'b')");
    expect(f).toEqual({
      ...clean,
      relations: [{ ...tickets, scanned: false, written: true }],
      // Not read, but written: the target is a table outsiders reach.
      writesUntrusted: true,
      isWrite: true,
    });
  });

  it("INSERT ... RETURNING reads its target", async () => {
    const f = await facts(
      "INSERT INTO support_tickets (customer_email, subject, body) VALUES ('a@example.com', 's', 'b') RETURNING *",
    );
    expect(f).toEqual({
      ...clean,
      relations: [{ ...tickets, scanned: true, written: true }],
      writesUntrusted: true,
      touchesUntrusted: true,
      isWrite: true,
    });
  });

  it("INSERT ... ON CONFLICT DO UPDATE reads its target", async () => {
    const upsert =
      "INSERT INTO support_tickets (id, customer_email, subject, body) VALUES (1, 'a@example.com', 's', 'b') ON CONFLICT (id) DO UPDATE SET reply = excluded.body";
    for (const sql of [upsert, `${upsert} RETURNING *`]) {
      expect(await facts(sql), sql).toMatchObject({
        ...clean,
        relations: [{ ...tickets, scanned: true, written: true }],
        writesUntrusted: true,
        touchesUntrusted: true,
        isWrite: true,
      });
    }
  });

  it("a data-modifying CTE is a write", async () => {
    const f = await facts("WITH x AS (DELETE FROM support_tickets WHERE id = -1 RETURNING *) SELECT * FROM x");
    expect(f).toEqual({
      ...clean,
      relations: [{ ...tickets, scanned: true, written: true }],
      writesUntrusted: true,
      touchesUntrusted: true,
      isWrite: true,
    });
  });

  it("SELECT ... INTO is refused: EXPLAIN plans it as a plain read", async () => {
    expect(await facts("SELECT name INTO TEMP copy_of_customers FROM customers")).toMatchObject({
      explainable: false,
      failedAt: "precheck",
    });
    // The word inside a literal or a quoted identifier is not the keyword.
    expect(await facts(`SELECT 'put it into the reply' AS "into" FROM customers`)).toMatchObject(clean);
  });
});

describe("functions", () => {
  it("reports query_to_xml, which reads a table without any scan in the plan", async () => {
    const f = await facts("SELECT query_to_xml('select token from integration_tokens', true, true, '')");
    expect(f).toEqual({ ...clean, relations: [], unlistedFunctions: ["query_to_xml"] });
  });

  it("reports set_config", async () => {
    expect((await facts("SELECT set_config('role', 'postgres', true)")).unlistedFunctions).toEqual(["set_config"]);
  });

  it("reports every unlisted function once, wherever it appears", async () => {
    const f = await facts(
      "SELECT pg_sleep(0), current_setting('server_version') FROM customers WHERE pg_sleep(0) IS NULL ORDER BY version()",
    );
    expect(f.unlistedFunctions).toEqual(["current_setting", "pg_sleep", "version"]);
  });

  it("a set-returning function in FROM is an opaque node, and generate_series is listed", async () => {
    expect(await facts("SELECT * FROM generate_series(1, 3)")).toEqual({ ...clean, relations: [], hasOpaqueNode: true });
  });

  it("an unlisted function in FROM is both opaque and unlisted", async () => {
    expect(await facts("SELECT * FROM regexp_split_to_table('a,b', ',')")).toMatchObject({
      hasOpaqueNode: true,
      unlistedFunctions: ["regexp_split_to_table"],
    });
  });

  it("a function the agent role may not execute is refused one way or the other", async () => {
    const f = await facts("SELECT * FROM pg_ls_dir('.')");
    expect(f.touchesBreakerSchema || f.unlistedFunctions.includes("pg_ls_dir")).toBe(true);
  });

  it("lower and count are listed", async () => {
    const f = await facts("SELECT lower(subject), count(*) FROM support_tickets GROUP BY 1");
    expect(f).toMatchObject({ ...clean, touchesUntrusted: true });
  });

  it("everyday SQL has no unlisted function", async () => {
    const f = await facts(
      `SELECT left(subject, 3), right(subject, 2), substring(body, 1, 5), substring(body FROM 1 FOR 5), trim(subject),
              coalesce(reply, 'x'), position('a' IN body), extract(year FROM created_at), body::varchar(10),
              created_at::timestamp(3), id::numeric(10,2), nullif(reply, ''), greatest(id, 2),
              CASE WHEN id > 1 THEN 'a' ELSE upper(subject) END, row(id, subject), array[id, 2], now()
         FROM support_tickets
        WHERE id IN (1, 2) AND id = ANY (array[1, 2]::bigint[]) AND subject LIKE 'a%'
          AND EXISTS (SELECT 1 FROM customers c WHERE c.id = support_tickets.id)
          AND id IN (SELECT id FROM customers) AND id > (SELECT count(*) FROM customers)`,
    );
    expect(f.unlistedFunctions).toEqual([]);
    expect(f).toMatchObject({ ...clean, touchesUntrusted: true });
  });

  it("aggregates and window functions have no unlisted function", async () => {
    const f = await facts(
      `SELECT row_number() OVER (ORDER BY id), rank() OVER (PARTITION BY plan ORDER BY id),
              string_agg(name, ',' ORDER BY name) FILTER (WHERE id > 1)
         FROM customers GROUP BY id`,
    );
    expect(f).toMatchObject(clean);
  });

  it("text inside a string literal is never a function", async () => {
    expect(await facts("SELECT 'evil(' || name FROM customers")).toMatchObject(clean);
    expect(await facts("SELECT 'it''s evil(1) and pg_sleep(1)' || name, E'a\\\\' || 'evil(' FROM customers")).toMatchObject(clean);
  });

  it("a quote inside a quoted identifier cannot hide a call", async () => {
    const f = await facts(`SELECT "it's".name, pg_sleep(0), 'z' FROM customers AS "it's"`);
    expect(f.unlistedFunctions).toEqual(["pg_sleep"]);
  });
});

describe("protected objects", () => {
  it("a relation outside the customer schema", async () => {
    const f = await facts("SELECT relname FROM pg_class");
    expect(f).toEqual({
      ...clean,
      relations: [{ schema: "pg_catalog", name: "pg_class", scanned: true, written: false }],
      touchesBreakerSchema: true,
    });
  });

  it.each(["SELECT * FROM breaker.events", 'SELECT * FROM "breaker".sessions', "DELETE FROM Breaker . events"])(
    "the breaker schema by name: %s",
    async (sql) => {
      expect(await facts(sql)).toEqual(protectedObject);
    },
  );

  it("the breaker schema behind a comment or an escaped quote", async () => {
    expect(await facts("SELECT 1 /* it's */ FROM breaker.sessions")).toEqual(protectedObject);
    expect(await facts("SELECT E'\\'', 1 FROM breaker.sessions --'")).toEqual(protectedObject);
  });

  it("a string literal that merely mentions breaker.sessions is not one", async () => {
    for (const sql of [
      "SELECT 'see breaker.sessions' AS note FROM customers",
      "SELECT $$ breaker.sessions $$ AS note FROM customers",
    ]) {
      expect(await facts(sql), sql).toEqual({ ...clean, relations: [{ ...customers, scanned: true, written: false }] });
    }
  });
});

describe("statements Postgres cannot plan", () => {
  it("a syntax error is not explainable and carries the class-42 message", async () => {
    const f = await facts("SELECT FROM WHERE");
    expect(f).toMatchObject({ ...clean, explainable: false, failedAt: "explain", relations: [] });
    expect(f.opaqueReason).toMatch(/syntax error/);
  });

  it("an unknown table is not explainable and carries the class-42 message", async () => {
    const f = await facts("SELECT * FROM no_such_table_here");
    expect(f).toMatchObject({ explainable: false, failedAt: "explain" });
    expect(f.opaqueReason).toMatch(/no_such_table_here/);
  });

  it("any other planner error is reported by SQLSTATE only", async () => {
    // Constant folding evaluates this at plan time: 22P02, and its message would quote the value.
    const f = await facts("SELECT 'not-a-number-9731'::int");
    expect(f).toMatchObject({ explainable: false, failedAt: "explain", opaqueReason: "analysis failed (SQLSTATE 22P02)" });
  });
});
