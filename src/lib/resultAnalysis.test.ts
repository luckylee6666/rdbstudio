import { describe, expect, it } from "vitest";
import { analyze, chartRatio, decimal, decimalText, maxMagnitude, type Profile, type Pivot, type Aggregate } from "./resultAnalysis";
const profile = (values: unknown[], parseStrings = true) => analyze({ kind: "profile", rows: values.map(v => [v]), parseStrings }) as Profile;
const pivot = (rows: unknown[][], aggregate: Aggregate = "sum", split = true) => analyze({ kind: "pivot", rows, aggregate, split, parseStrings: true }) as Pivot;
describe("snapshot analysis", () => {
  it("preserves 64-bit and decimal sums, comparisons and median", () => {
    const result = profile(["9223372036854775807", "9223372036854775806", "0.1", "0.2", null]);
    expect(result.sum.value).toBe("18446744073709551613.3");
    expect(result.min.value).toBe("0.1"); expect(result.max.value).toBe("9223372036854775807");
    expect(result.median.value).toBe("4611686018427387903.1");
    expect(result.mean).toEqual({ value: "4611686018427387903.325", rounded: false });
    expect(profile(["-0.00000000000000000001", "0"]).mean.value).toBe("-0.000000000000000000005");
  });
  it("marks nonterminating means and rounds signed halfway values", () => {
    expect(profile([1, 0, 0]).mean).toEqual({ value: "0.333333333333", rounded: true });
    expect(profile([-1, 0, 0]).mean).toEqual({ value: "-0.333333333333", rounded: true });
    expect(profile([2, 0, 0]).mean).toEqual({ value: "0.666666666667", rounded: true });
  });
  it("separates NULL, empty, types and object key order", () => {
    const r = profile([null, undefined, "", "NULL", 1, "1", true, { b: 2, a: 1 }, { a: 1, b: 2 }, "__proto__", "constructor"]);
    expect(r.nulls).toBe(2); expect(r.empty).toBe(1); expect(r.distinct).toBe(8); expect(r.singletons).toBe(7);
    expect(r.top[0].count).toBe(2); expect(r.numeric).toBe(2);
    expect(profile(["1", 1], false).numeric).toBe(1);
  });
  it("rejects lossy numeric inputs and nondecimal grammars without silently coercing", () => {
    const r = profile([9007199254740992, Infinity, NaN, "1e999999", "0x10", " ", true, "3x", "9".repeat(257)]);
    expect(r.numeric).toBe(0); expect(r.invalid).toBe(9); expect(r.sum.value).toBe(null);
    expect(decimalText(decimal("-.25e2")!)).toBe("-25");
    expect(decimalText(decimal("+1.0e-3")!)).toBe("0.001");
  });
  it("computes weighted pivot totals from source rows and keeps missing cells NULL", () => {
    const r = pivot([["a", "x", 2], ["a", "x", 4], ["b", "y", 30], ["b", "y", null], ["b", "y", "bad"]], "mean");
    expect(r.cells.map(row => row.map(v => v.value))).toEqual([["3", null], [null, "30"]]);
    expect(r.total.value).toBe("12"); expect(r.nulls).toBe(1); expect(r.invalid).toBe(1);
    expect(r.columnTotals.map(v => v.value)).toEqual(["3", "30"]);
    expect(pivot([["a", "x", null], ["b", "y", null]], "count").cells.map(r => r.map(v => v.value))).toEqual([["1", "0"], ["0", "1"]]);
    expect(pivot([["a", null, "bad"], ["a", null, null]], "nonNull", false).total.value).toBe("1");
  });
  it("keeps typed groups collision-free including NULL and prototype names", () => {
    const r = pivot([[null, "__proto__", 1], ["NULL", "__proto__", 2], [1, "constructor", 3], ["1", "constructor", 4], ["", "", 5]], "sum");
    expect(r.rows.length).toBe(5); expect(r.columns.length).toBe(3); expect(r.total.value).toBe("15");
  });
  it("bounds rows, groups, bytes and recursion, returning no partial statistics", () => {
    expect(() => profile(Array(50_001).fill(1))).toThrow("rows");
    expect(() => pivot(Array.from({ length: 201 }, (_, i) => [i, null, 1]))).toThrow("groups");
    expect(() => pivot(Array.from({ length: 41 }, (_, i) => [null, i, 1]))).toThrow("groups");
    expect(() => profile(["x".repeat(17 * 1024 * 1024)])).toThrow("size");
    let nested: unknown = 0; for (let i = 0; i < 34; i++) nested = [nested];
    expect(() => profile([nested])).toThrow("depth");
  });
  it("handles empty snapshots and top values without implying a sample", () => {
    expect(profile([])).toMatchObject({ count: 0, distinct: 0, top: [], mean: { value: null } });
    const r = profile(Array.from({ length: 30 }, (_, i) => i).concat([29, 29]));
    expect(r.distinct).toBe(30); expect(r.top.length).toBe(20); expect(r.top[0]).toMatchObject({ label: "29", count: 3 });
  });
  it("scales chart geometry without overflowing very large or tiny numbers", () => {
    expect(chartRatio("1e512", "2e512")).toBe(0.5);
    expect(chartRatio("-1e-512", "2e-512")).toBe(-0.5);
    const result = profile(["9".repeat(256) + "e512", "9".repeat(256) + "e512"]);
    const max = maxMagnitude([result.sum]);
    expect(max).toBe(result.sum.value); expect(chartRatio(max, max)).toBe(1);
  });
});
