import { Pool } from "pg";

const globalForPool = globalThis as unknown as { tbPool?: Pool };

export const pool =
  globalForPool.tbPool ??
  (globalForPool.tbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    ssl: { rejectUnauthorized: false },
  }));
