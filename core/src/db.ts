import { Pool, type PoolClient, type QueryResult } from "pg";

// Two databases, exactly as in production: the customer's (the data the agent works on)
// and the Breaker's own (labels, session stamps, decision log). Only the Breaker holds
// the customer's connection string; the agent's only path to data is through it.

/** The identity agent SQL runs as inside the Customer DB. Created in core/sql/customer/001_schema.sql. */
export const AGENT_ROLE = "breaker_agent";

/** The schema of the customer's tables. Unqualified names in agent SQL resolve here. */
export const CUSTOMER_SCHEMA = process.env.CUSTOMER_SCHEMA || "public";
// It is interpolated into SET statements, so it must be a plain identifier.
if (!/^[a-z_][a-z0-9_]*$/.test(CUSTOMER_SCHEMA)) throw new Error("CUSTOMER_SCHEMA must be a plain lower-case identifier");

const cache = globalThis as unknown as { breakerControl?: Pool; breakerCustomer?: Pool };

// Supabase's transaction pooler (port 6543): everything below runs inside explicit transactions.
const make = (connectionString: string | undefined) =>
  new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    // Never queue for a connection forever: past this the caller gets an error and fails closed.
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });

/** Breaker DB: sessions, labels, events. Never runs agent SQL, so the log survives the agent's rollbacks. */
export const control =
  cache.breakerControl ?? (cache.breakerControl = make(process.env.BREAKER_DATABASE_URL ?? process.env.DATABASE_URL));

/**
 * Customer DB with the customer's own connection string. Used directly only for what the customer's
 * app would do itself (fixtures, resets). Agent SQL never runs here directly: it goes through `asAgent`.
 */
export const customer = cache.breakerCustomer ?? (cache.breakerCustomer = make(process.env.CUSTOMER_DATABASE_URL));

/** For entry points (server, CLI, scripts): fail with a clear message instead of a connection error. */
export function assertEnv() {
  if (!process.env.CUSTOMER_DATABASE_URL) throw new Error("CUSTOMER_DATABASE_URL is not set");
  if (!process.env.BREAKER_DATABASE_URL && !process.env.DATABASE_URL) throw new Error("BREAKER_DATABASE_URL is not set");
}

/**
 * Runs `fn` in a Customer DB transaction that is the agent: least-privilege role, customer schema, 5 s limit.
 * `readOnly` makes Postgres itself refuse writes, whatever the analyzer concluded.
 */
export async function asAgent<T>(readOnly: boolean, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await customer.connect();
  try {
    await client.query(
      `${readOnly ? "begin transaction read only" : "begin"}; set local role ${AGENT_ROLE}; set local search_path = ${CUSTOMER_SCHEMA}; set local statement_timeout = '5s'`,
    );
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Sends agent SQL with the extended protocol, where Postgres refuses a second statement in the same string. */
export const single = (client: PoolClient, text: string): Promise<QueryResult> =>
  client.query({ text, queryMode: "extended" } as unknown as string);

/** For scripts and tests, so the process can exit. */
export async function closePools() {
  await Promise.all([control.end(), customer.end()]);
  cache.breakerControl = cache.breakerCustomer = undefined;
}
