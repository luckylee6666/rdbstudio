import type { DriverKind } from "@/types";

export type SqlDriver = Exclude<DriverKind, "redis">;
export type ColumnExpression = { kind: "column"; tableId: string; name: string };
export type Expression = ColumnExpression
  | { kind: "aggregate"; fn: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX"; column: ColumnExpression | null; distinct: boolean }
  | { kind: "literal"; type: "text" | "number" | "boolean" | "null"; value: string }
  | { kind: "sql"; text: string };
export const comparisonOperators = ["=", "<>", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IS NULL", "IS NOT NULL", "IN", "NOT IN", "BETWEEN", "NOT BETWEEN"] as const;
export type ComparisonOperator = typeof comparisonOperators[number];
export type Condition = { id: string; kind: "rule"; left: Expression; op: ComparisonOperator; values: Expression[] } | ConditionGroup;
export interface ConditionGroup { id: string; kind: "group"; logic: "AND" | "OR"; not: boolean; children: Condition[] }
export interface QuerySource {
  id: string; name: string; schema?: string; alias: string;
  join: "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";
  on: ConditionGroup;
}
export interface QueryDesign {
  sources: QuerySource[];
  columns: Array<{ id: string; expression: Expression; alias: string }>;
  distinct: boolean;
  where: ConditionGroup;
  groupBy: Array<{ id: string; expression: Expression }>;
  having: ConditionGroup;
  orderBy: Array<{ id: string; expression: Expression; direction: "ASC" | "DESC" }>;
  limit: string;
  offset: string;
}
export interface BuilderDraft { version: 1; connectionId: string; catalogSchema: string; query: QueryDesign }

export function emptyGroup(): ConditionGroup {
  return { id: crypto.randomUUID(), kind: "group", logic: "AND", not: false, children: [] };
}
export function emptyQuery(): QueryDesign {
  return { sources: [], columns: [], distinct: false, where: emptyGroup(), groupBy: [], having: emptyGroup(), orderBy: [], limit: "100", offset: "0" };
}

export class QueryBuilderError extends Error {
  constructor(public code: string, public detail = "") { super(code); }
}
function fail(code: string, detail = ""): never { throw new QueryBuilderError(code, detail); }

export function quoteBuilderIdentifier(name: string, driver: SqlDriver): string {
  if (!name || name.includes("\0")) fail("identifier");
  const quote = driver === "mysql" ? "`" : '"';
  return quote + name.replaceAll(quote, quote + quote) + quote;
}

/** Exact decimal text avoids loss of 64-bit integer precision in JavaScript. */
function literal(expression: Extract<Expression, { kind: "literal" }>, driver: SqlDriver): string {
  const value = expression.value;
  if (expression.type === "null") return "NULL";
  if (expression.type === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) fail("number");
    return value;
  }
  if (expression.type === "boolean") {
    if (value !== "true" && value !== "false") fail("boolean");
    return value.toUpperCase();
  }
  if (value.includes("\0")) fail("nul");
  // Hex strings avoid dependence on MySQL's NO_BACKSLASH_ESCAPES mode.
  if (driver === "mysql") {
    const hex = Array.from(new TextEncoder().encode(value), b => b.toString(16).padStart(2, "0")).join("");
    return `CONVERT(X'${hex}' USING utf8mb4)`;
  }
  const escaped = value.replaceAll("'", "''");
  return driver === "postgres" ? `E'${escaped.replaceAll("\\", "\\\\")}'` : `'${escaped}'`;
}

/** Compiles only; execution and authorization stay in the existing SQL editor. */
export function compileQuery(query: QueryDesign, driver: SqlDriver): string {
  if (!["sqlite", "postgres", "mysql"].includes(driver)) fail("driver");
  if (!query.sources.length) fail("source");
  const quote = (name: string) => quoteBuilderIdentifier(name, driver);
  const sources = new Map<string, QuerySource>();
  const aliases = new Set<string>();
  for (const source of query.sources) {
    if (sources.has(source.id)) fail("source");
    const alias = source.alias.toLocaleLowerCase("en-US");
    if (aliases.has(alias)) fail("alias", source.alias);
    quote(source.alias);
    aliases.add(alias);
    sources.set(source.id, source);
  }
  function expression(value: Expression, allowed = sources): string {
    switch (value.kind) {
      case "column": {
        const source = allowed.get(value.tableId);
        if (!source) fail("reference", value.name);
        return `${quote(source.alias)}.${quote(value.name)}`;
      }
      case "aggregate": {
        if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(value.fn)) fail("aggregate");
        if (!value.column && (value.fn !== "COUNT" || value.distinct)) fail("aggregate");
        return `${value.fn}(${value.distinct ? "DISTINCT " : ""}${value.column ? expression(value.column, allowed) : "*"})`;
      }
      case "literal": return literal(value, driver);
      case "sql": {
        // Deliberately conservative: advanced scripts can be edited after handoff.
        const sql = value.text.trim();
        if (!sql || /[;\0]|--|\/\*|\*\//.test(sql)) fail("expression");
        return `(${sql})`;
      }
      default: return fail("expression");
    }
  }
  function condition(node: Condition, allowed = sources, depth = 0): string {
    if (depth > 16) fail("depth");
    if (node.kind === "group") {
      if (!node.children.length) fail("empty_group");
      if (node.logic !== "AND" && node.logic !== "OR") fail("condition");
      return `${node.not ? "NOT " : ""}(${node.children.map(child => condition(child, allowed, depth + 1)).join(` ${node.logic} `)})`;
    }
    if (!comparisonOperators.includes(node.op)) fail("condition");
    const left = expression(node.left, allowed);
    if (node.op === "IS NULL" || node.op === "IS NOT NULL") return `${left} ${node.op}`;
    if (!node.values.length) fail("value");
    if (node.values.some(value => value.kind === "literal" && value.type === "null")) fail("null_comparison");
    const values = node.values.map(value => expression(value, allowed));
    if (node.op === "IN" || node.op === "NOT IN") return `${left} ${node.op} (${values.join(", ")})`;
    if (node.op === "BETWEEN" || node.op === "NOT BETWEEN") {
      if (values.length !== 2) fail("value");
      return `${left} ${node.op} ${values[0]} AND ${values[1]}`;
    }
    if (values.length !== 1) fail("value");
    return `${left} ${node.op} ${values[0]}`;
  }
  function table(source: QuerySource): string {
    return `${source.schema ? `${quote(source.schema)}.` : ""}${quote(source.name)} AS ${quote(source.alias)}`;
  }
  const projection = query.columns.length
    ? query.columns.map(column => `${expression(column.expression)}${column.alias ? ` AS ${quote(column.alias)}` : ""}`).join(",\n  ")
    : "*";
  const lines = [`SELECT${query.distinct ? " DISTINCT" : ""}\n  ${projection}`, `FROM ${table(query.sources[0])}`];
  const visible = new Map<string, QuerySource>([[query.sources[0].id, query.sources[0]]]);
  for (const source of query.sources.slice(1)) {
    if (!["INNER", "LEFT", "RIGHT", "FULL", "CROSS"].includes(source.join)) fail("join");
    if (driver === "mysql" && source.join === "FULL") fail("full_join");
    visible.set(source.id, source);
    lines.push(`${source.join} JOIN ${table(source)}${source.join === "CROSS" ? "" : ` ON ${condition(source.on, visible)}`}`);
  }
  if (query.where.children.length) lines.push(`WHERE ${condition(query.where)}`);
  if (query.groupBy.length) lines.push(`GROUP BY ${query.groupBy.map(item => expression(item.expression)).join(", ")}`);
  if (query.having.children.length) lines.push(`HAVING ${condition(query.having)}`);
  if (query.orderBy.length) lines.push(`ORDER BY ${query.orderBy.map(item => {
    if (item.direction !== "ASC" && item.direction !== "DESC") fail("order");
    return `${expression(item.expression)} ${item.direction}`;
  }).join(", ")}`);
  const integer = (value: string) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail("limit");
    return String(Number(value));
  };
  if (query.limit !== "") lines.push(`LIMIT ${integer(query.limit)}`);
  if (query.offset !== "" && integer(query.offset) !== "0") {
    if (query.limit === "" && driver !== "postgres") fail("offset");
    lines.push(`OFFSET ${integer(query.offset)}`);
  }
  return lines.join("\n") + ";";
}
