import { createHash } from "node:crypto";

/**
 * Characters that continue an identifier in Postgres: letters, digits, _ and $, and every non-ASCII
 * character. After one of them a "$" or an "E" is part of the name (é$$ is one identifier), not the
 * start of a dollar quote or of an E'' string.
 */
export const IDENT_CHAR = /[\w$\u0080-\uffff]/;
/** True when the text ends with a lone E or e: the prefix of an E'...' string. */
export const E_PREFIX = /(?:^|[^\w$\u0080-\uffff])[eE]$/;

/**
 * Blanks the contents of string literals and comments, so SQL can be logged and displayed without
 * carrying data. It reads the text the way Postgres does ('' and E'\'' escapes, $tag$ quoting, nested
 * comments); a literal that never closes is blanked to the end. Quoted identifiers are names: kept.
 * Names and numbers are NOT masked: see the note on secret sessions in core/src/breaker.ts.
 */
export function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += "--…";
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
      out += "/*…*/";
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
      out += "'…'";
    } else if (ch === "$" && !IDENT_CHAR.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
      if (!tag) {
        out += ch;
        i++;
        continue;
      }
      const end = sql.indexOf(tag[0], i + tag[0].length);
      i = end === -1 ? n : end + tag[0].length;
      out += "$$…$$";
    } else {
      out += ch;
      i++;
    }
  }
  // Postgres text cannot hold a NUL: without this the event of such a statement could not be written.
  return out.replace(/\u0000/g, "\uFFFD");
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
