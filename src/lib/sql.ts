import type { DriverKind } from "@/types";

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

// Wrap a SELECT/WITH statement in EXPLAIN syntax appropriate for the driver.
// Strips a leading EXPLAIN if the user already typed one, to avoid double-wrap.
export function explainWrap(sql: string, driver: string): string {
  const trimmed = sql.trim().replace(/;$/, "");
  const lead = trimmed
    .toUpperCase()
    .match(/^EXPLAIN(\s+ANALYZE|\s+QUERY\s+PLAN|\s+FORMAT[^\s]*)?\s+/);
  const body = lead ? trimmed.slice(lead[0].length) : trimmed;
  switch (driver) {
    case "postgres":
      return `EXPLAIN (ANALYZE false, VERBOSE true) ${body}`;
    case "mysql":
      return `EXPLAIN ${body}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${body}`;
    default:
      return `EXPLAIN ${body}`;
  }
}

// Mirrors `quote_ident` in src-tauri/src/db/data.rs.
export function quoteIdent(driver: DriverKind, name: string): string {
  if (driver === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}
