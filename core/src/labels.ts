// The sticker list: which columns of the Customer DB carry untrusted or secret data.
// It lives in the Breaker DB and is cached here, so analysis never needs a control connection.
import { control, CUSTOMER_SCHEMA } from "./db";
import type { LabelRow } from "./types";

const TTL_MS = 60_000;

let cached: { rows: LabelRow[]; at: number } | null = null;
// One load at a time: a burst of statements after the cache expires shares a single query.
let loading: Promise<LabelRow[]> | null = null;

async function load(): Promise<LabelRow[]> {
  const { rows } = await control.query<LabelRow>(
    "select table_schema, table_name, column_name, label from breaker.column_labels order by table_schema, table_name, column_name",
  );
  // An empty list, or one written for another schema, is not "nothing is labeled": it is a Breaker
  // that was never told what to protect. It is not cached, and the caller fails closed.
  if (!rows.some((l) => l.table_schema === CUSTOMER_SCHEMA)) {
    throw new Error(`breaker.column_labels has no label for schema "${CUSTOMER_SCHEMA}".`);
  }
  cached = { rows, at: Date.now() };
  return rows;
}

/**
 * Loads the labels now. If the Breaker DB cannot be reached and labels were loaded before, the
 * previous ones keep being served (stale labels still block); with nothing cached it throws,
 * so the caller fails closed: without labels every statement would look clean.
 */
export function reloadLabels(): Promise<LabelRow[]> {
  if (!loading) {
    loading = load()
      .catch((err) => {
        if (cached) return cached.rows;
        // Our own message (no labels for the schema) is kept; database error text is not.
        const ours = err instanceof Error && !("code" in err) && !("severity" in err);
        throw new Error(`Labels could not be loaded from the Breaker DB.${ours ? ` ${err.message}` : ""}`, { cause: err });
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/**
 * The labels, at most 60 s old: a label added to breaker.column_labels takes up to 60 s to apply in
 * each running process. The Breaker server reloads at once on SIGHUP.
 */
export async function getLabels(): Promise<LabelRow[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rows;
  return reloadLabels();
}
