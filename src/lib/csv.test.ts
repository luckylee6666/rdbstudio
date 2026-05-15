import { describe, expect, it } from "vitest";
import { toCSV } from "./csv";

describe("toCSV", () => {
  it("emits header + rows joined with newlines", () => {
    const out = toCSV(["a", "b"], [
      [1, 2],
      [3, 4],
    ]);
    expect(out).toBe("a,b\n1,2\n3,4");
  });

  it("escapes fields containing comma / newline / quote with double quotes", () => {
    const out = toCSV(["col"], [
      ["hello, world"],
      ["line1\nline2"],
      ["has \"quote\""],
      ["carriage\rreturn"],
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("col");
    expect(lines[1]).toBe('"hello, world"');
    // newline inside field -> whole field quoted, so the record spans two "lines"
    expect(lines[2]).toBe('"line1');
    expect(lines[3]).toBe('line2"');
    expect(lines[4]).toBe('"has ""quote"""');
    expect(lines[5]).toBe('"carriage\rreturn"');
  });

  it("emits empty string for null/undefined", () => {
    const out = toCSV(["a", "b", "c"], [[null, undefined, "x"]]);
    expect(out).toBe("a,b,c\n,,x");
  });

  it("JSON-stringifies objects then applies escaping rules", () => {
    const out = toCSV(["obj"], [[{ a: 1, b: "x, y" }]]);
    const lines = out.split("\n");
    // JSON.stringify produces {"a":1,"b":"x, y"} which has both commas and
    // quotes, so it must be wrapped and quotes doubled.
    const expectedInner = JSON.stringify({ a: 1, b: "x, y" });
    const escaped = `"${expectedInner.replace(/"/g, '""')}"`;
    expect(lines[1]).toBe(escaped);
  });

  it("escapes header cells using the same rules", () => {
    const out = toCSV(["has,comma", "plain"], [["x", "y"]]);
    const [header, row] = out.split("\n");
    expect(header).toBe('"has,comma",plain');
    expect(row).toBe("x,y");
  });

  it("handles numbers / booleans via JSON.stringify path", () => {
    const out = toCSV(["n", "b"], [[42, true]]);
    expect(out).toBe("n,b\n42,true");
  });
});
