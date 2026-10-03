// The analyzer: what would this statement touch? Postgres answers (plain EXPLAIN never executes
// anything) and we only read its plan. It never looks at row data and never guesses from SQL text.
import { asAgent, CUSTOMER_SCHEMA, single } from "./db";
import { E_PREFIX, IDENT_CHAR } from "./mask";
import type { LabelRow, QueryFacts, Relation } from "./types";

// ---- Step 1: pre-check (no database) ----

const LEADING_KEYWORD = /^(select|with|insert|update|delete)(?![\w$])/i;

/**
 * One statement, starting with a keyword EXPLAIN accepts. A semicolon inside a string literal is
 * refused as well: fail closed. A leading comment or parenthesis is refused for the same reason.
 */
export function precheck(sql: string): { ok: true; sql: string } | { ok: false; reason: string } {
  if (typeof sql !== "string") return { ok: false, reason: "statement is not text" };
  // The wire protocol cuts the text at a NUL: Postgres would not see the statement we analyzed.
  if (sql.includes("\u0000")) return { ok: false, reason: "invalid character" };
  let cleaned = sql.trim();
  if (cleaned.endsWith(";")) cleaned = cleaned.slice(0, -1).trimEnd();
  if (!cleaned) return { ok: false, reason: "empty statement" };
  if (cleaned.includes(";")) return { ok: false, reason: "multiple statements" };
  if (!LEADING_KEYWORD.test(cleaned)) {
    return { ok: false, reason: "only SELECT, WITH, INSERT, UPDATE and DELETE statements are accepted" };
  }
  return { ok: true, sql: cleaned };
}

// ---- Step 2: the breaker schema, by name ----

/**
 * The agent's SQL with string literals and comments removed, so text inside a literal is never
 * mistaken for an object name. Quoted identifiers are kept: "breaker".sessions is still a reference.
 */
function stripLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (ch === "/" && sql[i + 1] === "*") {
      // Block comments nest in Postgres.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        const two = sql.slice(i, i + 2);
        if (two === "/*") depth++;
        else if (two === "*/") depth--;
        i += two === "/*" || two === "*/" ? 2 : 1;
      }
      out += " ";
    } else if (ch === '"') {
      const start = i++;
      while (i < n && (sql[i] !== '"' || sql[i + 1] === '"')) i += sql[i] === '"' ? 2 : 1;
      out += sql.slice(start, ++i);
    } else if (ch === "'") {
      // E'...' strings also escape a quote with a backslash.
      const escapes = E_PREFIX.test(sql.slice(Math.max(0, i - 2), i));
      i++;
      while (i < n) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else if (ch === "$" && !IDENT_CHAR.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
      if (!tag) {
        out += ch;
        i++;
        continue;
      }
      const end = sql.indexOf(tag[0], i + tag[0].length);
      i = end === -1 ? n : end + tag[0].length;
      out += "''";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// breaker.x, "breaker".x, breaker . x: decided on the text, so the answer does not depend on
// whether a breaker schema happens to exist in the Customer DB.
const BREAKER_SCHEMA = /(?<![\w$])"?breaker"?\s*\./i;

// SELECT ... INTO creates a table, yet EXPLAIN plans it as a plain SELECT: the plan cannot be
// trusted for it. The only INTO the agent needs is the one right after INSERT.
const INTO_WITHOUT_INSERT = /(?<!(?<![\w$])insert\s+)(?<![\w$])into(?![\w$])/i;
const QUOTED_IDENTIFIER = /"(?:[^"]|"")*"/g;

// ---- Step 3: the function allowlist ----

/**
 * Functions the agent may call. A function can read tables, files or settings without EXPLAIN
 * showing a scan, so everything not listed here is refused (R5). Nothing on this list can run SQL,
 * read files, change settings, sleep or reach the network.
 */
const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  ...["count", "sum", "avg", "min", "max", "string_agg", "array_agg", "bool_and", "bool_or"],
  // text
  ...["lower", "upper", "length", "char_length", "trim", "btrim", "ltrim", "rtrim", "substring", "substr"],
  ...["left", "right", "replace", "concat", "concat_ws", "position", "strpos", "split_part", "starts_with"],
  // numbers, dates, sets, windows
  ...["abs", "round", "ceil", "floor", "now", "date_trunc", "date_part", "extract", "to_char"],
  ...["generate_series", "unnest", "nextval", "row_number", "rank", "dense_rank"],
]);

/** SQL constructs the deparser prints like a call. Only matched unquoted: "coalesce"(...) would be a real function. */
const CALL_LIKE_CONSTRUCTS = new Set([
  ...["any", "all", "some", "in", "array", "row", "exists", "case", "cast"],
  ...["coalesce", "nullif", "greatest", "least"],
]);

const IDENT = String.raw`(?:"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*)`;
const IDENT_RE = new RegExp(IDENT, "gu");
/**
 * Tokens of a deparsed plan expression, tried in this order at every position:
 *   1. a string literal (the deparser doubles an embedded quote, also inside E'...'): skipped;
 *   2. a cast, with its type modifier: ::numeric(10,2) and ::character varying(10) are not calls;
 *   3. a possibly qualified identifier, consumed whole so a quote inside "it's" cannot open a
 *      fake literal; it is a call when "(" follows immediately, as the deparser always prints it.
 */
const EXPR_TOKEN = new RegExp(
  String.raw`'(?:[^']|'')*'` +
    String.raw`|::${IDENT}(?:\.${IDENT})*(?: varying)?(?:\(\d+(?:,-?\d+)?\))?` +
    String.raw`|(${IDENT}(?:\.${IDENT})*)(\()?`,
  "gu",
);

function collectUnlisted(expression: string, unlisted: Set<string>) {
  for (const m of expression.matchAll(EXPR_TOKEN)) {
    if (!m[1] || !m[2]) continue;
    const parts = (m[1].match(IDENT_RE) ?? []).map((raw) =>
      raw.startsWith('"') ? { quoted: true, text: raw.slice(1, -1).replace(/""/g, '"') } : { quoted: false, text: raw },
    );
    const fn = parts[parts.length - 1];
    const qualifier = parts.slice(0, -1);
    // A qualified name means the function is not the one an unqualified call resolves to.
    const builtin = qualifier.length === 0 || (qualifier.length === 1 && qualifier[0].text === "pg_catalog");
    // The deparser quotes a name only when it must ("left", "MyFunc"): compare it exactly.
    const name = fn.quoted ? fn.text : fn.text.toLowerCase();
    if (builtin && ALLOWED_FUNCTIONS.has(name)) continue;
    if (qualifier.length === 0 && !fn.quoted && CALL_LIKE_CONSTRUCTS.has(name)) continue;
    unlisted.add(
      parts
        .map((p) => p.text)
        .join(".")
        .toLowerCase(),
    );
  }
}

// ---- Step 4: the plan walk ----

type PlanNode = Record<string, unknown>;

const OPAQUE_NODES = new Set(["Function Scan", "Foreign Scan", "Table Function Scan"]);

/** Keys that hold names and enum words, not expressions. Everything else in a node is searched for calls. */
const NOT_EXPRESSIONS = new Set([
  ...["Plans", "Node Type", "Relation Name", "Schema", "Alias", "Index Name", "CTE Name", "Subplan Name"],
  ...["Function Name", "Table Function Name", "Tuplestore Name", "Parent Relationship", "Operation", "Command"],
  ...["Strategy", "Partial Mode", "Join Type", "Scan Direction", "Conflict Resolution", "Conflict Arbiter Indexes"],
]);

type Walk = {
  relations: Map<string, Relation>;
  isWrite: boolean;
  hasOpaqueNode: boolean;
  outsideCustomerSchema: boolean;
  unlisted: Set<string>;
};

function record(w: Walk, source: PlanNode, scanned: boolean, written: boolean) {
  const name = source["Relation Name"];
  if (typeof name !== "string") return false;
  // VERBOSE always prints the schema of a relation. If it is missing, treat the relation as foreign to the customer.
  const schema = typeof source["Schema"] === "string" ? (source["Schema"] as string) : "";
  if (schema !== CUSTOMER_SCHEMA) w.outsideCustomerSchema = true;
  const key = JSON.stringify([schema, name]);
  const known = w.relations.get(key);
  if (known) {
    known.scanned ||= scanned;
    known.written ||= written;
  } else {
    w.relations.set(key, { schema, name, scanned, written });
  }
  return true;
}

function expressions(value: unknown, w: Walk) {
  if (typeof value === "string") collectUnlisted(value, w.unlisted);
  else if (Array.isArray(value)) for (const item of value) expressions(item, w);
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) if (!NOT_EXPRESSIONS.has(key)) expressions(inner, w);
  }
}

function walk(node: PlanNode, w: Walk) {
  const type = node["Node Type"];

  if (type === "ModifyTable") {
    w.isWrite = true;
    // A plain INSERT ... VALUES writes its target without reading it. Anything else reads it too:
    // UPDATE and DELETE scan it, RETURNING hands rows back, ON CONFLICT looks at existing rows.
    const reads =
      node["Operation"] !== "Insert" || node["Output"] !== undefined || node["Conflict Resolution"] !== undefined;
    // Several targets (partitions, inheritance) are listed under "Target Tables".
    const targets = Array.isArray(node["Target Tables"]) ? (node["Target Tables"] as PlanNode[]) : [];
    let found = 0;
    for (const target of [node, ...targets]) if (record(w, target, reads, true)) found++;
    if (!found) throw new Error("write target not identified");
  } else {
    record(w, node, true, false);
  }

  if (typeof type === "string" && OPAQUE_NODES.has(type)) w.hasOpaqueNode = true;

  // The function of a Function Scan is also in "Function Call"; checking the name here costs nothing.
  if (typeof node["Function Name"] === "string") {
    const fn = node["Function Name"] as string;
    if (node["Schema"] !== "pg_catalog") w.unlisted.add(`${String(node["Schema"] ?? "?")}.${fn}`.toLowerCase());
    else if (!ALLOWED_FUNCTIONS.has(fn)) w.unlisted.add(fn.toLowerCase());
  }

  expressions(node, w);

  if (Array.isArray(node["Plans"])) for (const child of node["Plans"] as PlanNode[]) walk(child, w);
}

// ---- analyze ----

const blank = (): QueryFacts => ({
  explainable: true,
  relations: [],
  touchesBreakerSchema: false,
  touchesUntrusted: false,
  touchesSecret: false,
  writesUntrusted: false,
  isWrite: false,
  hasOpaqueNode: false,
  unlistedFunctions: [],
});

const refused = (failedAt: "precheck" | "explain", opaqueReason: string): QueryFacts => ({
  ...blank(),
  explainable: false,
  failedAt,
  opaqueReason,
});

/** Understood well enough to know the answer is no: R1, before or instead of a plan. */
const protectedObject = (failedAt: "precheck" | "explain"): QueryFacts => ({ ...blank(), failedAt, touchesBreakerSchema: true });

/**
 * The facts the policy decides on. `labels` come from the caller (core/src/labels.ts), so analysis
 * touches only the Customer DB and never needs a Breaker DB connection of its own.
 */
export async function analyze(sql: string, labels: LabelRow[]): Promise<QueryFacts> {
  const checked = precheck(sql);
  if (!checked.ok) return refused("precheck", checked.reason);
  // No label for the customer's schema (labels never applied, or written for another schema):
  // every statement would look clean. That is "cannot be sure", so it is refused.
  if (!labels.some((l) => l.table_schema === CUSTOMER_SCHEMA)) {
    return refused("precheck", "no labels are loaded for the customer schema");
  }

  const bare = stripLiterals(checked.sql);
  // Decided on the text alone, before Postgres is asked anything.
  if (BREAKER_SCHEMA.test(bare)) return protectedObject("precheck");
  if (INTO_WITHOUT_INSERT.test(bare.replace(QUOTED_IDENTIFIER, '""'))) {
    return refused("precheck", "SELECT ... INTO is not accepted");
  }

  let plan: unknown;
  try {
    // Plain EXPLAIN plans the statement and never runs it. Never add ANALYZE here.
    const res = await asAgent(true, (c) => single(c, `EXPLAIN (VERBOSE, FORMAT JSON) ${checked.sql}`));
    plan = res.rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
  } catch (err) {
    const raw = (err as { code?: unknown } | null)?.code;
    const code = typeof raw === "string" && /^[0-9A-Z]{5}$/.test(raw) ? raw : null;
    // The agent role may not use that object: it is outside the customer's own tables.
    if (code === "42501") return protectedObject("explain");
    // Class 42 (syntax, unknown name) only echoes the agent's own SQL. Any other message stays here:
    // planning can evaluate functions, and an error message can carry data.
    if (code?.startsWith("42") && err instanceof Error) return refused("explain", err.message);
    return refused("explain", code ? `analysis failed (SQLSTATE ${code})` : "analysis failed");
  }
  if (typeof plan !== "object" || plan === null) return refused("explain", "analysis failed (no plan)");

  const w: Walk = {
    relations: new Map(),
    isWrite: false,
    hasOpaqueNode: false,
    outsideCustomerSchema: false,
    unlisted: new Set(),
  };
  try {
    walk(plan as PlanNode, w);
  } catch {
    return refused("explain", "analysis failed (plan not understood)");
  }

  // Table-level resolution: reading any column of a table that has a labeled column counts.
  // It over-blocks and never under-blocks. Writing a column is not reading it.
  const relations = [...w.relations.values()];
  const labeled = (r: Relation, label: LabelRow["label"]) =>
    labels.some((l) => l.label === label && l.table_schema === r.schema && l.table_name === r.name);
  const reads = (label: LabelRow["label"]) => relations.some((r) => r.scanned && labeled(r, label));

  return {
    explainable: true,
    relations,
    touchesBreakerSchema: w.outsideCustomerSchema,
    touchesUntrusted: reads("untrusted"),
    touchesSecret: reads("secret"),
    // The target of a write is checked whether or not the plan scans it: a plain INSERT does not.
    writesUntrusted: relations.some((r) => r.written && labeled(r, "untrusted")),
    isWrite: w.isWrite,
    hasOpaqueNode: w.hasOpaqueNode,
    unlistedFunctions: [...w.unlisted].sort(),
  };
}
