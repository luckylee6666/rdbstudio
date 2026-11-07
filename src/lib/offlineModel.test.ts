import { describe, expect, it } from "vitest";
import { arrangeModelTables, modelFile, newModel, parseModel, parseModelFile, pushModelHistory, removeModelTable, replaceModelTable, type ModelTable, type OfflineModel } from "./offlineModel";
const table = (id: string, name = id): ModelTable => ({ id, name, schema: "", comment: "设计\n说明", position: { x: 50, y: 60 }, columns: [{ id: `${id}_id`, name: "id", type: "BIGINT", nullable: false, primaryKey: true, unique: false, comment: "" }] });
const fixture = () => ({ ...newModel("postgres"), tables: [table("parent"), table("child")], relations: [{ id: "rel", name: "fk_parent", fromTable: "child", fromColumns: ["child_id"], toTable: "parent", toColumns: ["parent_id"], cardinality: "one-many" as const, identifying: true }] });
describe("offline relational model documents", () => {
  it("round-trips typed fields, Unicode comments, stable references and positions", () => {
    const m = fixture(); expect(parseModelFile(modelFile("模型", m))).toEqual({ name: "模型", model: m });
    m.tables[0].name = 'renamed"table'; expect(parseModel(m).relations).toEqual(m.relations);
  });
  it("supports composite and self relationships without positional field references", () => {
    const m = fixture(); m.tables[0].columns.push({ ...m.tables[0].columns[0], id: "more", name: "tenant" });
    m.relations = [{ ...m.relations[0], fromTable: "parent", fromColumns: ["more", "parent_id"], toTable: "parent", toColumns: ["parent_id", "more"] }];
    expect(parseModel(m).relations[0].fromColumns).toEqual(["more", "parent_id"]);
  });
  it("rejects unsupported versions, unknown payloads, invalid names and invalid coordinates", () => {
    for (const value of [{ ...fixture(), version: 3 }, { ...fixture(), sql: "SELECT 1" }, { ...fixture(), dialect: "redis" }]) expect(() => parseModel(value)).toThrow();
    const m = fixture(); m.tables[0].position.x = Infinity; expect(() => parseModel(m)).toThrow();
    m.tables[0].position.x = 0; m.tables[0].name = "\0bad"; expect(() => parseModel(m)).toThrow();
    expect(() => parseModelFile('{"format":"navicat"}')).toThrow();
  });
  it("rejects duplicate IDs/names and nullable primary keys", () => {
    const m = fixture(); m.tables[1].columns[0].id = "parent_id"; m.relations[0].fromColumns = ["parent_id"]; expect(() => parseModel(m)).toThrow("model_duplicate");
    const n = fixture(); n.tables[1].name = "PARENT"; expect(() => parseModel(n)).toThrow("model_duplicate");
    const p = fixture(); p.tables[0].columns[0].nullable = true; expect(() => parseModel(p)).toThrow("model_primary");
  });
  it("blocks deleting referenced columns, and explicitly cascades a removed table", () => {
    const m = fixture(); expect(() => replaceModelTable(m, { ...m.tables[0], columns: [] })).toThrow("model_reference");
    const next = removeModelTable(m, "parent"); expect(next.tables).toHaveLength(1); expect(next.relations).toEqual([]); expect(m.relations).toHaveLength(1);
  });
  it("checks pair arity, missing endpoints, duplicate fields and size before import", () => {
    const m = fixture(); m.relations[0].toColumns = []; expect(() => parseModel(m)).toThrow("model_reference");
    m.relations[0].toColumns = ["missing"]; expect(() => parseModel(m)).toThrow("model_reference");
    m.relations[0].fromColumns = ["child_id", "child_id"]; m.relations[0].toColumns = ["parent_id", "parent_id"]; expect(() => parseModel(m)).toThrow("model_duplicate");
    expect(() => parseModelFile(" ".repeat(2 * 1024 * 1024 + 1))).toThrow("model_size");
  });
  it("bounds undo history and does not mutate prior document snapshots", () => {
    let history: OfflineModel[] = [fixture()]; for (let i = 0; i < 60; i++) history = pushModelHistory(history, fixture());
    expect(history).toHaveLength(50); const old = history[49]; replaceModelTable(old, { ...old.tables[0], name: "changed" }); expect(old.tables[0].name).toBe("parent");
  });
  it("arranges rows below tall cards and multiple self relationships without changing references", () => {
    const model: OfflineModel = { ...newModel(), tables: Array.from({ length: 5 }, (_, i) => table(`t${i}`)), relations: [] };
    for (let i = 0; i < 10; i++) model.relations.push({ id: `r${i}`, name: `self${i}`, fromTable: "t0", toTable: "t0", fromColumns: ["t0_id"], toColumns: ["t0_id"], cardinality: "one-many", identifying: false });
    const arranged = arrangeModelTables(model);
    expect(arranged.tables[4].position.y).toBeGreaterThan(500);
    expect(arranged.tables[0].position).toEqual({ x: 0, y: 0 });
    expect(arranged.tables[3].position.x).toBeGreaterThan(3 * 240);
    expect(arranged.relations).toEqual(model.relations);
    expect(model.tables[0].position).toEqual({ x: 50, y: 60 });
    expect(parseModel(arranged)).toEqual(arranged);
  });
});

describe("version 2 physical key metadata", () => {
  it("keeps version 1 documents readable and rejects extension fields mislabeled as v1", () => {
    const old = { ...fixture(), version: 1 as const }; expect(parseModelFile(modelFile("old", old)).model).toEqual(old);
    old.tables[0].primaryKey = ["parent_id"]; expect(() => parseModel(old)).toThrow();
  });
  it("round-trips independent primary order, named composite uniqueness and referential actions", () => {
    const model = fixture(); const parent = model.tables[0];
    parent.columns.push({ ...parent.columns[0], id: "tenant", name: "tenant" });
    parent.primaryKey = ["tenant", "parent_id"];
    parent.uniqueKeys = [{ id: "uq", name: "business_key", columns: ["parent_id", "tenant"] }];
    const withActions: OfflineModel = { ...model, relations: [{ ...model.relations[0], onDelete: "CASCADE", onUpdate: "RESTRICT" }] };
    expect(parseModelFile(modelFile("v2", withActions)).model).toEqual(withActions);
    parent.columns.reverse(); expect(parseModel(model).tables[0].primaryKey).toEqual(["tenant", "parent_id"]);
  });
  it("rejects inconsistent primary order and dangling, duplicate or colliding unique keys", () => {
    const model = fixture(); model.tables[0].primaryKey = []; expect(() => parseModel(model)).toThrow("model_primary");
    delete model.tables[0].primaryKey;
    model.tables[0].uniqueKeys = [{ id: "uq", name: "business_key", columns: ["missing"] }]; expect(() => parseModel(model)).toThrow("model_reference");
    model.tables[0].uniqueKeys[0].columns = ["parent_id", "parent_id"]; expect(() => parseModel(model)).toThrow("model_duplicate");
    model.tables[0].uniqueKeys[0].columns = ["parent_id"]; model.tables[0].uniqueKeys[0].id = "parent_id"; expect(() => parseModel(model)).toThrow("model_duplicate");
    delete model.tables[0].uniqueKeys; model.tables[1].uniqueKeys = [{ id: "uq", name: "FK_PARENT", columns: ["child_id"] }]; expect(() => parseModel(model)).toThrow("model_duplicate");
  });
  it("rejects unknown actions, explicit nulls, and excess named constraints", () => {
    const model = fixture();
    expect(() => parseModel({ ...model, relations: [{ ...model.relations[0], onDelete: "CASCADE; DROP TABLE x" }] })).toThrow();
    expect(() => parseModel({ ...model, relations: [{ ...model.relations[0], onDelete: null }] })).toThrow();
    model.tables[0].uniqueKeys = Array.from({ length: 65 }, (_, i) => ({ id: `key${i}`, name: `key${i}`, columns: ["parent_id"] }));
    expect(() => parseModel(model)).toThrow("model_limit");
  });
});
