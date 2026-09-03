import { describe, expect, it } from "vitest";
import { explainWrap, splitRedisCommands, splitStatements } from "./sql";

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
