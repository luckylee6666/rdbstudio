import { modelPrimaryKey, parseModel, type ModelColumn, type ModelDialect, type ModelRelation, type ModelTable, type OfflineModel } from "./offlineModel";

export interface ModelDdlIssue { code: string; detail: string; tableId?: string; columnId?: string; relationId?: string }
export interface ModelDdlPlan { sql: string; statements: string[]; errors: ModelDdlIssue[]; warnings: ModelDdlIssue[] }
export interface ModelDdlOptions { createNamespaces?: boolean }
const encoder = new TextEncoder();
const quote = (dialect: ModelDialect, value: string) => dialect === "mysql" ? `\`${value.replace(/`/g, "``")}\`` : `"${value.replace(/"/g, '""')}"`;
const literal = (dialect: ModelDialect, value: string) => dialect === "postgres" ? `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'` : `'${value.replace(/'/g, "''")}'`;
const namespace = (d: ModelDialect, table: ModelTable) => table.schema || (d === "postgres" ? "public" : d === "sqlite" ? "main" : "");
const qualified = (d: ModelDialect, table: ModelTable) => (namespace(d, table) ? quote(d, namespace(d, table)) + "." : "") + quote(d, table.name);
const sameColumns = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const sameColumnSet = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));

/** Parse a type, never interpolate a SQL fragment as a type. Custom SQLite
 * declared types and PostgreSQL domain/type identifiers are quoted as names. */
export function modelColumnType(dialect: ModelDialect, input: string): { sql: string; custom?: boolean } | null {
  const value = input.trim(), upper = value.replace(/\s+/g, " ").toUpperCase();
  if (dialect === "sqlite") return { sql: quote(dialect, value) };
  let base = upper, suffix = "";
  if (dialect === "postgres") {
    const arrays = base.match(/(?:\[\])+$/)?.[0] ?? "";
    if (arrays.length > 12) return null;
    suffix = arrays; base = base.slice(0, base.length - arrays.length).trim();
    if (/^(SMALLINT|INTEGER|INT|BIGINT|REAL|DOUBLE PRECISION|SMALLSERIAL|SERIAL|BIGSERIAL|MONEY|BOOLEAN|BOOL|TEXT|BYTEA|DATE|UUID|JSON|JSONB|XML|INET|CIDR|MACADDR|MACADDR8|TSVECTOR|TSQUERY|POINT|LINE|LSEG|BOX|PATH|POLYGON|CIRCLE)$/.test(base)) return suffix && base.endsWith("SERIAL") ? null : { sql: base + suffix };
    const character = base.match(/^(CHAR|CHARACTER|VARCHAR|CHARACTER VARYING|BIT|BIT VARYING|VARBIT)(?:\(\s*(\d+)\s*\))?$/);
    if (character && (!character[2] || Number(character[2]) >= 1 && Number(character[2]) <= 10_485_760)) return { sql: character[1] + (character[2] ? `(${Number(character[2])})` : "") + suffix };
    const decimal = base.match(/^(DECIMAL|NUMERIC)(?:\(\s*(\d+)\s*(?:,\s*([+-]?\d+)\s*)?\))?$/);
    if (decimal && (!decimal[2] || Number(decimal[2]) >= 1 && Number(decimal[2]) <= 1000 && (!decimal[3] || Number(decimal[3]) >= -1000 && Number(decimal[3]) <= 1000))) return { sql: decimal[1] + (decimal[2] ? `(${Number(decimal[2])}${decimal[3] !== undefined ? "," + Number(decimal[3]) : ""})` : "") + suffix };
    if (/^(TIMESTAMP|TIME)(\([0-6]\))?( (WITH|WITHOUT) TIME ZONE)?$/.test(base) || /^(TIMESTAMPTZ|TIMETZ)(\([0-6]\))?$/.test(base) || /^INTERVAL(\([0-6]\))?$/.test(base)) return { sql: base + suffix };
    const raw = value.slice(0, value.length - suffix.length).trim();
    const names = raw.match(/^("(?:[^"\u0000]|"")+"|[a-zA-Z_][\w$]*)(?:\.("(?:[^"\u0000]|"")+"|[a-zA-Z_][\w$]*))?$/);
    // A built-in with unsupported parameters must not become a custom type.
    if (names) {
      const parts = [names[1], names[2]].filter(Boolean).map(n => n.startsWith('"') ? n.slice(1, -1).replace(/""/g, '"') : n.toLowerCase());
      if (parts.every(n => encoder.encode(n).length <= 63)) return { sql: parts.map(n => quote(dialect, n)).join(".") + suffix, custom: true };
    }
    return null;
  }
  if (/^(DATE|JSON|BOOLEAN|BOOL|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|GEOMETRY|POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)$/.test(base)) return { sql: base };
  const integer = base.match(/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(?:\(\s*(\d+)\s*\))?( UNSIGNED)?( ZEROFILL)?$/);
  if (integer && (!integer[2] || Number(integer[2]) >= 1 && Number(integer[2]) <= 255)) return { sql: integer[1] + (integer[2] ? `(${Number(integer[2])})` : "") + (integer[3] ?? "") + (integer[4] ?? "") };
  if (/^(FLOAT|DOUBLE|DOUBLE PRECISION|REAL)( UNSIGNED)?$/.test(base) || /^(DATETIME|TIMESTAMP|TIME)(\([0-6]\))?$/.test(base) || /^YEAR(\(4\))?$/.test(base)) return { sql: base };
  const sized = base.match(/^(CHAR|VARCHAR|BINARY|VARBINARY|BIT)\(\s*(\d+)\s*\)$/);
  if (sized && Number(sized[2]) >= 1 && Number(sized[2]) <= (sized[1] === "BIT" ? 64 : ["CHAR", "BINARY"].includes(sized[1]) ? 255 : 65535)) return { sql: `${sized[1]}(${Number(sized[2])})` };
  if (base === "CHAR" || base === "BINARY") return { sql: base };
  const decimal = base.match(/^(DECIMAL|NUMERIC)(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?( UNSIGNED)?$/);
  if (decimal && (!decimal[2] || Number(decimal[2]) >= 1 && Number(decimal[2]) <= 65 && (!decimal[3] || Number(decimal[3]) <= Math.min(30, Number(decimal[2]))))) return { sql: decimal[1] + (decimal[2] ? `(${Number(decimal[2])}${decimal[3] !== undefined ? "," + Number(decimal[3]) : ""})` : "") + (decimal[4] ?? "") };
  // Quote doubling is valid with and without NO_BACKSLASH_ESCAPES. Backslashes
  // require a known session mode, so refuse rather than emit ambiguous text.
  const enumeration = value.match(/^(ENUM|SET)\s*\((.*)\)$/i);
  if (enumeration && !enumeration[2].includes("\\")) {
    const values: string[] = []; let rest = enumeration[2].trim();
    while (rest) { const token = rest.match(/^'((?:[^']|'')*)'\s*(,\s*|$)/); if (!token) return null; values.push(token[1].replace(/''/g, "'")); rest = rest.slice(token[0].length); if (token[2].includes(",") && !rest) return null; }
    if (values.length && values.length <= (enumeration[1].toUpperCase() === "SET" ? 64 : 65535) && new Set(values).size === values.length) return { sql: `${enumeration[1].toUpperCase()}(${values.map(v => literal(dialect, v)).join(", ")})` };
  }
  return null;
}

export function compileModelDdl(input: OfflineModel, options: ModelDdlOptions = {}): ModelDdlPlan {
  const model = parseModel(input), d = model.dialect;
  const errors: ModelDdlIssue[] = [], warnings: ModelDdlIssue[] = [];
  const issue = (code: string, detail: string, table?: ModelTable, column?: ModelColumn, relation?: ModelRelation) => { if (errors.length < 100) errors.push({ code, detail, tableId: table?.id, columnId: column?.id, relationId: relation?.id }); };
  const warn = (code: string, detail = "") => { if (warnings.length < 100 && !warnings.some(w => w.code === code && w.detail === detail)) warnings.push({ code, detail }); };
  const ident = (name: string, table?: ModelTable, column?: ModelColumn, relation?: ModelRelation) => {
    if (d === "postgres" && encoder.encode(name).length > 63 || d === "mysql" && (Array.from(name).length > 64 || /[\u{10000}-\u{10ffff}]/u.test(name) || /\s$/.test(name))) issue("identifier", name, table, column, relation);
  };
  const byId = new Map(model.tables.map(t => [t.id, t])), types = new Map<string, string>(), names = new Set<string>();
  const keys = new Map(model.tables.map(t => [t.id, [modelPrimaryKey(t), ...(t.uniqueKeys ?? []).map(k => k.columns), ...t.columns.filter(c => c.unique).map(c => [c.id])].filter(cols => cols.length)]));
  for (const r of model.relations) if (r.cardinality === "one-one" && !keys.get(r.fromTable)!.some(cols => sameColumnSet(cols, r.fromColumns))) keys.get(r.fromTable)!.push(r.fromColumns);
  if (!model.tables.length) issue("empty", "");
  for (const table of model.tables) {
    ident(table.name, table); ident(namespace(d, table), table);
    const key = JSON.stringify([namespace(d, table).toLowerCase(), table.name.toLowerCase()]);
    if (names.has(key)) issue("duplicate", `${namespace(d, table)}.${table.name}`, table); names.add(key);
    for (const key of table.uniqueKeys ?? []) {
      ident(key.name, table);
      if (d === "mysql" && key.name.toUpperCase() === "PRIMARY") issue("constraint_name", key.name, table);
    }
    if (!table.columns.length) issue("columns", table.name, table);
    if (d === "sqlite" && namespace(d, table) !== "main" && namespace(d, table) !== "temp") warn("attached", namespace(d, table));
    if (d === "mysql" && Array.from(table.comment).length > 2048) issue("comment_size", table.name, table);
    if (d === "mysql" && table.comment.includes("\\")) issue("backslash", table.name, table);
    for (const column of table.columns) {
      ident(column.name, table, column);
      const type = modelColumnType(d, column.type);
      if (!type) issue("type", `${table.name}.${column.name}: ${column.type}`, table, column);
      else {
        types.set(column.id, type.sql);
        const numeric = type.sql.match(/^(?:NUMERIC|DECIMAL)\((\d+),(-?\d+)\)/);
        if (d === "postgres" && numeric && (Number(numeric[2]) < 0 || Number(numeric[2]) > Number(numeric[1]))) warn("postgres_numeric");
        if (d === "postgres" && /^(SMALLSERIAL|SERIAL|BIGSERIAL)$/.test(type.sql) && column.nullable) issue("serial_nullable", `${table.name}.${column.name}`, table, column);
        if (type.custom) warn("custom_type", type.sql);
      }
      if (d === "mysql" && Array.from(column.comment).length > 1024) issue("comment_size", `${table.name}.${column.name}`, table, column);
      if (d === "mysql" && column.comment.includes("\\")) issue("backslash", `${table.name}.${column.name}`, table, column);
    }
  }
  const foreignNames = new Set<string>();
  for (const relation of model.relations) {
    const child = byId.get(relation.fromTable)!, parent = byId.get(relation.toTable)!;
    ident(relation.name, child, undefined, relation);
    const parentKeys = keys.get(parent.id)!;
    if (!parentKeys.some(cols => sameColumnSet(cols, relation.toColumns))) issue("parent_key", relation.name, child, undefined, relation);
    // MySQL needs the referenced columns at the start of an index, in mapping
    // order. An additional UNIQUE preserves the same composite-key semantics.
    else if (d === "mysql" && !parentKeys.some(cols => sameColumns(cols, relation.toColumns))) parentKeys.push(relation.toColumns);
    for (const action of [relation.onDelete, relation.onUpdate]) {
      if (action === "SET NULL" && relation.fromColumns.some(id => !child.columns.find(c => c.id === id)!.nullable)) issue("set_null", relation.name, child, undefined, relation);
      if (action === "SET DEFAULT") { if (d === "mysql") issue("set_default", relation.name, child, undefined, relation); else warn("set_default", relation.name); }
    }
    if (relation.identifying && relation.fromColumns.some(id => !child.columns.find(c => c.id === id)!.primaryKey)) issue("identifying", relation.name, child, undefined, relation);
    if (d === "sqlite" && namespace(d, child) !== namespace(d, parent)) issue("cross_schema", relation.name, child, undefined, relation);
    const nameKey = JSON.stringify([namespace(d, child).toLowerCase(), d === "mysql" ? "" : child.id, relation.name.toLowerCase()]);
    if (foreignNames.has(nameKey)) issue("constraint_name", relation.name, child, undefined, relation); foreignNames.add(nameKey);
    if (relation.fromColumns.some((id, i) => types.get(id) !== types.get(relation.toColumns[i]))) warn("key_types", relation.name);
  }
  if (d === "mysql") warn("mysql_ddl");
  if (d === "sqlite") { warn("foreign_keys"); if (model.tables.some(t => t.comment || t.columns.some(c => c.comment))) warn("sqlite_comments"); }
  if (!options.createNamespaces && model.tables.some(t => t.schema && !(d === "sqlite" && ["main", "temp"].includes(t.schema)))) warn("namespaces");
  if (d === "mysql" && model.tables.some(t => !t.schema)) warn("current_database");
  warn("server_validation");
  if (errors.length) return { sql: "", statements: [], errors, warnings };
  // PostgreSQL creates backing indexes for key constraints in the schema
  // namespace. Reserve model object/FK names before allocating those names.
  const constraintNames = new Map<string, Set<string>>();
  for (const table of model.tables) {
    const ns = namespace(d, table), used = constraintNames.get(ns) ?? new Set<string>();
    used.add(table.name.toLowerCase());
    for (const r of model.relations.filter(r => r.fromTable === table.id)) used.add(r.name.toLowerCase());
    constraintNames.set(ns, used);
  }
  for (const table of model.tables) for (const key of table.uniqueKeys ?? []) {
    if (d === "postgres") {
      const used = constraintNames.get(namespace(d, table))!;
      if (used.has(key.name.toLowerCase())) issue("constraint_name", key.name, table);
      used.add(key.name.toLowerCase());
    }
  }
  if (errors.length) return { sql: "", statements: [], errors, warnings };
  const keyConstraint = (table: ModelTable, kind: string) => {
    if (d !== "postgres") return "";
    const used = constraintNames.get(namespace(d, table))!;
    const base = `rdb_${kind}_${table.id}`.slice(0, 55);
    let name = base, counter = 1;
    while (used.has(name.toLowerCase())) name = `${base}_${counter++}`;
    used.add(name.toLowerCase());
    return `CONSTRAINT ${quote(d, name)} `;
  };
  const statements: string[] = [];
  if (d === "sqlite") statements.push("PRAGMA foreign_keys = ON");
  if (options.createNamespaces && d !== "sqlite") {
    for (const schema of new Set(model.tables.map(t => namespace(d, t)).filter(Boolean))) statements.push(`${d === "postgres" ? "CREATE SCHEMA" : "CREATE DATABASE"} IF NOT EXISTS ${quote(d, schema)}${d === "mysql" ? " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" : ""}`);
  }
  const namesOf = (table: ModelTable, ids: string[]) => ids.map(id => quote(d, table.columns.find(c => c.id === id)!.name)).join(", ");
  const fk = (r: ModelRelation) => { const child = byId.get(r.fromTable)!, parent = byId.get(r.toTable)!; return `CONSTRAINT ${quote(d, r.name)} FOREIGN KEY (${namesOf(child, r.fromColumns)}) REFERENCES ${d === "sqlite" ? quote(d, parent.name) : qualified(d, parent)} (${namesOf(parent, r.toColumns)})${r.onDelete ? " ON DELETE " + r.onDelete : ""}${r.onUpdate ? " ON UPDATE " + r.onUpdate : ""}`; };
  for (const table of model.tables) {
    const definitions = table.columns.map(c => `${quote(d, c.name)} ${types.get(c.id)}${c.nullable ? "" : " NOT NULL"}${d === "mysql" && c.comment ? " COMMENT " + literal(d, c.comment) : ""}`);
    const primary = modelPrimaryKey(table);
    if (primary.length) definitions.push(`${keyConstraint(table, "pk")}PRIMARY KEY (${namesOf(table, primary)})`);
    const explicit = table.uniqueKeys ?? [];
    for (const key of explicit) definitions.push(`CONSTRAINT ${quote(d, key.name)} UNIQUE (${namesOf(table, key.columns)})`);
    const unique = keys.get(table.id)!;
    const emitted: string[][] = [primary, ...explicit.map(k => k.columns)];
    for (const cols of unique) if (!emitted.some(key => d === "mysql" ? sameColumns(key, cols) : sameColumnSet(key, cols))) {
      emitted.push(cols);
      definitions.push(`${keyConstraint(table, "uq")}UNIQUE (${namesOf(table, cols)})`);
    }
    if (d === "sqlite") for (const r of model.relations.filter(r => r.fromTable === table.id)) definitions.push(fk(r));
    let annotation = "";
    if (d === "sqlite") for (const [label, comment] of [[table.name, table.comment], ...table.columns.map(c => [c.name, c.comment])]) if (comment) annotation += `${label}: ${comment}`.split(/\r\n?|\n/).map(line => "-- " + line).join("\n") + "\n";
    statements.push(`${annotation}CREATE TABLE ${qualified(d, table)} (\n  ${definitions.join(",\n  ")}\n)${d === "mysql" ? " ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" + (table.comment ? " COMMENT=" + literal(d, table.comment) : "") : ""}`);
  }
  if (d !== "sqlite") for (const relation of model.relations) statements.push(`ALTER TABLE ${qualified(d, byId.get(relation.fromTable)!)} ADD ${fk(relation)}`);
  if (d === "postgres") for (const table of model.tables) {
    if (table.comment) statements.push(`COMMENT ON TABLE ${qualified(d, table)} IS ${literal(d, table.comment)}`);
    for (const column of table.columns) if (column.comment) statements.push(`COMMENT ON COLUMN ${qualified(d, table)}.${quote(d, column.name)} IS ${literal(d, column.comment)}`);
  }
  const sql = statements.map(s => s + ";").join("\n\n") + "\n";
  if (encoder.encode(sql).length > 4 * 1024 * 1024) return { sql: "", statements: [], errors: [{ code: "size", detail: "" }], warnings };
  return { sql, statements, errors, warnings };
}
