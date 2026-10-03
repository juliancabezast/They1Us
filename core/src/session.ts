// Sessions: one per agent conversation. The stamps live in breaker.sessions, in the Breaker DB
// (control pool only: the Customer DB never learns that sessions exist).
import { control } from "./db";
import type { Flags } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checked before any query: a malformed id is an unknown session, not a 22P02 from Postgres. */
export const isSessionId = (id: unknown): id is string => typeof id === "string" && UUID.test(id);

export const unknownSession = () => new Error("Unknown session");

/** `label` says who opened it (replay:A:protected, mcp, test). Returns the session's uuid. */
export async function createSession(label?: string): Promise<string> {
  const { rows } = await control.query("insert into breaker.sessions (label) values ($1) returning id", [
    label ?? null,
  ]);
  return rows[0].id;
}

export async function getFlags(sessionId: string): Promise<Flags> {
  if (!isSessionId(sessionId)) throw unknownSession();
  const { rows } = await control.query("select has_untrusted, has_secret from breaker.sessions where id = $1", [
    sessionId,
  ]);
  if (!rows.length) throw unknownSession();
  return { hasUntrusted: rows[0].has_untrusted, hasSecret: rows[0].has_secret };
}

/**
 * For tests and tools. guardedExecute does not use it: it writes the flags itself,
 * inside the transaction that holds the session's row lock.
 */
export async function setFlags(sessionId: string, flags: Flags): Promise<void> {
  if (!isSessionId(sessionId)) throw unknownSession();
  const { rowCount } = await control.query(
    "update breaker.sessions set has_untrusted = $2, has_secret = $3 where id = $1",
    [sessionId, flags.hasUntrusted, flags.hasSecret],
  );
  if (!rowCount) throw unknownSession();
}
