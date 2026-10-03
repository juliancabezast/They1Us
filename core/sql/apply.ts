// Applies SQL files to one of the two databases, in order:
//   apply.ts breaker 001_schema.sql 002_labels.sql
//   apply.ts customer 001_schema.sql 002_seed.sql
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_SCHEMA, closePools, control, customer } from "../src/db";

async function main() {
  const [target, ...files] = process.argv.slice(2);
  if ((target !== "breaker" && target !== "customer") || !files.length) {
    throw new Error("usage: apply.ts <breaker|customer> <file.sql> [...]");
  }
  for (const file of files) {
    const sql = readFileSync(join(__dirname, target, file), "utf8");
    // One round trip, one transaction: the settings below must reach the statements of the file.
    if (target === "breaker") {
      await control.query(`begin; set local breaker.customer_schema = '${CUSTOMER_SCHEMA}'; ${sql}; commit`);
    } else {
      await customer.query(`begin; create schema if not exists ${CUSTOMER_SCHEMA}; set local search_path = ${CUSTOMER_SCHEMA}; ${sql}; commit`);
    }
    console.log(`applied ${target}/${file}`);
  }
}

main()
  .catch((err) => {
    // Message only: a pg error object can carry connection details.
    console.error(`failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(closePools);
