import { Pool } from "pg";

const globalForPool = globalThis as unknown as { tbPool?: Pool };

export const pool =
  globalForPool.tbPool ??
  (globalForPool.tbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // DATABASE_URL points at Supabase's transaction pooler (port 6543): the session
    // pooler caps at 15 clients, which a few serverless instances exhaust.
    // Multi-statement work here always runs inside an explicit transaction, so transaction mode is safe.
    max: 3,
    idleTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  }));
