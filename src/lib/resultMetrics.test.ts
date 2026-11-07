import { describe, expect, it } from "vitest";
import { analyze, type Scatter, type AnalysisRequest, type Scalar } from "./resultAnalysis";
import { chartIssue, DEFAULT_METRIC_OPTIONS, gaugePosition, minus, numericDomain, percentChange } from "./resultCharts";
const scalar = (value: string | null, rounded = false): Scalar => ({ value, rounded });
const scatter = (rows: unknown[][], options: Partial<Extract<AnalysisRequest, { kind: "scatter" }>> = {}) => analyze({ kind: "scatter", rows, labels: true, sample: true, parseStrings: true, ...options }) as Scatter;

describe("raw scatter analysis", () => {
  it("keeps exact pairs, source indices and separate NULL/invalid counters", () => {
    const r = scatter([["9223372036854775806", "1e-512", "a"], ["9223372036854775807", "2e-512", "b"], [null, "bad"], [1, undefined], ["bad", 1], [9007199254740992, 1], [1, Infinity], [true, 1]]);
    expect(r).toMatchObject({ count: 8, numeric: 2, nulls: 2, invalid: 4, sampled: false });
    expect(r.points.map(p => [p.index, p.x.value, p.label])).toEqual([[0, "9223372036854775806", "a"], [1, "9223372036854775807", "b"]]);
    const x = numericDomain([r.xMin, r.xMax], false), y = numericDomain([r.yMin, r.yMax], false);
    expect(r.points.map(p => x.ratio(p.x))).toEqual([0, 1]);
    expect(r.points.map(p => y.ratio(p.y))).toEqual([0, 1]);
    expect(scatter([["1", 2], [1, 2]], { parseStrings: false }).numeric).toBe(1);
  });
  it("samples deterministically with full-data bounds and rejects overflow when disabled", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [i, 5000 - i, `row ${i}`]);
    const r = scatter(rows);
    expect(r).toEqual(scatter(rows)); expect(r.points).toHaveLength(2000);
    expect(r).toMatchObject({ numeric: 5000, sampled: true, xMin: scalar("0"), xMax: scalar("4999"), yMin: scalar("1"), yMax: scalar("5000") });
    expect(new Set(r.points.map(p => p.index)).size).toBe(2000);
    expect(r.points.every((p, i) => !i || p.index > r.points[i - 1].index)).toBe(true);
    expect(r.points.some(p => p.index >= 2000)).toBe(true);
    expect(() => scatter(rows, { sample: false })).toThrow("points");
    expect(scatter(rows.slice(0, 2000), { sample: false }).sampled).toBe(false);
  });
  it("handles empty and constant ranges without fabricated coordinates", () => {
    expect(scatter([])).toMatchObject({ count: 0, points: [], xMin: scalar(null), yMax: scalar(null) });
    expect(scatter([[null, 1], ["bad", 2]]).points).toEqual([]);
    const r = scatter([["1e512", "-1e-512"], ["1e512", "-1e-512"]], { labels: false });
    expect(r.points[0].label).toBeNull();
    expect(numericDomain([r.xMin, r.xMax], false).ratio(r.points[0].x)).toBe(0.5);
    expect(numericDomain([r.yMin, r.yMax], false).ratio(r.points[0].y)).toBe(0.5);
  });
  it("applies row, byte and depth limits even to rejected pairs", () => {
    expect(() => scatter(Array(50_001).fill([1, 1]))).toThrow("rows");
    expect(() => scatter([[null, null, "x".repeat(17 * 1024 * 1024)]])).toThrow("size");
    let nested: unknown = 0; for (let i = 0; i < 34; i++) nested = [nested];
    expect(() => scatter([[1, 2, nested]])).toThrow("depth");
  });
});

describe("exact metric arithmetic and validation", () => {
  it("subtracts adjacent large integers and propagates approximation", () => {
    expect(minus(scalar("9223372036854775807"), scalar("9223372036854775806"))).toEqual(scalar("1"));
    expect(minus(scalar("0.3", true), scalar("0.1"))).toEqual(scalar("0.2", true));
    expect(minus(scalar(null), scalar("1"))).toEqual(scalar(null));
  });
  it("uses absolute reference, rounds signed percentages and rejects zero/NULL references", () => {
    expect(percentChange(scalar("-5"), scalar("-10"))).toEqual(scalar("50"));
    expect(percentChange(scalar("-15"), scalar("-10"))).toEqual(scalar("-50"));
    expect(percentChange(scalar("2"), scalar("3"))).toEqual(scalar("-33.333333", true));
    expect(percentChange(scalar("4"), scalar("3"))).toEqual(scalar("33.333333", true));
    expect(percentChange(scalar("1.000000005"), scalar("1"))).toEqual(scalar("0.000001", true));
    expect(percentChange(scalar("0.999999995"), scalar("1"))).toEqual(scalar("-0.000001", true));
    expect(percentChange(scalar("2", true), scalar("1"))).toEqual(scalar("100", true));
    for (const reference of ["0", null]) expect(percentChange(scalar("1"), scalar(reference))).toEqual(scalar(null));
    expect(percentChange(scalar(null), scalar("1"))).toEqual(scalar(null));
    expect(percentChange(scalar("2e-512"), scalar("1e-512"))).toEqual(scalar("100"));
  });
  it("clamps gauge pointers but preserves an explicit outside indicator", () => {
    expect(gaugePosition(scalar("9223372036854775806"), "9223372036854775805", "9223372036854775807")).toEqual({ ratio: 0.5, outside: 0 });
    expect(gaugePosition(scalar("-1"), "0", "100")).toEqual({ ratio: 0, outside: -1 });
    expect(gaugePosition(scalar("101"), "0", "100")).toEqual({ ratio: 1, outside: 1 });
    expect(gaugePosition(scalar("0"), "0", "100")).toEqual({ ratio: 0, outside: 0 });
    expect(gaugePosition(scalar("100"), "0", "100")).toEqual({ ratio: 1, outside: 0 });
    expect(gaugePosition(scalar(null), "0", "100")).toEqual({ ratio: null, outside: 0 });
  });
  it("requires source summaries and valid targets/ranges", () => {
    const base = { rows: [], series: [{ key: "a", label: "a", values: [], summary: scalar("12") }] };
    expect(chartIssue({ ...base, kind: "value" })).toBeNull();
    expect(chartIssue({ ...base, kind: "value", series: [{ key: "a", label: "a", values: [] }] })).toBe("summary");
    expect(chartIssue({ ...base, kind: "kpi" })).toBe("target");
    expect(chartIssue({ ...base, kind: "kpi", options: { ...DEFAULT_METRIC_OPTIONS, target: "1e512" } })).toBeNull();
    for (const [minimum, maximum] of [["5", "5"], ["6", "5"], ["bad", "5"]]) expect(chartIssue({ ...base, kind: "gauge", options: { ...DEFAULT_METRIC_OPTIONS, minimum, maximum } })).toBe("range");
  });
});
