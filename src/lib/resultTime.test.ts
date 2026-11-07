import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_OPTIONS, parseTime, timeBucket, timeLabel, type TimeOptions } from "./resultTime";
import { analyze, type AxisOptions, type Pivot } from "./resultAnalysis";
import { axisLayout, chartIssue } from "./resultCharts";
const parse = (value: unknown, options: Partial<TimeOptions> = {}) => parseTime(value, { ...DEFAULT_TIME_OPTIONS, ...options });
const normalized = (value: string, options: Partial<TimeOptions> = {}) => timeLabel(parse(value, options)!);
const time: AxisOptions = { kind: "time", time: DEFAULT_TIME_OPTIONS };
const pivot = (rows: unknown[][], axis: AxisOptions = time, aggregate: "sum" | "mean" | "count" = "sum") => analyze({ kind: "pivot", rows, axis, aggregate, split: true, parseStrings: true }) as Pivot;
describe("UTC timestamps without locale guessing", () => {
  it("normalizes offsets, dates, SQL timestamps and fractional nanoseconds", () => {
    expect(normalized("2026-11-06T08:30:45.123456789+08:30")).toBe("2026-11-06T00:00:45.123456789Z");
    expect(normalized("2026-11-06 08:30:45.123456+0830")).toBe("2026-11-06T00:00:45.123456Z");
    expect(normalized("2026-11-06 08:00+08")).toBe("2026-11-06T00:00:00Z");
    expect(normalized("2026-11-06")).toBe("2026-11-06T00:00:00Z");
    expect(normalized("2026-11-06t00:00:00z")).toBe("2026-11-06T00:00:00Z");
    expect(normalized("2026-11-06T00:00:00-00:00")).toBe("2026-11-06T00:00:00Z");
    expect(normalized("1970-01-01T00:30:00+01:00")).toBe("1969-12-31T23:30:00Z");
    expect(normalized("1969-12-31T23:59:59.999999999Z")).toBe("1969-12-31T23:59:59.999999999Z");
  });
  it("makes offset-free timestamp policy explicit while keeping dates at UTC midnight", () => {
    expect(normalized("2026-11-06 12:34:56")).toBe("2026-11-06T12:34:56Z");
    expect(parse("2026-11-06 12:34:56", { naive: "reject" })).toBeNull();
    expect(parse("2026-11-06T12:34:56+00:00", { naive: "reject" })).not.toBeNull();
    expect(normalized("2026-11-06", { naive: "reject" })).toBe("2026-11-06T00:00:00Z");
  });
  it("rejects rollover dates, ambiguous formats, leap seconds, invalid offsets and excess precision", () => {
    for (const value of ["2026-02-29", "1900-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-01-32", "11/06/2026", "2026-11-06T24:00:00Z", "2026-11-06T00:60:00Z", "2016-12-31T23:59:60Z", "2026-11-06T01:00:00+24:00", "2026-11-06T01:00:00+01:60", "2026-11-06T01:00:00.1234567891Z", "2026-11-06T01:00:00 EST", "1762387200", "", null, true, 1762387200]) expect(parse(value), String(value)).toBeNull();
    expect(normalized("2000-02-29")).toBe("2000-02-29T00:00:00Z");
    expect(normalized("2024-02-29")).toBe("2024-02-29T00:00:00Z");
  });
  it("preserves early years and rejects out-of-range UTC instants including offset rollover", () => {
    for (const value of ["0001-01-01T00:00:00Z", "0099-12-31T23:59:59Z", "9999-12-31T23:59:59.999999999Z"]) expect(normalized(value)).toBe(value);
    for (const value of ["0000-01-01", "10000-01-01", "0001-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01"]) expect(parse(value)).toBeNull();
  });
  it("uses explicit epoch units without truncating microseconds or nanoseconds", () => {
    const expected = "2026-11-06T00:00:00.123456789Z", ns = parse(expected)!;
    expect(normalized(ns.toString(), { input: "nanoseconds" })).toBe(expected);
    expect(normalized("-0.000000001", { input: "seconds" })).toBe("1969-12-31T23:59:59.999999999Z");
    expect(normalized("1.000001", { input: "milliseconds" })).toBe("1970-01-01T00:00:00.001000001Z");
    expect(normalized("1.001", { input: "microseconds" })).toBe("1970-01-01T00:00:00.000001001Z");
    expect(parse(1e-7, { input: "seconds" })).toBe(100n);
    expect(parse("1.0e3", { input: "nanoseconds" })).toBe(1000n);
    for (const value of ["0.0000000001", "1e99999", "0x10", true, null, Infinity, NaN, 9007199254740992]) expect(parse(value, { input: "seconds" })).toBeNull();
    expect(parse("1.1", { input: "nanoseconds" })).toBeNull();
    expect(parse("253402300800", { input: "seconds" })).toBeNull();
    expect(parse("-62135596800.000000001", { input: "seconds" })).toBeNull();
  });
  it("buckets in UTC, with negative epochs, Monday weeks and leap-year calendar boundaries", () => {
    const instant = parse("2024-03-31T23:59:59.123456789Z")!;
    const expected = { second: "2024-03-31T23:59:59Z", minute: "2024-03-31T23:59:00Z", hour: "2024-03-31T23:00:00Z", day: "2024-03-31T00:00:00Z", week: "2024-03-25T00:00:00Z", month: "2024-03-01T00:00:00Z", quarter: "2024-01-01T00:00:00Z", year: "2024-01-01T00:00:00Z" };
    for (const [bucket, value] of Object.entries(expected)) expect(timeLabel(timeBucket(instant, bucket as TimeOptions["bucket"]))).toBe(value);
    expect(timeLabel(timeBucket(-1n, "second"))).toBe("1969-12-31T23:59:59Z");
    expect(timeLabel(timeBucket(-1n, "day"))).toBe("1969-12-31T00:00:00Z");
    expect(timeLabel(timeBucket(parse("2024-04-01")!, "quarter"))).toBe("2024-04-01T00:00:00Z");
    expect(timeLabel(timeBucket(parse("0001-01-01")!, "week"))).toBe("0001-01-01T00:00:00Z");
    expect(timeLabel(timeBucket(parse("2021-01-01")!, "week"))).toBe("2020-12-28T00:00:00Z");
    expect(timeLabel(timeBucket(parse("2024-03-01T00:30:00+01:00")!, "month"))).toBe("2024-02-01T00:00:00Z");
  });
});
describe("continuous source aggregation", () => {
  it("merges equivalent instants and sorts while retaining source-weighted means", () => {
    const r = pivot([["2026-11-11", "a", 30], ["2026-11-01T08:00:00+08:00", "a", 2], ["2026-11-01T00:00:00Z", "a", 4], ["2026-11-02", "b", null]], time, "mean");
    expect(r.rows.map(row => row.label)).toEqual(["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "2026-11-11T00:00:00Z"]);
    expect(r.rows.map(row => row.count)).toEqual([2, 1, 1]);
    expect(r.cells.map(row => row.map(v => v.value))).toEqual([["3", null], [null, null], ["30", null]]);
    expect(r.total.value).toBe("12");
    expect(axisLayout(r.rows, time)?.ratios).toEqual([0, 0.1, 1]);
  });
  it("groups original rows by UTC calendar periods, without inventing missing periods", () => {
    const axis: AxisOptions = { kind: "time", time: { ...DEFAULT_TIME_OPTIONS, bucket: "month" } };
    const r = pivot([["2024-02-01", "a", 2], ["2024-02-28", "a", 4], ["2024-04-01", "a", 30]], axis, "mean");
    expect(r.rows).toHaveLength(2);
    expect(r.rowTotals.map(v => v.value)).toEqual(["3", "30"]); expect(r.total.value).toBe("12");
    expect(r.axis).toEqual(axis);
  });
  it("rejects invalid dimensions without dropping rows and retains categorical types by default", () => {
    for (const value of [null, "bad", "2024-02-30"]) expect(() => pivot([["2024-01-01", "a", 1], [value, "a", 2]])).toThrow("axis_time");
    for (const value of [null, "bad", 9007199254740992]) expect(() => pivot([[value, "a", 2]], { kind: "number" })).toThrow("axis_number");
    const r = pivot([[1, "a", 1], ["1", "a", 2]], { kind: "category" });
    expect(r.rows).toHaveLength(2); expect(r.rows[0].coordinate).toBeUndefined();
  });
  it("keeps nanosecond and adjacent i64 spacing, normalizing equivalent numeric dimensions", () => {
    const r = pivot([["9223372036854775807", "a", 1], ["9223372036854775806.0", "a", 2], ["9223372036854775806", "a", 4]], { kind: "number" });
    expect(r.rowTotals.map(v => v.value)).toEqual(["6", "1"]);
    expect(axisLayout(r.rows, r.axis)?.ratios).toEqual([0, 1]);
    const ns = pivot([["2026-11-06T00:00:00.000000001Z", "a", 1], ["2026-11-06T00:00:00.000000002Z", "a", 1]]);
    expect(axisLayout(ns.rows, time)?.ratios).toEqual([0, 1]);
  });
  it("retains small coordinate differences across the full supported time range", () => {
    const r = pivot([["0001-01-01", "a", 1], ["0001-01-02", "a", 1], ["9999-12-31T23:59:59Z", "a", 1]]);
    const layout = axisLayout(r.rows, time)!;
    expect(layout.ratios[0]).toBe(0); expect(layout.ratios[2]).toBe(1);
    expect(layout.ratios[1]).toBeGreaterThan(0);
    expect(layout.ratios[1]).toBeLessThan(1e-6);
    const numeric = pivot([["0", "a", 1], ["0.0000001", "a", 1], ["999999999", "a", 1]], { kind: "number" });
    expect(axisLayout(numeric.rows, numeric.axis)!.ratios[1]).toBeGreaterThan(0);
  });
  it("allows 200 continuous coordinates and validates unsupported charts and unordered data", () => {
    const r = pivot(Array.from({ length: 200 }, (_, i) => [i, "a", 1]), { kind: "number" });
    const input = { rows: r.rows, series: [{ key: "s", label: "s", values: r.rowTotals }], axis: r.axis };
    expect(chartIssue({ ...input, kind: "line" })).toBeNull();
    expect(chartIssue({ ...input, kind: "line", axis: { kind: "category" } })).toBe("categories");
    expect(chartIssue({ ...input, kind: "pie" })).toBe("axis_kind");
    expect(chartIssue({ ...input, kind: "line", rows: [...r.rows].reverse() })).toBe("axis_data");
    expect(() => pivot(Array.from({ length: 201 }, (_, i) => [i, "a", 1]), { kind: "number" })).toThrow("groups");
  });
});
