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
    "SELECT 0x20 FROM t", "SELECT k ISNULL FROM t", "UPDATE t SET n=1", "SELECT * FROM t; SELECT * FROM u", "SELECT * FROM t INTERSECT SELECT * FROM u",
    "WITH u AS (SELECT * FROM t) SELECT * FROM u", "SELECT * FROM (SELECT * FROM t) AS u",
    "SELECT * FROM t WHERE k IN (SELECT k FROM u)", "SELECT * FROM t WHERE n = 1 /* condition */",
    "SELECT * FROM t WHERE id = ?", "SELECT * FROM a JOIN b USING(id)", "SELECT * FROM a JOIN b ON c.id=b.id CROSS JOIN c",
    "SELECT SUM(n) OVER () FROM t", "SELECT * FROM t FOR UPDATE", "SELECT * FROM t WHERE x=1 OR",
    "SELECT * FROM t LIMIT 1, 5", "SELECT * FROM t WHERE k=0; DELETE FROM t",
  ])("rejects the complete statement when a clause cannot be mapped: %s", sql => {
    expect(() => importSelect(sql, "sqlite")).toThrow();
  });

  it.each(["sqlite", "postgres", "mysql"] as const)("round trips named parameters without binding in %s", driver => {
    const query = importSelect("SELECT :Label AS label, ':unbound' AS note FROM t JOIN u ON t.id = :id WHERE t.n BETWEEN :min AND :max AND t.k IN (:id, :ID) HAVING COUNT(*) > :min ORDER BY t.id LIMIT :page_size OFFSET :offset", driver);
    expect(query.columns[0].expression).toEqual({ kind: "parameter", name: "Label" });
    expect(query.columns[1].expression).toMatchObject({ kind: "literal", value: ":unbound" });
    expect(query.limit).toBe(":page_size");
    expect(query.offset).toBe(":offset");
    const sql = compileQuery(query, driver);
    expect(sql).toContain("IN (:id, :ID)");
    expect(sql).toContain("LIMIT :page_size\nOFFSET :offset;");
    expect(convert(sql, driver)).toBe(sql);
  });

  it.each(["SELECT * FROM :table", "SELECT a AS :alias FROM t", "SELECT * FROM t WHERE a = :1",
    "SELECT :x::integer FROM t", "SELECT :x, $1 FROM t", "SELECT :x, @other FROM t",
    "SELECT * FROM t LIMIT :", "SELECT :x$extra FROM t"])("rejects unsupported marker usage in %s", sql => {
    expect(() => importSelect(sql, "postgres")).toThrow();
  });

  it.each(["sqlite", "postgres", "mysql"] as const)("imports mixed UNION branches and a single result tail in %s", driver => {
    const sql = "SELECT a.id AS k FROM current_rows a WHERE a.id >= :min UNION ALL SELECT a.id FROM archive a UNION SELECT 42 ORDER BY k DESC, 1 LIMIT :size OFFSET 2";
    const model = importSelect(sql, driver);
    expect(model.unions?.map(a => a.operator)).toEqual(["UNION ALL", "UNION"]);
    expect(model.unions?.[0].select.sources[0].id).not.toBe(model.sources[0].id);
    expect(model.unions?.[1].select.sources).toEqual([]);
    expect(model.orderBy).toHaveLength(2);
    const generated = compileQuery(model, driver);
    expect(generated).toContain("UNION\nSELECT\n  42\nORDER BY k DESC, 1 ASC\nLIMIT :size\nOFFSET 2;");
    expect(convert(generated, driver)).toBe(generated);
    expect(convert("SELECT 'UNION ALL' AS phrase UNION SELECT 'x'", driver)).toContain("'UNION ALL'");
  });

  it.each([
    "SELECT id FROM t ORDER BY id UNION SELECT id FROM u",
    "SELECT id FROM t OFFSET 0 UNION SELECT id FROM u",
    "SELECT 1 LIMIT 1 UNION SELECT 1",
    "SELECT 1 UNION (SELECT 2 LIMIT 1)", "SELECT 1 UNION", "SELECT 1 UNION ALL ALL SELECT 2",
    "SELECT 1, 2 UNION SELECT 1", "SELECT 1 UNION SELECT 1 ORDER BY 2",
    "SELECT 1 UNION SELECT 2 ORDER BY :sort", "SELECT id FROM t UNION SELECT id FROM u ORDER BY u.id",
    "SELECT 1 UNION SELECT * FROM (SELECT 2)",
  ])("rejects an unsupported compound scope or shape: %s", sql => {
    expect(() => convert(sql)).toThrow();
  });

  it("enforces budgets across the whole compound query", () => {
    expect(() => convert(Array(33).fill("SELECT 1").join(" UNION ALL "))).toThrow("union_limit");
    const arm = (start: number) => "SELECT " + Array.from({ length: 65 }, (_, i) => `:p${i + start}`).join(",");
    expect(() => convert(arm(0) + " UNION ALL " + arm(65))).toThrow("parameter_limit");
  });

  it("bounds input and refuses mode-dependent strings", () => {
    expect(() => importSelect(" ".repeat(65536) + "SELECT * FROM t", "sqlite")).toThrow("import_size");
    expect(() => importSelect("SELECT " + Array(4100).fill("a").join(",") + " FROM t", "sqlite")).toThrow("import_size");
    expect(() => importSelect('SELECT "word" FROM t', "mysql")).toThrow("import_quoting");
    expect(() => importSelect(String.raw`SELECT 'a\nb' FROM t`, "postgres")).toThrow("import_quoting");
  });
});
