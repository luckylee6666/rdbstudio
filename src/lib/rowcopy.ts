import type { DriverKind } from "@/types";
import { quoteIdent } from "@/lib/sql";

/// Render a grid value as a SQL literal for generated INSERTs.
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

/// One INSERT statement per row, identifiers quoted for the driver.
export function toInsertSql(
  driver: DriverKind | undefined,
  table: string,
  columns: string[],
  rows: unknown[][]
): string {
  const d: DriverKind = driver ?? "postgres";
  const target = quoteIdent(d, table);
  const cols = columns.map((c) => quoteIdent(d, c)).join(", ");
  return rows
    .map(
      (r) =>
        `INSERT INTO ${target} (${cols}) VALUES (${r
          .map(sqlLiteral)
          .join(", ")});`
    )
    .join("\n");
}

/// Rows as a JSON array of objects keyed by column name.
export function toJSONRows(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) =>
      Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null]))
    ),
    null,
    2
  );
}
