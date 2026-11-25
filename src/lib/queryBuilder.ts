import type { DriverKind } from "@/types";

export type SqlDriver = Exclude<DriverKind, "redis">;
export type ColumnExpression = { kind: "column"; tableId: string | null; name: string; bare?: boolean };
export type Expression = ColumnExpression
  | { kind: "parameter"; name: string }
  | { kind: "aggregate"; fn: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX"; column: ColumnExpression | null; distinct: boolean }
  | { kind: "literal"; type: "text" | "number" | "boolean" | "null"; value: string; plainString?: boolean }
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
export interface SelectCore {
  sources: QuerySource[];
  columns: Array<{ id: string; expression: Expression; alias: string }>;
  distinct: boolean;
  where: ConditionGroup;
  groupBy: Array<{ id: string; expression: Expression }>;
  having: ConditionGroup;
}
export type UnionOperator = "UNION" | "UNION ALL";
export interface UnionArm { id: string; operator: UnionOperator; select: SelectCore }
export const MAX_SELECT_ARMS = 32;
export interface QueryDesign extends SelectCore {
  unions?: UnionArm[];
  orderBy: Array<{ id: string; expression: Expression; direction: "ASC" | "DESC" }>;
  limit: string;
  offset: string;
}
export interface BuilderDraft { version: 1; connectionId: string; catalogSchema: string; query: QueryDesign }

export function emptyGroup(): ConditionGroup {
  return { id: crypto.randomUUID(), kind: "group", logic: "AND", not: false, children: [] };
}
export function emptySelect(): SelectCore {
  return { sources: [], columns: [], distinct: false, where: emptyGroup(), groupBy: [], having: emptyGroup() };
}
export function emptyQuery(): QueryDesign {
  return { ...emptySelect(), orderBy: [], limit: "100", offset: "0" };
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
  // Preserve the connection collation of imported MySQL string literals.
  if (expression.plainString && !value.includes("\\")) return "'" + value.replaceAll("'", "''") + "'";
  // Hex strings avoid dependence on MySQL's NO_BACKSLASH_ESCAPES mode.
  if (driver === "mysql") {
    const hex = Array.from(new TextEncoder().encode(value), b => b.toString(16).padStart(2, "0")).join("");
    return `CONVERT(X'${hex}' USING utf8mb4)`;
  }
  const escaped = value.replaceAll("'", "''");
  return driver === "postgres" ? `E'${escaped.replaceAll("\\", "\\\\")}'` : `'${escaped}'`;
}

function compileSelect(query: SelectCore, driver: SqlDriver, parameter: (name: string) => string) {
  if (!query.sources.length && !query.columns.length) fail("source");
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
        if (value.tableId === null) {
          if (!value.bare) return quote(value.name);
          if (!/^[A-Za-z_][A-Za-z_0-9$]*$/.test(value.name)) fail("identifier");
          return value.name;
        }
        const source = allowed.get(value.tableId);
        if (!source) fail("reference", value.name);
        return `${quote(source.alias)}.${quote(value.name)}`;
      }
      case "aggregate": {
        if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(value.fn)) fail("aggregate");
        if (!value.column && (value.fn !== "COUNT" || value.distinct)) fail("aggregate");
        return `${value.fn}(${value.distinct ? "DISTINCT " : ""}${value.column ? expression(value.column, allowed) : "*"})`;
      }
      case "parameter": return parameter(value.name);
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
  const lines = [`SELECT${query.distinct ? " DISTINCT" : ""}\n  ${projection}`];
  const visible = new Map<string, QuerySource>();
  if (query.sources.length) {
    const first = query.sources[0];
    lines.push(`FROM ${table(first)}`);
    visible.set(first.id, first);
  }
  for (const source of query.sources.slice(1)) {
    if (!["INNER", "LEFT", "RIGHT", "FULL", "CROSS"].includes(source.join)) fail("join");
    if (driver === "mysql" && source.join === "FULL") fail("full_join");
    visible.set(source.id, source);
    lines.push(`${source.join} JOIN ${table(source)}${source.join === "CROSS" ? "" : ` ON ${condition(source.on, visible)}`}`);
  }
  if (query.where.children.length) lines.push(`WHERE ${condition(query.where)}`);
  if (query.groupBy.length) lines.push(`GROUP BY ${query.groupBy.map(item => expression(item.expression)).join(", ")}`);
  if (query.having.children.length) lines.push(`HAVING ${condition(query.having)}`);
  return { lines, expression };
}

export function isUnionSortKey(value: Expression): boolean {
  return (value.kind === "column" && value.tableId === null) ||
    (value.kind === "literal" && value.type === "number" && /^[1-9][0-9]*$/.test(value.value) && Number.isSafeInteger(Number(value.value)));
}

export const sourceWidthKey = (source: Pick<QuerySource, "schema" | "name">) =>
  JSON.stringify([source.schema ?? null, source.name]);

function projectionWidth(select: SelectCore, widths: ReadonlyMap<string, number>): number {
  if (select.columns.length) return select.columns.length;
  let total = 0;
  for (const source of select.sources) {
    const width = widths.get(sourceWidthKey(source));
    if (!width) return 0;
    total += width;
  }
  return total;
}

/** Compiles the complete statement; each SELECT owns its aliases, while the
 * result ordering, pagination and parameter budget belong to the statement. */
export function compileQuery(query: QueryDesign, driver: SqlDriver, widths: ReadonlyMap<string, number> = new Map()): string {
  if (!["sqlite", "postgres", "mysql"].includes(driver)) fail("driver");
  const parameterNames = new Set<string>();
  let parameterReferences = 0;
  function parameter(name: string): string {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(name)) fail("parameter_name");
    parameterNames.add(name);
    parameterReferences++;
    if (parameterNames.size > 128 || parameterReferences > 1024) fail("parameter_limit");
    return `:${name}`;
  }
  const arms = query.unions ?? [];
  if (arms.length >= MAX_SELECT_ARMS) fail("union_limit");
  const { lines, expression } = compileSelect(query, driver, parameter);
  let width = projectionWidth(query, widths);
  for (const arm of arms) {
    if (arm.operator !== "UNION" && arm.operator !== "UNION ALL") fail("union_operator");
    const count = projectionWidth(arm.select, widths);
    if (count && width && count !== width) fail("union_width");
    if (count) width = count;
    lines.push(arm.operator, compileSelect(arm.select, driver, parameter).lines.join("\n"));
  }
  if (query.orderBy.length) lines.push(`ORDER BY ${query.orderBy.map(item => {
    if (arms.length) {
      if (!isUnionSortKey(item.expression)) fail("union_order");
      if (width && item.expression.kind === "literal" && Number(item.expression.value) > width) fail("union_order");
    }
    if (item.direction !== "ASC" && item.direction !== "DESC") fail("order");
    return `${expression(item.expression)} ${item.direction}`;
  }).join(", ")}`);
  const pageValue = (value: string) => {
    if (value.startsWith(":")) return parameter(value.slice(1));
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail("limit");
    return String(Number(value));
  };
  if (query.limit !== "") lines.push(`LIMIT ${pageValue(query.limit)}`);
  const offset = query.offset === "" ? "0" : pageValue(query.offset);
  if (offset !== "0") {
    if (query.limit === "" && driver !== "postgres") fail("offset");
    lines.push(`OFFSET ${offset}`);
  }
  return lines.join("\n") + ";";
}
