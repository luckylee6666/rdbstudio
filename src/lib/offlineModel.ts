export const MODEL_LIMITS = { bytes: 2 * 1024 * 1024, tables: 200, columns: 256, totalColumns: 4096, relations: 1000, keys: 64, totalKeys: 1000, historyBytes: 16 * 1024 * 1024 };
export type ModelDialect = "sqlite" | "postgres" | "mysql";
export interface ModelColumn { id: string; name: string; type: string; nullable: boolean; primaryKey: boolean; unique: boolean; comment: string }
export interface ModelUniqueKey { id: string; name: string; columns: string[] }
export const MODEL_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const;
export type ModelReferentialAction = typeof MODEL_ACTIONS[number];
export interface ModelTable { id: string; name: string; schema: string; comment: string; position: { x: number; y: number }; columns: ModelColumn[]; primaryKey?: string[]; uniqueKeys?: ModelUniqueKey[] }
export interface ModelRelation { id: string; name: string; fromTable: string; fromColumns: string[]; toTable: string; toColumns: string[]; cardinality: "one-one" | "one-many"; identifying: boolean; onUpdate?: ModelReferentialAction; onDelete?: ModelReferentialAction }
export interface OfflineModel { version: 1 | 2; dialect: ModelDialect; tables: ModelTable[]; relations: ModelRelation[] }
export interface ModelRecord { id: string; revision: string; name: string; updated_at: string; model: OfflineModel }
export interface ModelSummary { id: string; revision: string; name: string; updated_at: string; dialect: ModelDialect; tables: number; relations: number }
export interface SaveModel { id: string | null; revision: string | null; name: string; model: OfflineModel }
export const newModel = (dialect: ModelDialect = "sqlite"): OfflineModel => ({ version: 2, dialect, tables: [], relations: [] });
const fail = (code = "invalid"): never => { throw new Error(`model_${code}`); };
const object = (v: unknown, keys: string[], optional: string[] = []): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const o = v as Record<string, unknown>;
  if (keys.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !keys.includes(k) && !optional.includes(k))) return fail();
  return o;
};
const text = (v: unknown, max: number, empty = true, multiline = false): string => {
  if (typeof v !== "string" || v.length > max || (!empty && !v.trim()) || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v)) return fail();
  return v;
};
const id = (v: unknown) => { const s = text(v, 64, false); return /^[a-zA-Z0-9_-]+$/.test(s) ? s : fail(); };
const bool = (v: unknown): boolean => typeof v === "boolean" ? v : fail();
const array = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail("limit");
const distinct = (values: string[]) => { if (new Set(values).size !== values.length) fail("duplicate"); };
export function parseModel(value: unknown): OfflineModel {
  const m = object(value, ["version", "dialect", "tables", "relations"]);
  if (m.version !== 1 && m.version !== 2) return fail("version");
  if (typeof m.dialect !== "string" || !["sqlite", "postgres", "mysql"].includes(m.dialect)) return fail();
  let columnCount = 0, keyCount = 0;
  const tables = array(m.tables, MODEL_LIMITS.tables).map(value => {
    const t = object(value, ["id", "name", "schema", "comment", "position", "columns"], m.version === 2 ? ["primaryKey", "uniqueKeys"] : []), p = object(t.position, ["x", "y"]);
    if (![p.x, p.y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000)) return fail();
    const columns = array(t.columns, MODEL_LIMITS.columns).map(value => {
      const c = object(value, ["id", "name", "type", "nullable", "primaryKey", "unique", "comment"]);
      const column = { id: id(c.id), name: text(c.name, 128, false), type: text(c.type, 256, false), nullable: bool(c.nullable), primaryKey: bool(c.primaryKey), unique: bool(c.unique), comment: text(c.comment, 4096, true, true) };
      if (column.primaryKey && column.nullable) return fail("primary");
      return column;
    });
    columnCount += columns.length;
    distinct(columns.map(c => c.name.toLowerCase()));
    const extras: Pick<ModelTable, "primaryKey" | "uniqueKeys"> = {};
    const keyColumns = (value: unknown, allowEmpty = false) => {
      const ids = array(value, MODEL_LIMITS.columns).map(id); distinct(ids);
      if ((!allowEmpty && !ids.length) || ids.some(id => !columns.some(c => c.id === id))) return fail("reference");
      return ids;
    };
    if (Object.hasOwn(t, "primaryKey")) {
      extras.primaryKey = keyColumns(t.primaryKey, true);
      const flags = columns.filter(c => c.primaryKey).map(c => c.id);
      if (flags.length !== extras.primaryKey.length || flags.some(id => !extras.primaryKey!.includes(id))) return fail("primary");
    }
    if (Object.hasOwn(t, "uniqueKeys")) {
      extras.uniqueKeys = array(t.uniqueKeys, MODEL_LIMITS.keys).map(value => {
        const k = object(value, ["id", "name", "columns"]);
        return { id: id(k.id), name: text(k.name, 128, false), columns: keyColumns(k.columns) };
      });
      distinct(extras.uniqueKeys.map(k => k.name.toLowerCase())); keyCount += extras.uniqueKeys.length;
    }
    return { ...extras, id: id(t.id), name: text(t.name, 128, false), schema: text(t.schema, 128), comment: text(t.comment, 4096, true, true), position: { x: p.x as number, y: p.y as number }, columns };
  });
  if (columnCount > MODEL_LIMITS.totalColumns || keyCount > MODEL_LIMITS.totalKeys) return fail("limit");
  distinct(tables.map(t => JSON.stringify([t.schema.toLowerCase(), t.name.toLowerCase()])));
  const byId = new Map(tables.map(t => [t.id, t]));
  const relations = array(m.relations, MODEL_LIMITS.relations).map(value => {
    const r = object(value, ["id", "name", "fromTable", "fromColumns", "toTable", "toColumns", "cardinality", "identifying"], m.version === 2 ? ["onUpdate", "onDelete"] : []);
    const fromTable = id(r.fromTable), toTable = id(r.toTable), fromColumns = array(r.fromColumns, 16).map(id), toColumns = array(r.toColumns, 16).map(id);
    if (!fromColumns.length || fromColumns.length !== toColumns.length || !byId.has(fromTable) || !byId.has(toTable)) return fail("reference");
    distinct(fromColumns); distinct(toColumns);
    if (fromColumns.some(c => !byId.get(fromTable)!.columns.some(col => col.id === c)) || toColumns.some(c => !byId.get(toTable)!.columns.some(col => col.id === c))) return fail("reference");
    if (r.cardinality !== "one-one" && r.cardinality !== "one-many") return fail();
    const actions: Pick<ModelRelation, "onUpdate" | "onDelete"> = {};
    for (const key of ["onUpdate", "onDelete"] as const) if (Object.hasOwn(r, key)) {
      if (!MODEL_ACTIONS.includes(r[key] as ModelReferentialAction)) return fail();
      actions[key] = r[key] as ModelReferentialAction;
    }
    return { ...actions, id: id(r.id), name: text(r.name, 128, false), fromTable, fromColumns, toTable, toColumns, cardinality: r.cardinality, identifying: bool(r.identifying) } as ModelRelation;
  });
  distinct([...tables.map(t => t.id), ...tables.flatMap(t => t.columns.map(c => c.id)), ...relations.map(r => r.id), ...tables.flatMap(t => (t.uniqueKeys ?? []).map(k => k.id))]);
  distinct(relations.map(r => JSON.stringify([r.fromTable, r.name.toLowerCase()])));
  for (const table of tables) distinct([...(table.uniqueKeys ?? []).map(k => k.name.toLowerCase()), ...relations.filter(r => r.fromTable === table.id).map(r => r.name.toLowerCase())]);
  const result: OfflineModel = { version: m.version, dialect: m.dialect as ModelDialect, tables, relations };
  if (new TextEncoder().encode(JSON.stringify(result)).length > MODEL_LIMITS.bytes) return fail("size");
  return result;
}
export const modelPrimaryKey = (table: ModelTable): string[] => table.primaryKey ?? table.columns.filter(c => c.primaryKey).map(c => c.id);
export function modelFile(name: string, model: OfflineModel): string {
  const contents = JSON.stringify({ format: "rdbstudio-model", name: text(name, 100, false), model: parseModel(model) });
  if (new TextEncoder().encode(contents).length > MODEL_LIMITS.bytes) return fail("size");
  return contents;
}
export function parseModelFile(input: string): { name: string; model: OfflineModel } {
  if (new TextEncoder().encode(input).length > MODEL_LIMITS.bytes) return fail("size");
  let raw: unknown;
  try { raw = JSON.parse(input.replace(/^\uFEFF/, "")); } catch { return fail(); }
  const file = object(raw, ["format", "name", "model"]);
  if (file.format !== "rdbstudio-model") return fail("version");
  return { name: text(file.name, 100, false), model: parseModel(file.model) };
}
/** Removing a column/table must explicitly remove its dependent relations too. */
export function removeModelTable(model: OfflineModel, tableId: string): OfflineModel {
  return { ...model, tables: model.tables.filter(t => t.id !== tableId), relations: model.relations.filter(r => r.fromTable !== tableId && r.toTable !== tableId) };
}
export function replaceModelTable(model: OfflineModel, table: ModelTable): OfflineModel {
  // Refuse dangling references; UI must explicitly remove affected relationships first.
  return parseModel({ ...model, tables: model.tables.some(t => t.id === table.id) ? model.tables.map(t => t.id === table.id ? table : t) : [...model.tables, table] });
}
export function pushModelHistory(history: OfflineModel[], model: OfflineModel): OfflineModel[] {
  const result = [...history, model].slice(-50);
  let bytes = result.reduce((n, m) => n + JSON.stringify(m).length * 2, 0);
  while (result.length && bytes > MODEL_LIMITS.historyBytes) bytes -= JSON.stringify(result.shift()).length * 2;
  return result;
}

/** Reserve visible space above cards for independently labelled self relations. */
export const modelSelfRelationSpace = (count: number) => count > 0 ? 64 + (count - 1) * 40 : 0;
export function arrangeModelTables(model: OfflineModel): OfflineModel {
  let y = 0;
  const tables: ModelTable[] = [];
  for (let start = 0; start < model.tables.length; start += 4) {
    const row = model.tables.slice(start, start + 4);
    let height = 0;
    row.forEach((table, column) => {
      const loops = model.relations.filter(r => r.fromTable === table.id && r.toTable === table.id).length;
      height = Math.max(height, modelSelfRelationSpace(loops) + 54 + Math.min(12, table.columns.length) * 24 + (table.columns.length > 12 ? 24 : 0));
      tables.push({ ...table, position: { x: column * 320, y } });
    });
    y += height + 80;
  }
  return { ...model, tables };
}
