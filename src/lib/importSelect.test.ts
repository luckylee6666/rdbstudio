import { describe, expect, it } from "vitest";
import { compileQuery, type SqlDriver } from "./queryBuilder";
import { importSelect } from "./importSelect";

const convert = (sql: string, driver: SqlDriver = "sqlite") => compileQuery(importSelect(sql, driver), driver);

describe("SELECT import", () => {
  it.each(["sqlite", "postgres", "mysql"] as const)("imports an editable join, conditions and aggregate in %s", driver => {
    const sql = `select distinct c.region area, sum(s.amount) revenue
      from customers c left outer join sales s on c.id = s.customer
      where (c.active = 1 or c.region in ('NE', 'O''Brien')) and not (s.amount between 0 and 3)
      group by c.region having sum(s.amount) > 10 order by revenue desc limit 20 offset 2;`;
    const model = importSelect(sql, driver);
    expect(model.sources.map(s => [s.name, s.alias, s.join])).toEqual([["customers", "c", "INNER"], ["sales", "s", "LEFT"]]);
    expect(model.columns[1]).toMatchObject({ alias: "revenue", expression: { kind: "aggregate", fn: "SUM", column: { tableId: model.sources[1].id, name: "amount" } } });
    expect(model.where).toMatchObject({ logic: "AND", children: [{ logic: "OR" }, { not: true }] });
    const rendered = compileQuery(model, driver);
    expect(rendered).toContain("ORDER BY revenue DESC");
    expect(convert(rendered, driver)).toBe(rendered);
  });

  it("keeps unqualified names unbound for output aliases and same-name joined columns", () => {
    const sql = convert("SELECT a.k AS sort_key, b.v FROM a CROSS JOIN b WHERE k > 0 ORDER BY sort_key");
    expect(sql).toContain("WHERE (k > 0)");
    expect(sql).toContain("ORDER BY sort_key ASC");
    expect(sql).not.toContain("LIMIT");
  });

  it("handles dialect quoting and exact numeric and text literals", () => {
    expect(convert('SELECT Foo.Bar FROM "Audit"."Sales" AS Foo', "postgres")).toContain('"foo"."bar"');
    expect(convert('SELECT "a""b" FROM "my rows"')).toContain('"a""b"');
    expect(convert('SELECT 9223372036854775807 FROM t')).toContain('9223372036854775807');
    expect(convert("SELECT 'x; FROM y' FROM t")).toContain("'x; FROM y'");
    const pg = String.raw`SELECT E'a\\b''c' AS label FROM t`;
    expect(convert(pg, "postgres")).toContain(String.raw`E'a\\b''c'`);
    expect(convert("SELECT CONVERT(X'615c62' USING utf8mb4) FROM t", "mysql")).toContain("CONVERT(X'615c62' USING utf8mb4)");
    expect(convert("SELECT DISTINCT COUNT(DISTINCT code) FROM t")).toContain("COUNT(DISTINCT code)");
  });

  it("retains OR/AND precedence, joins in scope and explicit zero limit", () => {
    const model = importSelect("SELECT * FROM A x JOIN B y ON x.id=y.id WHERE x.n=1 OR y.k=2 AND x.x IS NOT NULL LIMIT 0", "sqlite");
    expect(model.where).toMatchObject({logic: "OR", children: [{kind:"rule"}, {logic:"AND", children:[{op:"="},{op:"IS NOT NULL"}]}]});
    expect(model.limit).toBe("0");
  });

  it.each([
    "SELECT 0x20 FROM t", "SELECT k ISNULL FROM t", "UPDATE t SET n=1", "SELECT * FROM t; SELECT * FROM u", "SELECT * FROM t UNION SELECT * FROM u",
    "WITH u AS (SELECT * FROM t) SELECT * FROM u", "SELECT * FROM (SELECT * FROM t) AS u",
    "SELECT * FROM t WHERE k IN (SELECT k FROM u)", "SELECT * FROM t WHERE n = 1 /* condition */",
    "SELECT * FROM t WHERE id = :id", "SELECT * FROM a JOIN b USING(id)", "SELECT * FROM a JOIN b ON c.id=b.id CROSS JOIN c",
    "SELECT SUM(n) OVER () FROM t", "SELECT * FROM t FOR UPDATE", "SELECT * FROM t WHERE x=1 OR",
    "SELECT * FROM t LIMIT 1, 5", "SELECT * FROM t WHERE k=0; DELETE FROM t",
  ])("rejects the complete statement when a clause cannot be mapped: %s", sql => {
    expect(() => importSelect(sql, "sqlite")).toThrow();
  });

  it("bounds input and refuses mode-dependent strings", () => {
    expect(() => importSelect(" ".repeat(65536) + "SELECT * FROM t", "sqlite")).toThrow("import_size");
    expect(() => importSelect("SELECT " + Array(4100).fill("a").join(",") + " FROM t", "sqlite")).toThrow("import_size");
    expect(() => importSelect('SELECT "word" FROM t', "mysql")).toThrow("import_quoting");
    expect(() => importSelect(String.raw`SELECT 'a\nb' FROM t`, "postgres")).toThrow("import_quoting");
  });
});
