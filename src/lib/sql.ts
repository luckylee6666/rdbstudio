import type { DriverKind } from "@/types";
import { stripLeadingExplain } from "./explain";

// Split a SQL script into individual statements, respecting string literals
// (single, double, backtick) and comments (-- line, /* block */). Returns
// non-empty trimmed statements. Used by the query editor so users can paste
// multi-statement scripts (schema.sql, seed files) and have them run sequentially.
export function splitStatements(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = input.length;
  type Mode =
    | "normal"
    | "single"
    | "double"
    | "backtick"
    | "lineComment"
    | "blockComment"
    | "dollar";
  let mode: Mode = "normal";
  let dollarTag = "";

  while (i < n) {
    const ch = input[i];
    const next = i + 1 < n ? input[i + 1] : "";

    if (mode === "dollar") {
      if (ch === "$" && input.startsWith("$" + dollarTag + "$", i)) {
        buf += "$" + dollarTag + "$";
        i += 2 + dollarTag.length;
        mode = "normal";
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (mode === "lineComment") {
      buf += ch;
      if (ch === "\n") mode = "normal";
      i++;
      continue;
    }
    if (mode === "blockComment") {
      buf += ch;
      if (ch === "*" && next === "/") {
        buf += next;
        i += 2;
        mode = "normal";
        continue;
      }
      i++;
      continue;
    }
    if (mode === "single") {
      buf += ch;
      if (ch === "\\" && next) {
        buf += next;
        i += 2;
        continue;
      }
      if (ch === "'") mode = "normal";
      i++;
      continue;
    }
    if (mode === "double") {
      buf += ch;
      if (ch === "\\" && next) {
        buf += next;
        i += 2;
        continue;
      }
      if (ch === '"') mode = "normal";
      i++;
      continue;
    }
    if (mode === "backtick") {
      buf += ch;
      if (ch === "`") mode = "normal";
      i++;
      continue;
    }
    // normal
    if (ch === "-" && next === "-") {
      buf += ch;
      buf += next;
      i += 2;
      mode = "lineComment";
      continue;
    }
    if (ch === "/" && next === "*") {
      buf += ch;
      buf += next;
      i += 2;
      mode = "blockComment";
      continue;
    }
    if (ch === "$") {
      const opened = tryDollarQuote(input, i);
      if (opened) {
        buf += input.slice(i, opened.contentStart);
        i = opened.contentStart;
        dollarTag = opened.tag;
        mode = "dollar";
        continue;
      }
    }
    if (ch === "'") {
      mode = "single";
      buf += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      mode = "double";
      buf += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      mode = "backtick";
      buf += ch;
      i++;
      continue;
    }
    if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) out.push(trimmed);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// Postgres dollar-quote: `$$ … $$` or `$tag$ … $tag$`. Tags follow unquoted
// identifier rules (no leading digit). `$1` is a placeholder, not a quote.
function tryDollarQuote(
  input: string,
  i: number
): { tag: string; contentStart: number } | null {
  if (input[i] !== "$") return null;
  const n = input.length;
  if (i + 1 < n && input[i + 1] === "$") {
    return { tag: "", contentStart: i + 2 };
  }
  if (i + 1 < n && /[0-9]/.test(input[i + 1])) return null;
  let j = i + 1;
  while (j < n && /[A-Za-z0-9_]/.test(input[j])) j++;
  if (j > i + 1 && j < n && input[j] === "$") {
    return { tag: input.slice(i + 1, j), contentStart: j + 1 };
  }
  return null;
}

// Split Redis editor input into one command per line. Newlines inside a
// double-quoted argument stay put — the backend's argument parser treats every
// unquoted whitespace run (newlines included) as a separator, so a buffer sent
// whole would collapse into a single command with the later lines as its
// arguments: `PING\nPING` answers "PING", not two PONGs.
export function splitRedisCommands(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted && ch === "\\" && i + 1 < input.length) {
      buf += ch + input[i + 1];
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      buf += ch;
      continue;
    }
    if (!quoted && (ch === "\n" || ch === "\r")) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export interface ExplainWrapOptions {
  // Run the statement for real (PostgreSQL only; SQLite/MySQL ignore it).
  analyze?: boolean;
  // Emit the machine-readable plan format where the driver supports it.
  format?: "text" | "json";
}

// Wrap a SELECT/WITH statement in EXPLAIN syntax appropriate for the driver.
// Strips a leading EXPLAIN if the user already typed one, to avoid double-wrap.
export function explainWrap(
  sql: string,
  driver: string,
  opts: ExplainWrapOptions = {}
): string {
  const body = stripLeadingExplain(sql.trim().replace(/;\s*$/, ""));
  const analyze = opts.analyze === true;
  switch (driver) {
    case "postgres": {
      const options = [`ANALYZE ${analyze ? "true" : "false"}`, "VERBOSE true"];
      if (opts.format === "json") options.push("FORMAT JSON");
      return `EXPLAIN (${options.join(", ")}) ${body}`;
    }
    case "mysql":
      return opts.format === "json"
        ? `EXPLAIN FORMAT=JSON ${body}`
        : `EXPLAIN ${body}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${body}`;
    default:
      return `EXPLAIN ${body}`;
  }
}

// Strip leading whitespace plus `--` / `#` line comments and `/* … */` block
// comments, so statement classification sees the first real keyword.
export function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--") || t.startsWith("#")) {
      const nl = t.indexOf("\n");
      s = nl === -1 ? "" : t.slice(nl + 1);
      continue;
    }
    if (t.startsWith("/*")) {
      const end = t.indexOf("*/", 2);
      s = end === -1 ? "" : t.slice(end + 2);
      continue;
    }
    return t;
  }
}

// Conservative read-only classifier used to gate EXPLAIN ANALYZE, which runs
// the target statement for real. Only plain SELECT / VALUES / TABLE and WITH
// qualify; WITH is rejected when it mentions DML as a bare word (a data-
// modifying CTE). Anything unknown, malformed, or multi-statement fails closed
// — the caller warns instead of silently executing a write.
export function isReadOnlyStatement(sql: string): boolean {
  const statements = splitStatements(sql);
  if (statements.length !== 1) return false;
  const cleaned = stripLeadingComments(
    stripLeadingExplain(stripLeadingComments(statements[0]))
  );
  const keyword = /^[A-Za-z]+/.exec(cleaned)?.[0]?.toUpperCase();
  if (keyword === "SELECT" || keyword === "VALUES" || keyword === "TABLE") {
    return true;
  }
  if (keyword === "WITH") {
    return !/\b(INSERT|UPDATE|DELETE|MERGE|INTO)\b/i.test(cleaned);
  }
  return false;
}

// Mirrors `quote_ident` in src-tauri/src/db/data.rs.
export function quoteIdent(driver: DriverKind, name: string): string {
  if (driver === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}
