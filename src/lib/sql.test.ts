import { describe, expect, it } from "vitest";
import {
  explainWrap,
  isReadOnlyStatement,
  splitRedisCommands,
  splitStatements,
} from "./sql";

describe("splitStatements", () => {
  it("splits simple semicolon-separated statements", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      "SELECT 1",
    ]);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    expect(splitStatements('SELECT "a;b" FROM t; SELECT 1')).toEqual([
      'SELECT "a;b" FROM t',
      "SELECT 1",
    ]);
  });

  it("ignores semicolons in line comments", () => {
    expect(splitStatements("SELECT 1; -- foo;bar\nSELECT 2")).toEqual([
      "SELECT 1",
      "-- foo;bar\nSELECT 2",
    ]);
  });

  it("ignores semicolons in block comments", () => {
    expect(splitStatements("SELECT 1 /* a;b */; SELECT 2")).toEqual([
      "SELECT 1 /* a;b */",
      "SELECT 2",
    ]);
  });

  it("handles escaped quotes inside strings", () => {
    expect(splitStatements("INSERT INTO t VALUES ('it\\'s ok'); SELECT 1"))
      .toEqual(["INSERT INTO t VALUES ('it\\'s ok')", "SELECT 1"]);
  });

  it("returns single element when no semicolons", () => {
    expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("trims and skips empty parts", () => {
    expect(splitStatements(";;\n  SELECT 1;\n  ;")).toEqual(["SELECT 1"]);
  });

  it("does not split on semicolons inside dollar-quoted strings", () => {
    expect(
      splitStatements("DO $$ BEGIN INSERT INTO t VALUES (1); END $$; SELECT 1")
    ).toEqual(["DO $$ BEGIN INSERT INTO t VALUES (1); END $$", "SELECT 1"]);
    expect(
      splitStatements(
        "SELECT $body$ a; b $body$; SELECT $tag$DELETE FROM t;$tag$"
      )
    ).toEqual([
      "SELECT $body$ a; b $body$",
      "SELECT $tag$DELETE FROM t;$tag$",
    ]);
  });

  it("does not treat $1 placeholders as dollar quotes", () => {
    expect(splitStatements("SELECT $1; SELECT $2")).toEqual([
      "SELECT $1",
      "SELECT $2",
    ]);
  });
});

describe("explainWrap", () => {
  it("wraps SELECT for sqlite", () => {
    expect(explainWrap("SELECT * FROM t", "sqlite")).toBe(
      "EXPLAIN QUERY PLAN SELECT * FROM t"
    );
  });

  it("wraps SELECT for postgres", () => {
    expect(explainWrap("SELECT 1", "postgres")).toBe(
      "EXPLAIN (ANALYZE false, VERBOSE true) SELECT 1"
    );
  });

  it("wraps SELECT for mysql", () => {
    expect(explainWrap("SELECT 1", "mysql")).toBe("EXPLAIN SELECT 1");
  });

  it("strips trailing semicolon", () => {
    expect(explainWrap("SELECT 1;", "mysql")).toBe("EXPLAIN SELECT 1");
  });

  it("avoids double-wrap when user already prefixed EXPLAIN", () => {
    expect(explainWrap("EXPLAIN SELECT 1", "postgres")).toBe(
      "EXPLAIN (ANALYZE false, VERBOSE true) SELECT 1"
    );
  });

  it("strips a parenthesized EXPLAIN before re-wrapping", () => {
    expect(
      explainWrap("EXPLAIN (FORMAT JSON, ANALYZE true) SELECT 1", "postgres")
    ).toBe("EXPLAIN (ANALYZE false, VERBOSE true) SELECT 1");
  });

  it("wraps with FORMAT JSON where the driver supports it", () => {
    expect(explainWrap("SELECT 1", "postgres", { format: "json" })).toBe(
      "EXPLAIN (ANALYZE false, VERBOSE true, FORMAT JSON) SELECT 1"
    );
    expect(explainWrap("SELECT 1", "mysql", { format: "json" })).toBe(
      "EXPLAIN FORMAT=JSON SELECT 1"
    );
  });

  it("wraps EXPLAIN ANALYZE for postgres", () => {
    expect(
      explainWrap("SELECT * FROM t", "postgres", {
        analyze: true,
        format: "json",
      })
    ).toBe("EXPLAIN (ANALYZE true, VERBOSE true, FORMAT JSON) SELECT * FROM t");
    expect(explainWrap("SELECT 1", "postgres", { analyze: true })).toBe(
      "EXPLAIN (ANALYZE true, VERBOSE true) SELECT 1"
    );
  });
});

describe("isReadOnlyStatement", () => {
  it("accepts plain reads", () => {
    expect(isReadOnlyStatement("SELECT 1")).toBe(true);
    expect(isReadOnlyStatement("  select * from t;  ")).toBe(true);
    expect(isReadOnlyStatement("VALUES (1), (2)")).toBe(true);
    expect(isReadOnlyStatement("TABLE users")).toBe(true);
    expect(isReadOnlyStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(
      true
    );
  });

  it("skips leading comments and EXPLAIN wrappers", () => {
    expect(isReadOnlyStatement("-- comment\n/* block */ SELECT 1")).toBe(true);
    expect(isReadOnlyStatement("EXPLAIN ANALYZE SELECT 1")).toBe(true);
    expect(
      isReadOnlyStatement("EXPLAIN (ANALYZE true, FORMAT JSON) SELECT 1")
    ).toBe(true);
  });

  it("rejects writes and unknown statements", () => {
    expect(isReadOnlyStatement("DELETE FROM t")).toBe(false);
    expect(isReadOnlyStatement("UPDATE t SET a = 1")).toBe(false);
    expect(isReadOnlyStatement("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isReadOnlyStatement("DROP TABLE t")).toBe(false);
    expect(isReadOnlyStatement("SET search_path = public")).toBe(false);
    expect(isReadOnlyStatement("")).toBe(false);
  });

  it("rejects data-modifying CTEs", () => {
    expect(
      isReadOnlyStatement(
        "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
      )
    ).toBe(false);
  });

  it("rejects multi-statement scripts", () => {
    expect(isReadOnlyStatement("SELECT 1; DELETE FROM t")).toBe(false);
    expect(isReadOnlyStatement("SELECT 1; SELECT 2")).toBe(false);
  });

  it("sees through an EXPLAIN prefix on a write", () => {
    expect(isReadOnlyStatement("EXPLAIN ANALYZE DELETE FROM t")).toBe(false);
  });
});

describe("splitRedisCommands", () => {
  it("gives every line its own command", () => {
    expect(splitRedisCommands("PING\nPING")).toEqual(["PING", "PING"]);
  });

  it("drops blank lines and trims", () => {
    expect(splitRedisCommands("  GET a \n\n  GET b  \n")).toEqual([
      "GET a",
      "GET b",
    ]);
  });

  it("keeps a newline inside a quoted argument", () => {
    expect(splitRedisCommands('SET k "line1\nline2"\nGET k')).toEqual([
      'SET k "line1\nline2"',
      "GET k",
    ]);
  });

  it("does not treat an escaped quote as the end of a value", () => {
    expect(splitRedisCommands('SET k "a\\"b"\nGET k')).toEqual([
      'SET k "a\\"b"',
      "GET k",
    ]);
  });

  it("never splits on semicolons", () => {
    expect(splitRedisCommands("SET k a;b")).toEqual(["SET k a;b"]);
  });
});
