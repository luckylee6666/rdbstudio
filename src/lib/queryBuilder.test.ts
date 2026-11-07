import { describe, expect, it } from "vitest";
import { compileQuery, emptyGroup, emptyQuery, QueryBuilderError, type ColumnExpression, type Condition, type Expression, type QueryDesign, type QuerySource } from "./queryBuilder";

const column = (tableId: string, name: string): ColumnExpression => ({ kind: "column", tableId, name });
const number = (value: string): Expression => ({ kind: "literal", type: "number", value });
const source = (id: string, name: string, alias = id): QuerySource => ({ id, name, alias, join: "INNER", on: emptyGroup() });
const rule = (left: Expression, value: Expression): Condition => ({ id: crypto.randomUUID(), kind: "rule", left, op: "=", values: [value] });
function base(): QueryDesign { return { ...emptyQuery(), sources: [source("u", "users")] }; }
function expectError(query: QueryDesign, code: string) {
  try { compileQuery(query, "sqlite"); throw new Error("Expected validation failure"); }
  catch (error) { expect(error).toBeInstanceOf(QueryBuilderError); expect((error as QueryBuilderError).code).toBe(code); }
}

describe("visual query SQL compiler", () => {
  it("builds joined aggregates with grouped filters, HAVING, ordering and offsets", () => {
    const query = base();
    const orders = source("o", "orders");
    orders.join = "LEFT";
    orders.on.children = [rule(column("u", "id"), column("o", "user_id"))];
    query.sources.push(orders);
    const total: Expression = { kind: "aggregate", fn: "SUM", column: column("o", "amount"), distinct: false };
    query.columns = [{ id: "name", expression: column("u", "name"), alias: "customer" }, { id: "total", expression: total, alias: "total" }];
    query.where.children = [{ ...emptyGroup(), logic: "OR", children: [rule(column("u", "active"), number("1")), rule(column("u", "id"), number("2"))] }];
    query.groupBy = [{ id: "g", expression: column("u", "name") }];
    query.having.children = [{ id: "h", kind: "rule", left: total, op: ">", values: [number("10")] }];
    query.orderBy = [{ id: "s", expression: total, direction: "DESC" }];
    query.offset = "2";
    expect(compileQuery(query, "sqlite")).toBe('SELECT\n  "u"."name" AS "customer",\n  SUM("o"."amount") AS "total"\nFROM "users" AS "u"\nLEFT JOIN "orders" AS "o" ON ("u"."id" = "o"."user_id")\nWHERE (("u"."active" = 1 OR "u"."id" = 2))\nGROUP BY "u"."name"\nHAVING (SUM("o"."amount") > 10)\nORDER BY SUM("o"."amount") DESC\nLIMIT 100\nOFFSET 2;');
  });

  it.each(["sqlite", "postgres", "mysql"] as const)("quotes schema, identifiers and aliases in %s", driver => {
    const query = base();
    query.sources[0] = { ...query.sources[0], name: 'odd"` table', schema: "two.parts", alias: 'a"`' };
    query.columns = [{ id: "c", expression: column("u", 'q"`'), alias: 'x"`' }];
    const sql = compileQuery(query, driver);
    if (driver === "mysql") expect(sql).toContain('FROM `two.parts`.`odd"`` table` AS `a"```');
    else expect(sql).toContain('FROM "two.parts"."odd""` table" AS "a""`"');
    expect(sql).toContain(driver === "mysql" ? '`a"```.' : '"a""`".');
  });

  it("escapes text independently of server backslash modes and keeps 64-bit numbers exact", () => {
    const query = base();
    query.columns = [{ id: "n", alias: "", expression: number("9223372036854775807") }];
    query.where.children = [rule(column("u", "name"), { kind: "literal", type: "text", value: "O'Reilly\\你好" })];
    expect(compileQuery(query, "sqlite")).toContain("= 'O''Reilly\\你好'");
    expect(compileQuery(query, "postgres")).toContain("= E'O''Reilly\\\\你好'");
    expect(compileQuery(query, "mysql")).toContain("= CONVERT(X'4f275265696c6c795ce4bda0e5a5bd' USING utf8mb4)");
    expect(compileQuery(query, "postgres")).toContain("9223372036854775807");
  });

  it("supports NOT groups, BETWEEN, IN and NULL predicates", () => {
    const query = base();
    query.where.not = true;
    query.where.children = [
      { id: "b", kind: "rule", left: column("u", "id"), op: "BETWEEN", values: [number("1"), number("4")] },
      { id: "i", kind: "rule", left: column("u", "id"), op: "IN", values: [number("6"), number("9")] },
      { id: "n", kind: "rule", left: column("u", "name"), op: "IS NULL", values: [] },
    ];
    expect(compileQuery(query, "sqlite")).toContain('WHERE NOT ("u"."id" BETWEEN 1 AND 4 AND "u"."id" IN (6, 9) AND "u"."name" IS NULL)');
  });

  it("supports self joins but rejects duplicate aliases and references to later joins", () => {
    const query = base();
    const manager = source("m", "users", "manager");
    manager.on.children = [rule(column("u", "manager"), column("m", "id"))];
    query.sources.push(manager);
    expect(compileQuery(query, "postgres")).toContain('INNER JOIN "users" AS "manager"');
    query.sources[1].alias = "U";
    expectError(query, "alias");
    query.sources[1].alias = "manager";
    query.sources.push({ ...source("x", "users"), join: "CROSS" });
    manager.on.children = [rule(column("x", "id"), column("m", "id"))];
    expectError(query, "reference");
  });

  it("rejects missing references and empty nested groups instead of broadening the query", () => {
    const query = base();
    query.where.children = [emptyGroup()];
    expectError(query, "empty_group");
    query.where.children = [rule(column("removed", "id"), number("1"))];
    expectError(query, "reference");
  });

  it.each(["1; DROP TABLE users", "NaN", "Infinity", "0xFF", "", "1 2"])("rejects invalid numeric literal %j", value => {
    const query = base(); query.where.children = [rule(column("u", "id"), number(value))];
    expectError(query, "number");
  });

  it("rejects NULL equality and incomplete BETWEEN", () => {
    const query = base(); query.where.children = [rule(column("u", "name"), { kind: "literal", type: "null", value: "" })];
    expectError(query, "null_comparison");
    query.where.children = [{ id: "b", kind: "rule", left: column("u", "id"), op: "BETWEEN", values: [number("1")] }];
    expectError(query, "value");
  });

  it("validates aggregate arguments and pagination without rounding", () => {
    const query = base();
    query.columns = [{ id: "c", alias: "", expression: { kind: "aggregate", fn: "COUNT", column: null, distinct: false } }];
    expect(compileQuery(query, "sqlite")).toContain("COUNT(*)");
    query.columns[0].expression = { kind: "aggregate", fn: "SUM", column: null, distinct: false };
    expectError(query, "aggregate");
    query.columns = []; query.limit = "9007199254740993";
    expectError(query, "limit");
    query.limit = ""; query.offset = "1";
    expectError(query, "offset");
    expect(compileQuery(query, "postgres")).toContain("OFFSET 1;");
    query.limit = "0"; query.offset = "0";
    expect(compileQuery(query, "sqlite")).toContain("LIMIT 0;");
  });

  it("rejects unsupported FULL JOIN on MySQL", () => {
    const query = base(); const other = source("o", "orders"); other.join = "FULL";
    other.on.children = [rule(column("u", "id"), column("o", "user_id"))]; query.sources.push(other);
    expect(() => compileQuery(query, "mysql")).toThrow("full_join");
    expect(compileQuery(query, "postgres")).toContain("FULL JOIN");
  });

  it("allows custom expressions but refuses script separators and comments", () => {
    const query = base(); query.columns = [{ id: "x", alias: "", expression: { kind: "sql", text: "u.price * u.quantity" } }];
    expect(compileQuery(query, "sqlite")).toContain("(u.price * u.quantity)");
    query.columns[0].expression = { kind: "sql", text: "1); DELETE FROM users; --" };
    expectError(query, "expression");
  });
});
