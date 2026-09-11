import { describe, expect, it } from "vitest";
import {
  flattenPlan,
  parseMysqlPlan,
  parsePgPlan,
  parseSqliteQueryPlan,
  selfCost,
  stripLeadingExplain,
} from "./explain";

// Shape of a real `EXPLAIN (FORMAT JSON, VERBOSE true)` result: a Hash Join
// over a Seq Scan and a Hash → Index Scan (two levels of nesting).
const PG_SAMPLE = [
  {
    Plan: {
      "Node Type": "Hash Join",
      "Join Type": "Inner",
      "Startup Cost": 12.5,
      "Total Cost": 120.75,
      "Plan Rows": 500,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Schema: "public",
          Alias: "o",
          "Startup Cost": 0,
          "Total Cost": 80.25,
          "Plan Rows": 4000,
        },
        {
          "Node Type": "Hash",
          "Startup Cost": 10,
          "Total Cost": 10.5,
          "Plan Rows": 200,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Relation Name": "users",
              "Index Name": "users_pkey",
              Alias: "u",
              "Startup Cost": 0.29,
              "Total Cost": 9.5,
              "Plan Rows": 200,
            },
          ],
        },
      ],
    },
    "Planning Time": 0.2,
  },
];

describe("parsePgPlan", () => {
  it("parses a nested plan into the right tree with costs and rows", () => {
    const root = parsePgPlan(PG_SAMPLE);
    expect(root.label).toBe("Hash Join");
    expect(root.cost).toEqual({ startup: 12.5, total: 120.75 });
    expect(root.rows).toBe(500);
    expect(root.children).toHaveLength(2);

    const [scan, hash] = root.children;
    expect(scan.label).toBe("Seq Scan");
    expect(scan.detail).toBe("public.orders o");
    expect(scan.cost).toEqual({ startup: 0, total: 80.25 });
    expect(scan.rows).toBe(4000);
    expect(scan.children).toHaveLength(0);

    expect(hash.label).toBe("Hash");
    expect(hash.children).toHaveLength(1);
    const idx = hash.children[0];
    expect(idx.label).toBe("Index Scan");
    expect(idx.detail).toBe("users u"); // no Schema field → bare relation + alias
    expect(idx.cost).toEqual({ startup: 0.29, total: 9.5 });
  });

  it("accepts the rows[0][0]-as-JSON-string form", () => {
    const root = parsePgPlan(JSON.stringify(PG_SAMPLE));
    expect(root.label).toBe("Hash Join");
    expect(root.children).toHaveLength(2);
    expect(root.children[1].children[0].label).toBe("Index Scan");
  });

  it("assigns unique node ids", () => {
    const ids = flattenPlan([parsePgPlan(PG_SAMPLE)]).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it("falls back to the index name when there is no relation", () => {
    const root = parsePgPlan([
      {
        Plan: {
          "Node Type": "Index Only Scan",
          "Index Name": "users_pkey",
          "Startup Cost": 0,
          "Total Cost": 4.3,
          "Plan Rows": 1,
        },
      },
    ]);
    expect(root.detail).toBe("users_pkey");
  });

  it("throws on invalid JSON strings", () => {
    expect(() => parsePgPlan("not json at all")).toThrow(/not valid JSON/);
  });

  it("throws on structures without a Plan object", () => {
    expect(() => parsePgPlan([{}])).toThrow(/missing the root "Plan"/);
    expect(() => parsePgPlan(42)).toThrow(/missing the root "Plan"/);
    expect(() => parsePgPlan(null)).toThrow(/missing the root "Plan"/);
  });

  it("captures EXPLAIN ANALYZE actual timing when present", () => {
    const root = parsePgPlan([
      {
        Plan: {
          "Node Type": "Seq Scan",
          "Startup Cost": 0,
          "Total Cost": 10,
          "Plan Rows": 100,
          "Actual Total Time": 1.234,
          "Actual Rows": 42,
          "Actual Loops": 3,
        },
      },
    ]);
    expect(root.actual).toEqual({ time: 1.234, rows: 42, loops: 3 });
  });

  it("leaves actual undefined for plain EXPLAIN plans", () => {
    expect(parsePgPlan(PG_SAMPLE).actual).toBeUndefined();
  });
});

// Shape of a real MySQL `EXPLAIN FORMAT=JSON` result: an ordering_operation
// wrapping a two-table nested_loop.
const MYSQL_SAMPLE = {
  query_block: {
    select_id: 1,
    cost_info: { query_cost: "4.55" },
    ordering_operation: {
      using_filesort: true,
      nested_loop: [
        {
          table: {
            table_name: "customers",
            access_type: "ALL",
            possible_keys: ["PRIMARY"],
            rows_examined_per_scan: 10,
            rows_produced_per_join: 10,
            filtered: "100.00",
            cost_info: {
              read_cost: "0.25",
              eval_cost: "1.00",
              prefix_cost: "1.25",
              data_read_per_join: "160",
            },
          },
        },
        {
          table: {
            table_name: "orders",
            access_type: "ref",
            possible_keys: ["idx_customer"],
            key: "idx_customer",
            rows_examined_per_scan: 3,
            rows_produced_per_join: 30,
            filtered: "100.00",
            cost_info: {
              read_cost: "0.50",
              eval_cost: "3.00",
              prefix_cost: "4.75",
              data_read_per_join: "480",
            },
          },
        },
      ],
    },
  },
};

describe("parseMysqlPlan", () => {
  it("parses a nested_loop under an ordering_operation", () => {
    const root = parseMysqlPlan(MYSQL_SAMPLE);
    expect(root.label).toBe("Query Block");
    expect(root.detail).toBe("select_id 1");
    expect(root.cost).toEqual({ startup: 0, total: 4.55 });
    expect(root.children).toHaveLength(1);

    const ordering = root.children[0];
    expect(ordering.label).toBe("Ordering");
    expect(ordering.detail).toBe("using filesort");
    expect(ordering.children).toHaveLength(1);

    const loop = ordering.children[0];
    expect(loop.label).toBe("Nested Loop");
    expect(loop.children.map((n) => n.label)).toEqual([
      "customers (ALL)",
      "orders (ref)",
    ]);

    const [customers, orders] = loop.children;
    expect(customers.detail).toBe("possible PRIMARY · filtered 100.00%");
    expect(customers.cost).toEqual({ startup: 0.25, total: 1.25 });
    expect(customers.rows).toBe(10);
    expect(customers.children).toHaveLength(0);

    expect(orders.detail).toBe("key idx_customer · filtered 100.00%");
    expect(orders.cost).toEqual({ startup: 0.5, total: 4.75 });
    expect(orders.rows).toBe(3);
  });

  it("accepts the rows[0][0]-as-JSON-string form", () => {
    const root = parseMysqlPlan(JSON.stringify(MYSQL_SAMPLE));
    expect(root.label).toBe("Query Block");
    expect(root.children[0].children[0].children).toHaveLength(2);
  });

  it("assigns unique node ids across wrappers and tables", () => {
    const ids = flattenPlan([parseMysqlPlan(MYSQL_SAMPLE)]).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });

  it("falls back to generic nodes for unknown operation keys", () => {
    const root = parseMysqlPlan({
      query_block: {
        select_id: 1,
        mystery_operation: {
          table: { table_name: "t", access_type: "ALL" },
        },
      },
    });
    expect(root.label).toBe("Query Block");
    const mystery = root.children[0];
    expect(mystery.label).toBe("Mystery Operation");
    expect(mystery.children).toHaveLength(1);
    expect(mystery.children[0].label).toBe("t (ALL)");
  });

  it("renders a generic root for an unrecognized object shape", () => {
    const root = parseMysqlPlan({ something: "else" });
    expect(root.label).toBe("Query Block");
    expect(root.children).toHaveLength(0);
  });

  it("throws on invalid JSON strings", () => {
    expect(() => parseMysqlPlan("not json at all")).toThrow(/not valid JSON/);
  });
});

describe("selfCost", () => {
  it("subtracts the children's cumulative totals", () => {
    const root = parsePgPlan(PG_SAMPLE);
    // 120.75 − (80.25 + 10.5) = 30.0
    expect(selfCost(root)).toBeCloseTo(30.0, 5);
    // Leaf: self cost is its own total.
    expect(selfCost(root.children[0])).toBeCloseTo(80.25, 5);
    // Hash: 10.5 − 9.5 = 1.0
    expect(selfCost(root.children[1])).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for nodes without cost info", () => {
    expect(selfCost({ id: "x", label: "n", children: [] })).toBe(0);
  });
});

describe("parseSqliteQueryPlan", () => {
  it("builds a forest from [id, parent, notused, detail] rows", () => {
    const roots = parseSqliteQueryPlan([
      [3, 0, 0, "SCAN t1"],
      [10, 0, 0, "SCAN t2"],
      [15, 10, 0, "SEARCH t3 USING INDEX idx_a (a=?)"],
      [21, 15, 0, "USE TEMP B-TREE FOR ORDER BY"],
    ]);
    expect(roots).toHaveLength(2);
    expect(roots[0].label).toBe("SCAN t1");
    expect(roots[0].children).toHaveLength(0);
    expect(roots[1].label).toBe("SCAN t2");
    expect(roots[1].children).toHaveLength(1);
    const search = roots[1].children[0];
    expect(search.label).toBe("SEARCH t3 USING INDEX idx_a (a=?)");
    expect(search.children).toHaveLength(1);
    expect(search.children[0].label).toBe("USE TEMP B-TREE FOR ORDER BY");
  });

  it("coerces string ids/parents (driver-dependent serialization)", () => {
    const roots = parseSqliteQueryPlan([
      ["2", "0", "0", "SCAN a"],
      ["5", "2", "0", "SEARCH b USING COVERING INDEX ib (x=?)"],
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children[0].label).toBe(
      "SEARCH b USING COVERING INDEX ib (x=?)"
    );
  });

  it("treats rows with an unknown parent as roots instead of dropping them", () => {
    const roots = parseSqliteQueryPlan([[5, 99, 0, "SCAN x"]]);
    expect(roots).toHaveLength(1);
    expect(roots[0].label).toBe("SCAN x");
  });

  it("returns an empty forest for zero rows (e.g. SELECT 1)", () => {
    expect(parseSqliteQueryPlan([])).toEqual([]);
  });

  it("throws on malformed rows", () => {
    expect(() => parseSqliteQueryPlan([[1, 0]])).toThrow(/row/);
    expect(() =>
      parseSqliteQueryPlan([["a", "b", 0, "SCAN t"]])
    ).toThrow(/not numbers/);
  });
});

describe("stripLeadingExplain", () => {
  it("strips a bare EXPLAIN", () => {
    expect(stripLeadingExplain("EXPLAIN SELECT 1")).toBe("SELECT 1");
  });

  it("strips EXPLAIN QUERY PLAN across whitespace/newlines", () => {
    expect(stripLeadingExplain("explain query plan\nSELECT * FROM t")).toBe(
      "SELECT * FROM t"
    );
  });

  it("strips parenthesized option lists", () => {
    expect(
      stripLeadingExplain("EXPLAIN (FORMAT JSON, ANALYZE false) SELECT x FROM t")
    ).toBe("SELECT x FROM t");
  });

  it("strips bare ANALYZE/VERBOSE modifiers", () => {
    expect(stripLeadingExplain("EXPLAIN ANALYZE VERBOSE SELECT 1")).toBe(
      "SELECT 1"
    );
  });

  it("strips MySQL-style FORMAT=JSON", () => {
    expect(stripLeadingExplain("EXPLAIN FORMAT=JSON SELECT 1")).toBe("SELECT 1");
  });

  it("leaves plain statements untouched (modulo trim)", () => {
    expect(stripLeadingExplain("SELECT 1")).toBe("SELECT 1");
    expect(stripLeadingExplain("  SELECT 1  ")).toBe("SELECT 1");
    expect(stripLeadingExplain("SELECT explain FROM t")).toBe(
      "SELECT explain FROM t"
    );
  });

  it("does not fire on identifiers that merely start with EXPLAIN", () => {
    expect(stripLeadingExplain("EXPLAINED_VIEW_QUERY")).toBe(
      "EXPLAINED_VIEW_QUERY"
    );
  });
});
