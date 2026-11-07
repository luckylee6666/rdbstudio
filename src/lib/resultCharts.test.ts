import { describe, expect, it } from "vitest";
import { chartIssue, numericDomain, plus, stackLevels, treeRectangles, waterfallLevels, type ChartInput, type ChartSeries } from "./resultCharts";
import type { Scalar } from "./resultAnalysis";
const scalars = (values: (string | null)[]): Scalar[] => values.map(value => ({ value, rounded: false }));
const series = (rows: (string | null)[][]): ChartSeries[] => rows.map((values, i) => ({ key: String(i), label: `Series ${i}`, values: scalars(values) }));
const input = (kind: ChartInput["kind"], values: (string | null)[][]): ChartInput => ({ kind, series: series(values), rows: (values[0] ?? []).map((_, i) => ({ key: String(i), label: String(i), type: "string", count: 1 })) });
describe("chart numeric models", () => {
  it("separates positive/negative baselines and skips missing values", () => {
    const levels = stackLevels(series([["10", "-8", null], ["-2", "4", "3"], ["5", "-1", "1"]]));
    expect(levels.map(s => s.map(v => [v.start.value, v.end.value]))).toEqual([
      [["0", "10"], ["0", "-8"], ["0", "0"]],
      [["0", "-2"], ["0", "4"], ["0", "3"]],
      [["10", "15"], ["-8", "-9"], ["3", "4"]],
    ]);
    expect(levels[0][2].value.value).toBeNull();
  });
  it("keeps exact cumulative balances and a separate final total", () => {
    const levels = waterfallLevels(scalars(["9223372036854775807", "0.1", "-9223372036854775806"]));
    expect(levels.map(v => v.end.value)).toEqual(["9223372036854775807", "9223372036854775807.1", "1.1", "1.1"]);
    expect(levels.at(-1)!.start.value).toBe("0");
    expect(plus({ value: "0.1", rounded: true }, { value: "0.2", rounded: false })).toEqual({ value: "0.3", rounded: true });
  });
  it("includes zero, handles signed domains and avoids overflow/underflow before normalization", () => {
    const d = numericDomain(scalars(["-1e512", "3e512"]));
    expect(d.ratio({ value: "0", rounded: false })).toBe(0.25);
    expect(d.ratio({ value: "3e512", rounded: false })).toBe(1);
    const tiny = numericDomain(scalars(["-1e-512", "3e-512"]));
    expect(tiny.ratio({ value: "0", rounded: false })).toBe(0.25);
    expect(numericDomain(scalars(["0", "0"])).ratio({ value: "0", rounded: false })).toBe(0);
  });
  it("covers a treemap proportionally without overlapping rectangles", () => {
    const rectangles = treeRectangles(scalars(["1", "2", "3", "4", null, "0"]), 800, 300);
    expect(rectangles).toHaveLength(4);
    for (const rect of rectangles) {
      expect(rect.width * rect.height).toBeCloseTo(800 * 300 * (rect.index + 1) / 10, 5);
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(800); expect(rect.y + rect.height).toBeLessThanOrEqual(300);
      for (const other of rectangles) if (rect !== other) expect(Math.min(rect.x + rect.width, other.x + other.width) <= Math.max(rect.x, other.x) + 1e-8 || Math.min(rect.y + rect.height, other.y + other.height) <= Math.max(rect.y, other.y) + 1e-8).toBe(true);
    }
  });
  it("validates series/cardinality limits and never silently selects a subset", () => {
    expect(chartIssue(input("bar", []))).toBe("select_series");
    expect(chartIssue(input("bar", Array(13).fill(["1"])))).toBe("series_limit");
    expect(chartIssue(input("bar", [Array(61).fill("1")]))).toBe("categories");
    expect(chartIssue(input("combo", [["1"]]))).toBe("combo_series");
    expect(chartIssue(input("tornado", [["1"]]))).toBe("two_series");
    expect(chartIssue(input("pie", [["1"], ["2"]]))).toBe("single_series");
  });
  it("rejects unsupported chart semantics, mismatched arrays and invalid numeric values", () => {
    for (const kind of ["pie", "donut", "treemap"] as const) {
      expect(chartIssue(input(kind, [["-1", "5"]]))).toBe("negative");
      expect(chartIssue(input(kind, [["0", null]]))).toBe("positive");
      expect(chartIssue(input(kind, [["2", null]]))).toBeNull();
    }
    expect(chartIssue(input("waterfall", [["1", null]]))).toBe("waterfall_null");
    expect(chartIssue(input("tornado", [["1"], ["-2"]]))).toBe("negative");
    expect(chartIssue(input("bar", [["NaN"]]))).toBe("invalid");
    expect(chartIssue(input("bar", [["1"], ["1", "2"]]))).toBe("invalid");
    expect(chartIssue(input("line", [[null]]))).toBe("empty");
  });
});
