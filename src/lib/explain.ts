import { pool } from "./db";
import { CATALOG, type Operation } from "./policy";

// Diagnostic only. EXPLAIN is never part of an authorization decision: the
// catalog declares what each operation touches, and this asks Postgres to plan
// the same fixed statement so the declaration can be checked against it.

const SAMPLE_RUN = "00000000-0000-0000-0000-000000000000";
const SAMPLE_PARAMS: Record<string, Record<string, string | number>> = {
  "tickets.list_open": {},
  "tickets.read": { ticketId: 1 },
  "tokens.read_integration": { service: "billing-api" },
  "tickets.publish_reply": { ticketId: 1, content: "sample" },
};

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

export interface PlanCheck {
  planned: string[];
  undeclared: string[];
  covered: boolean;
}

export async function planCheck(op: Operation): Promise<PlanCheck> {
  const client = await pool.connect();
  try {
    const cols = await client.query(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    // Plain EXPLAIN plans the statement without running it. Never ANALYZE.
    const res = await client.query(`EXPLAIN (VERBOSE, FORMAT JSON) ${op.sql}`, op.values(SAMPLE_RUN, SAMPLE_PARAMS[op.id]));
    const planned = new Set<string>();
    const walk = (node: PlanNode) => {
      const relation = node["Relation Name"] as string | undefined;
      if (relation) {
        const alias = (node["Alias"] as string | undefined) ?? relation;
        const strings: string[] = [];
        const visit = (v: unknown) => {
          if (typeof v === "string") strings.push(v.replace(/"/g, ""));
          else if (Array.isArray(v)) v.forEach(visit);
        };
        Object.entries(node).forEach(([k, v]) => k !== "Plans" && visit(v));
        for (const row of cols.rows.filter((r) => r.table_name === relation)) {
          const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`(^|[^\\w.])(${esc(alias)}\\.)?${esc(row.column_name)}(?![\\w(])`);
          if (strings.some((s) => re.test(s))) planned.add(`${relation}.${row.column_name}`);
        }
      }
      (node.Plans ?? []).forEach(walk);
    };
    walk(res.rows[0]["QUERY PLAN"][0].Plan);
    const declared = new Set([...op.reads, ...op.writes]);
    const undeclared = [...planned].filter((c) => !declared.has(c));
    return { planned: [...planned].sort(), undeclared, covered: undeclared.length === 0 };
  } finally {
    client.release();
  }
}

let cache: Promise<Record<string, PlanCheck>> | null = null;

export function planChecks(): Promise<Record<string, PlanCheck>> {
  cache ??= (async () => {
    const out: Record<string, PlanCheck> = {};
    for (const op of CATALOG.values()) out[op.id] = await planCheck(op);
    return out;
  })().catch((err) => {
    cache = null;
    throw err;
  });
  return cache;
}
