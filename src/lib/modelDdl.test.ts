import { describe, expect, it } from "vitest";
import { compileModelDdl, modelColumnType } from "./modelDdl";
import { newModel, type ModelDialect, type OfflineModel, type ModelTable } from "./offlineModel";
const table = (id: string): ModelTable => ({ id, name: id, schema: "", comment: "中文 ' comment", position: { x: 0, y: 0 }, columns: [{ id: id + "_id", name: "id", type: "INTEGER", primaryKey: true, nullable: false, unique: false, comment: "field ' comment" }, { id: id + "_parent", name: "parent_id", type: "INTEGER", primaryKey: false, nullable: true, unique: false, comment: "" }] });
export function ddlFixture(dialect: ModelDialect): OfflineModel { return { ...newModel(dialect), tables: [table("child"), table("parent")], relations: [{ id: "fk", name: "fk_parent", fromTable: "child", toTable: "parent", fromColumns: ["child_parent"], toColumns: ["parent_id"], cardinality: "one-one", identifying: false }] }; }
describe("model forward engineering", () => {
  it.each(["sqlite", "postgres", "mysql"] as const)("generates complete %s tables, keys and comments without mutating the model", d => {
    const model = ddlFixture(d), original = structuredClone(model), plan = compileModelDdl(model);
    expect(plan.errors).toEqual([]); expect(plan.sql).toContain("CREATE TABLE"); expect(plan.sql).toContain("PRIMARY KEY"); expect(plan.sql).toContain("UNIQUE"); expect(plan.sql).toContain("FOREIGN KEY"); expect(plan.sql).not.toMatch(/DROP|TRUNCATE|IF NOT EXISTS/); expect(model).toEqual(original);
    if (d !== "sqlite") expect(plan.statements.findIndex(s => s.startsWith("ALTER TABLE"))).toBeGreaterThan(plan.statements.findIndex(s => s.includes("CREATE TABLE") && s.includes('parent')));
    else expect(plan.statements[0]).toBe("PRAGMA foreign_keys = ON");
  });
  it("handles composite key permutations and keys implied by one-to-one relationships", () => {
    const m = ddlFixture("mysql"); m.tables[1].columns[1].primaryKey = true; m.tables[1].columns[1].nullable = false;
    m.relations[0].fromColumns = ["child_parent", "child_id"]; m.relations[0].toColumns = ["parent_parent", "parent_id"];
    expect(compileModelDdl(m).sql).toContain("UNIQUE (`parent_id`, `id`)");
    m.tables.push(table("third")); m.relations.push({ ...m.relations[0], id: "fk_third", name: "fk_third", fromTable: "third", fromColumns: ["third_id", "third_parent"], toTable: "child", toColumns: ["child_parent", "child_id"], cardinality: "one-many" });
    expect(compileModelDdl(m).errors).toEqual([]);
  });
  it("rejects non-key parents, inconsistent identifying relations and empty tables before producing any SQL", () => {
    const m = ddlFixture("postgres"); m.relations[0].toColumns = ["parent_parent"];
    expect(compileModelDdl(m).errors[0].code).toBe("parent_key"); expect(compileModelDdl(m).statements).toEqual([]);
    m.relations[0].toColumns = ["parent_id"]; m.relations[0].identifying = true;
    expect(compileModelDdl(m).errors[0].code).toBe("identifying");
    expect(compileModelDdl(newModel()).errors[0].code).toBe("empty");
  });
  it("qualifies default schemas, rejects collisions, and keeps namespace creation explicit", () => {
    const m = ddlFixture("postgres"); expect(compileModelDdl(m).sql).toContain('"public"."child"');
    m.tables[0].schema = "business"; expect(compileModelDdl(m).sql).not.toContain("CREATE SCHEMA"); expect(compileModelDdl(m, { createNamespaces: true }).sql).toContain('CREATE SCHEMA IF NOT EXISTS "business"');
    m.tables[0].schema = "public"; m.tables[1].name = "child"; expect(compileModelDdl(m).errors[0].code).toBe("duplicate");
    const s = ddlFixture("sqlite"); s.tables[0].schema = "other"; expect(compileModelDdl(s).errors[0].code).toBe("cross_schema");
  });
  it("quotes identifiers and literal comments, refusing ambiguous MySQL escapes", () => {
    const m = ddlFixture("postgres"); m.tables[0].name = 'weird"table'; m.tables[0].comment = "a\\b'; DROP TABLE x; --";
    const sql = compileModelDdl(m).sql; expect(sql).toContain('"weird""table"'); expect(sql).toContain("E'a\\\\b''; DROP TABLE x; --'");
    m.dialect = "mysql"; expect(compileModelDdl(m).errors.some(e => e.code === "backslash")).toBe(true);
    m.tables[0].comment = "中".repeat(2049); expect(compileModelDdl(m).errors.some(e => e.code === "comment_size")).toBe(true);
  });
  it("guards identifier byte limits and MySQL cross-table foreign-key name collisions", () => {
    const m = ddlFixture("postgres"); m.tables[0].name = "中".repeat(22); expect(compileModelDdl(m).errors[0].code).toBe("identifier");
    m.dialect = "mysql"; m.tables[0].name = "child"; m.relations.push({ ...m.relations[0], id: "other", fromTable: "parent", toTable: "child", fromColumns: ["parent_parent"], toColumns: ["child_id"] }); expect(compileModelDdl(m).errors.some(e => e.code === "constraint_name")).toBe(true);
  });
  it("allocates PostgreSQL key names without colliding with declared foreign keys or tables", () => {
    const m = ddlFixture("postgres"); m.relations[0].name = "rdb_pk_child"; m.tables[1].name = "rdb_uq_child";
    const plan = compileModelDdl(m); expect(plan.errors).toEqual([]);
    expect(plan.sql).toContain('CONSTRAINT "rdb_pk_child_1" PRIMARY KEY');
    expect(plan.sql).toContain('CONSTRAINT "rdb_uq_child_1" UNIQUE');
    expect(plan.sql).toContain('ADD CONSTRAINT "rdb_pk_child" FOREIGN KEY');
  });
  it("parses PostgreSQL scalar/array/domain types and modern numeric scales", () => {
    for (const input of ["INTEGER", "numeric(2,-3)", "NUMERIC(3,5)", "TIMESTAMP(6) WITH TIME ZONE", "uuid[]", 'public."custom type"[]']) expect(modelColumnType("postgres", input)).not.toBeNull();
    for (const input of ["NUMERIC(1001)", "NUMERIC(2,1001)", "SERIAL[]", "INTEGER NOT NULL", "TEXT); DROP TABLE x; --"]) expect(modelColumnType("postgres", input)).toBeNull();
    const m = ddlFixture("postgres"); m.tables[0].columns[1].type = "SERIAL";
    expect(compileModelDdl(m).errors.some(e => e.code === "serial_nullable")).toBe(true);
  });
  it("accepts common MySQL widths and enumerations while rejecting fragment injection", () => {
    for (const input of ["TINYINT(1)", "INT(11) UNSIGNED", "BIGINT(20)", "DECIMAL(20,8)", "enum('a','b''c')", "BIT(64)"]) expect(modelColumnType("mysql", input)).not.toBeNull();
    for (const input of ["INT(256)", "DECIMAL(66)", "ENUM('a',)", "ENUM('a\\b')", "VARCHAR(20) UNIQUE", "INT; DROP TABLE x", "BIT(65)"]) expect(modelColumnType("mysql", input)).toBeNull();
  });
  it("quotes every SQLite declared type, even SQL-looking text", () => { expect(modelColumnType("sqlite", 'TEXT"); DROP TABLE x;--')?.sql).toBe('"TEXT""); DROP TABLE x;--"'); });
});

describe("physical keys and referential actions", () => {
  it.each(["sqlite", "postgres", "mysql"] as const)("preserves primary order and named unique FK targets in %s", dialect => {
    const model = ddlFixture(dialect), parent = model.tables[1];
    parent.columns[1].primaryKey = true; parent.columns[1].nullable = false;
    parent.primaryKey = ["parent_parent", "parent_id"];
    parent.uniqueKeys = [{ id: "business", name: "business_key", columns: ["parent_id"] }];
    model.relations[0].onDelete = "SET NULL"; model.relations[0].onUpdate = "CASCADE";
    const plan = compileModelDdl(model), q = dialect === "mysql" ? "`" : '"';
    expect(plan.errors).toEqual([]);
    expect(plan.sql).toContain(`PRIMARY KEY (${q}parent_id${q}, ${q}id${q})`);
    expect(plan.sql).toContain(`CONSTRAINT ${q}business_key${q} UNIQUE (${q}id${q})`);
    expect(plan.sql).toContain("ON DELETE SET NULL ON UPDATE CASCADE");
  });
  it("deduplicates implicit uniqueness while retaining explicit names and checks engine namespaces", () => {
    const model = ddlFixture("postgres");
    model.tables[0].uniqueKeys = [{ id: "named", name: "rdb_pk_child", columns: ["child_parent"] }];
    const plan = compileModelDdl(model); expect(plan.errors).toEqual([]);
    expect(plan.sql.match(/UNIQUE/g)).toHaveLength(1); expect(plan.sql).toContain('CONSTRAINT "rdb_pk_child_1" PRIMARY KEY');
    model.tables[1].uniqueKeys = [{ id: "other", name: "rdb_pk_child", columns: ["parent_id"] }];
    expect(compileModelDdl(model).errors.some(e => e.code === "constraint_name")).toBe(true);
    model.dialect = "mysql"; expect(compileModelDdl(model).errors).toEqual([]);
    model.tables[1].uniqueKeys[0].name = "PRIMARY"; expect(compileModelDdl(model).errors.some(e => e.code === "constraint_name")).toBe(true);
  });
  it("blocks impossible SET NULL and MySQL SET DEFAULT while explaining implicit defaults elsewhere", () => {
    const model = ddlFixture("mysql"); model.relations[0].onDelete = "SET NULL"; model.tables[0].columns[1].nullable = false;
    expect(compileModelDdl(model).errors.some(e => e.code === "set_null")).toBe(true);
    model.relations[0].onDelete = "SET DEFAULT"; expect(compileModelDdl(model).errors.some(e => e.code === "set_default")).toBe(true);
    model.dialect = "postgres"; expect(compileModelDdl(model).warnings.some(e => e.code === "set_default")).toBe(true);
  });
});
