import { parameterError, type ParameterKind, type QueryParameter } from "./queryParameters";

export const MAX_PARAMETER_SETS = 100;
export type BatchFormat = "csv" | "tsv" | "json";
export type ParameterRow = Record<string, string | null>;
export interface ParameterBatchDraft { rows: ParameterRow[]; types: Record<string, ParameterKind>; atomic: boolean }
export interface BatchIssue { code: string; row?: number; name?: string }
const byteLength = (value: string) => new TextEncoder().encode(value).length;

function delimited(text: string, separator: string): Array<Array<{ value: string; quoted: boolean }>> {
  const rows: Array<Array<{ value: string; quoted: boolean }>> = [];
  let row: Array<{ value: string; quoted: boolean }> = [];
  let value = "", quoted = false, inside = false, closed = false;
  const field = () => { row.push({ value, quoted }); value = ""; quoted = false; closed = false; };
  const line = () => { field(); rows.push(row); row = []; if (rows.length > MAX_PARAMETER_SETS + 1) throw new Error("rows"); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inside) {
      if (c === '"') {
        if (text[i + 1] === '"') { value += '"'; i++; } else { inside = false; closed = true; }
      } else value += c;
    } else if (c === separator) field();
    else if (c === "\n" || c === "\r") { line(); if (c === "\r" && text[i + 1] === "\n") i++; }
    else if (c === '"' && !value && !closed) { quoted = true; inside = true; }
    else { if (closed || c === '"') throw new Error("format"); value += c; }
  }
  if (inside) throw new Error("format");
  if (row.length || value || quoted || closed) line();
  return rows;
}

/** Values remain strings so imports never round 64-bit integers or decimals. */
export function parseParameterRows(text: string, format: BatchFormat, names: string[]): ParameterRow[] {
  if (byteLength(text) > 8 * 1024 * 1024) throw new Error("size");
  text = text.replace(/^\uFEFF/, "");
  let rows: ParameterRow[];
  if (format === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("format"); }
    if (!Array.isArray(parsed)) throw new Error("format");
    if (parsed.length > MAX_PARAMETER_SETS) throw new Error("rows");
    rows = parsed.map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("format");
      const record = row as Record<string, unknown>;
      if (Object.keys(record).length !== names.length || names.some(name => !Object.hasOwn(record, name))) throw new Error("header");
      if (names.some(name => record[name] !== null && typeof record[name] !== "string")) throw new Error("strings");
      return Object.fromEntries(names.map(name => [name, record[name]])) as ParameterRow;
    });
  } else {
    const [header, ...body] = delimited(text, format === "csv" ? "," : "\t");
    const columns = header?.map(field => field.value) ?? [];
    if (columns.length !== names.length || new Set(columns).size !== names.length || names.some(name => !columns.includes(name))) throw new Error("header");
    rows = body.map(row => {
      if (row.length !== columns.length) throw new Error("header");
      return Object.fromEntries(columns.map((name, i) => [name, !row[i].quoted && row[i].value === "\\N" ? null : row[i].value]));
    });
  }
  if (!rows.length || rows.length > MAX_PARAMETER_SETS) throw new Error("rows");
  return rows;
}

export function parameterBatchIssue(rows: ParameterRow[], types: Record<string, ParameterKind>): BatchIssue | null {
  if (!rows.length || rows.length > MAX_PARAMETER_SETS) return { code: "rows" };
  let bytes = 0;
  for (let i = 0; i < rows.length; i++) for (const [name, kind] of Object.entries(types)) {
    if (!Object.hasOwn(rows[i], name)) return { code: "header", row: i + 1, name };
    const value = rows[i][name];
    const code = parameterError({ name, kind, value: value ?? "", isNull: value === null, saveDefault: false });
    if (code) return { code: `value.${code}`, row: i + 1, name };
    bytes += value === null ? 0 : byteLength(value);
    if (bytes > 8 * 1024 * 1024) return { code: "size" };
  }
  return null;
}

export function parameterSets(rows: ParameterRow[], types: Record<string, ParameterKind>): QueryParameter[][] {
  return rows.map(row => Object.entries(types).map(([name, kind]) => ({ name, kind, value: row[name] })));
}
