// The Breaker OFF path: one agent statement, unchecked, as the least-privilege role.
// It is the demo's "before" state, so nothing looks at what the statement reads or writes.
// What this file does guarantee is that the statement leaves nothing behind on the pooled connection,
// which the helpdesk's own queries (src/lib/victim/tickets.ts) and the dashboard share.

import type { QueryResult } from "pg";
import { AGENT_ROLE, CUSTOMER_SCHEMA, customer, single } from "@core/db";

export async function runUnchecked(sql: string): Promise<QueryResult> {
  const client = await customer.connect();
  try {
    await client.query(
      `begin; set local role ${AGENT_ROLE}; set local search_path = ${CUSTOMER_SCHEMA}; set local statement_timeout = '5s'`,
    );
    const out = await single(client, sql);
    // SET ROLE, SET SESSION AUTHORIZATION, set_config(), COMMIT: a statement that ends as anybody but the
    // agent role is refused, and the rollback below undoes it together with every setting it changed.
    const who = await client.query("select current_user as role");
    if (who.rows[0]?.role !== AGENT_ROLE) throw new Error("The statement changed the database role. It was rolled back.");
    // A plain SET outlives the transaction. Inside the same transaction, put the session back to its defaults,
    // so the commit keeps the statement's data and none of its settings.
    await client.query("reset session authorization; reset role; reset all; commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    // What is not a setting (prepared statements, temporary tables, advisory locks, LISTEN) goes here.
    // A connection that cannot be cleaned is closed instead of going back to the pool.
    const clean = await client.query("discard all").then(
      () => true,
      () => false,
    );
    client.release(clean ? undefined : true);
  }
}
