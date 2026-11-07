import { parseTime, timeBucket, timeLabel, type TimeOptions } from "./resultTime";
/** Local snapshot analysis. Exact base-10 arithmetic; never sends SQL or persists rows. */
export const ANALYSIS_LIMITS = { rows: 50_000, bytes: 32 * 1024 * 1024, rowGroups: 200, columnGroups: 40, digits: 256, exponent: 512, scatterPoints: 2000 } as const;
export type Aggregate = "count" | "nonNull" | "sum" | "mean" | "min" | "max";
export interface Decimal { coefficient: bigint; scale: number }
export interface Scalar { value: string | null; rounded: boolean }
export type AxisOptions = { kind: "category" } | { kind: "number" } | { kind: "time"; time: TimeOptions };
export interface Bucket { key: string; label: string; type: string; count: number; coordinate?: string }
export interface Profile {
  kind: "profile"; count: number; nulls: number; empty: number; distinct: number; singletons: number;
  numeric: number; invalid: number; min: Scalar; max: Scalar; sum: Scalar; mean: Scalar; median: Scalar;
  types: Record<string, number>; top: Bucket[];
}
export interface Pivot {
  kind: "pivot"; axis?: AxisOptions; rows: Bucket[]; columns: Bucket[]; cells: Scalar[][]; rowTotals: Scalar[];
  columnTotals: Scalar[]; total: Scalar; count: number; numeric: number; invalid: number; nulls: number;
}
export interface ScatterPoint { index: number; x: Scalar; y: Scalar; label: string | null }
export interface Scatter {
  kind: "scatter"; count: number; numeric: number; invalid: number; nulls: number;
  points: ScatterPoint[]; sampled: boolean; xMin: Scalar; xMax: Scalar; yMin: Scalar; yMax: Scalar;
}
export type AnalysisRequest =
  | { kind: "scatter"; rows: unknown[][]; parseStrings: boolean; sample: boolean; labels: boolean; numericStrings?: [boolean, boolean] }
  | { kind: "profile"; rows: unknown[][]; parseStrings: boolean }
  | { kind: "pivot"; rows: unknown[][]; parseStrings: boolean; aggregate: Aggregate; split: boolean; axis?: AxisOptions };
export type AnalysisResult = Profile | Pivot | Scatter;

const ten = (scale: number) => 10n ** BigInt(scale);
function normalize(coefficient: bigint, scale: number): Decimal {
  if (!coefficient) return { coefficient: 0n, scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  return { coefficient, scale };
}
export function decimal(value: unknown, parseStrings = true, internal = false): Decimal | null {
  if (typeof value !== "number" && !(parseStrings && typeof value === "string")) return null;
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return null;
  const digitsLimit = internal ? 1600 : ANALYSIS_LIMITS.digits;
  const text = String(value).trim();
  if (text.length > digitsLimit + 16) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
    ?? /^([+-]?)()\.(\d+)(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || match[2].length + (match[3]?.length ?? 0) > digitsLimit) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > ANALYSIS_LIMITS.exponent) return null;
  let coefficient = BigInt((match[1] === "-" ? "-" : "") + (match[2] || "0") + (match[3] ?? ""));
  let scale = (match[3]?.length ?? 0) - exponent;
  if (scale < 0) { coefficient *= ten(-scale); scale = 0; }
  return normalize(coefficient, scale);
}
export function decimalText(value: Decimal): string {
  const sign = value.coefficient < 0n ? "-" : "";
  let digits = (value.coefficient < 0n ? -value.coefficient : value.coefficient).toString();
  if (!value.scale) return sign + digits;
  digits = digits.padStart(value.scale + 1, "0");
  return sign + digits.slice(0, -value.scale) + "." + digits.slice(-value.scale);
}
export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return normalize(a.coefficient * ten(scale - a.scale) + b.coefficient * ten(scale - b.scale), scale);
}
export function compare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const difference = a.coefficient * ten(scale - a.scale) - b.coefficient * ten(scale - b.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
const exact = (d: Decimal | null): Scalar => ({ value: d ? decimalText(d) : null, rounded: false });
/** Division preserves exact terminating decimals. Otherwise rounds half away from zero to at least 12 places, retaining the input scale. */
function divide(d: Decimal, count: number): Scalar {
  if (!count) return exact(null);
  let denominator = BigInt(count), twos = 0, fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
  const scale = denominator === 1n ? d.scale + Math.max(twos, fives) : Math.max(d.scale, 12);
  const numerator = d.coefficient * ten(scale - d.scale);
  const divisor = BigInt(count);
  let quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= divisor) quotient += numerator < 0n ? -1n : 1n;
  return { value: decimalText(normalize(quotient, scale)), rounded: remainder !== 0n };
}

class Budget {
  private size = 0;
  charge(length: number) {
    this.size += length;
    if (this.size > ANALYSIS_LIMITS.bytes) throw new Error("size");
  }
}
/** Check clone size without serializing strings or allocating canonical keys on the UI thread. */
export function projectionBudget(): (row: unknown[]) => void {
  const budget = new Budget();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) throw new Error("depth");
    budget.charge(8);
    if (typeof value === "string") budget.charge(value.length * 2);
    else if (value && typeof value === "object") {
      if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
      else for (const key of Object.keys(value)) { budget.charge(key.length * 2); visit((value as Record<string, unknown>)[key], depth + 1); }
    } else if (value != null && !["boolean", "number"].includes(typeof value)) throw new Error("value");
  };
  return row => { for (const value of row) visit(value, 0); };
}
function canonical(value: unknown, budget: Budget, depth = 0): string {
  if (depth > 32) throw new Error("depth");
  budget.charge(8);
  if (value == null) return "null";
  switch (typeof value) {
    case "string": budget.charge(value.length * 2); return JSON.stringify(value);
    case "number": return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    case "boolean": return String(value);
    case "object":
      if (Array.isArray(value)) return "[" + value.map(item => canonical(item, budget, depth + 1)).join(",") + "]";
      return "{" + Object.keys(value).sort().map(key => {
        budget.charge(key.length * 2);
        return JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key], budget, depth + 1);
      }).join(",") + "}";
    default: throw new Error("value");
  }
}
function bucket(value: unknown, budget: Budget): Bucket {
  const type = value == null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const content = canonical(value, budget);
  return { key: type + ":" + content, type, label: value == null ? "NULL" : typeof value === "string" ? value : content, count: 0 };
}
function axisBucket(value: unknown, budget: Budget, axis?: AxisOptions): Bucket {
  if (!axis || axis.kind === "category") return bucket(value, budget);
  canonical(value, budget);
  if (axis.kind === "number") {
    const numeric = decimal(value);
    if (!numeric) throw new Error("axis_number");
    const coordinate = decimalText(numeric);
    return { key: "number:" + coordinate, label: coordinate, type: "number", count: 0, coordinate };
  }
  const instant = parseTime(value, axis.time);
  if (instant == null) throw new Error("axis_time");
  const grouped = timeBucket(instant, axis.time.bucket), coordinate = grouped.toString();
  return { key: "time:" + coordinate, label: timeLabel(grouped), type: "UTC", count: 0, coordinate };
}
interface Accumulator { count: number; nulls: number; numeric: number; invalid: number; sum: Decimal; min: Decimal | null; max: Decimal | null }
const accumulator = (): Accumulator => ({ count: 0, nulls: 0, numeric: 0, invalid: 0, sum: { coefficient: 0n, scale: 0 }, min: null, max: null });
function accumulate(a: Accumulator, value: unknown, number: Decimal | null) {
  a.count++;
  if (value == null) a.nulls++;
  else if (!number) a.invalid++;
  if (number) {
    a.numeric++; a.sum = add(a.sum, number);
    if (!a.min || compare(number, a.min) < 0) a.min = number;
    if (!a.max || compare(number, a.max) > 0) a.max = number;
  }
}
function scalar(a: Accumulator, operation: Aggregate): Scalar {
  switch (operation) {
    case "count": return { value: String(a.count), rounded: false };
    case "nonNull": return { value: String(a.count - a.nulls), rounded: false };
    case "sum": return exact(a.numeric ? a.sum : null);
    case "mean": return divide(a.sum, a.numeric);
    case "min": return exact(a.min);
    case "max": return exact(a.max);
  }
}
function analyzeScatter(request: Extract<AnalysisRequest, { kind: "scatter" }>): Scatter {
  const budget = new Budget(), points: ScatterPoint[] = [];
  let numeric = 0, invalid = 0, nulls = 0;
  let xMin: Decimal | null = null, xMax: Decimal | null = null, yMin: Decimal | null = null, yMax: Decimal | null = null;
  let seed = 0x9e3779b9;
  for (let index = 0; index < request.rows.length; index++) {
    const [xValue, yValue, label] = request.rows[index];
    canonical(xValue, budget); canonical(yValue, budget); const labelText = canonical(label, budget);
    if (xValue == null || yValue == null) { nulls++; continue; }
    const x = decimal(xValue, request.numericStrings?.[0] ?? request.parseStrings), y = decimal(yValue, request.numericStrings?.[1] ?? request.parseStrings);
    if (!x || !y) { invalid++; continue; }
    numeric++;
    if (!xMin || compare(x, xMin) < 0) xMin = x;
    if (!xMax || compare(x, xMax) > 0) xMax = x;
    if (!yMin || compare(y, yMin) < 0) yMin = y;
    if (!yMax || compare(y, yMax) > 0) yMax = y;
    const point = { index, x: exact(x), y: exact(y), label: request.labels ? typeof label === "string" ? label : label == null ? "NULL" : labelText : null };
    if (points.length < ANALYSIS_LIMITS.scatterPoints) points.push(point);
    else {
      if (!request.sample) throw new Error("points");
      // Deterministic reservoir sampling over valid pairs, with the full-data bounds retained.
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const replace = Math.floor((seed >>> 0) / 0x100000000 * numeric);
      if (replace < points.length) points[replace] = point;
    }
  }
  points.sort((a, b) => a.index - b.index);
  return { kind: "scatter", count: request.rows.length, numeric, invalid, nulls, points, sampled: numeric > points.length,
    xMin: exact(xMin), xMax: exact(xMax), yMin: exact(yMin), yMax: exact(yMax) };
}
export function analyze(request: AnalysisRequest): AnalysisResult {
  if (request.rows.length > ANALYSIS_LIMITS.rows) throw new Error("rows");
  if (request.kind === "scatter") return analyzeScatter(request);
  const budget = new Budget();
  if (request.kind === "profile") {
    const a = accumulator(), frequencies = new Map<string, Bucket>(), numbers: Decimal[] = [];
    let empty = 0;
    const types: Record<string, number> = {};
    for (const [value] of request.rows) {
      const item = bucket(value, budget), numeric = decimal(value, request.parseStrings);
      types[item.type] = (types[item.type] ?? 0) + 1;
      if (value === "") empty++;
      accumulate(a, value, numeric);
      if (numeric) numbers.push(numeric);
      if (value != null) {
        const old = frequencies.get(item.key);
        if (old) old.count++; else frequencies.set(item.key, { ...item, count: 1 });
      }
    }
    numbers.sort(compare);
    const middle = Math.floor(numbers.length / 2);
    const median = !numbers.length ? exact(null) : numbers.length % 2 ? exact(numbers[middle]) : divide(add(numbers[middle - 1], numbers[middle]), 2);
    const buckets = [...frequencies.values()].sort((a, b) => b.count - a.count);
    return { kind: "profile", count: a.count, nulls: a.nulls, empty, distinct: buckets.length,
      singletons: buckets.filter(b => b.count === 1).length, numeric: a.numeric, invalid: a.invalid,
      min: exact(a.min), max: exact(a.max), sum: scalar(a, "sum"), mean: scalar(a, "mean"), median,
      types, top: buckets.slice(0, 20) };
  }
  const rowGroups = new Map<string, Bucket>(), colGroups = new Map<string, Bucket>();
  const cells = new Map<string, Map<string, Accumulator>>(), rowTotals = new Map<string, Accumulator>(), columnTotals = new Map<string, Accumulator>();
  const total = accumulator();
  for (const [row, col, value] of request.rows) {
    const r = axisBucket(row, budget, request.axis), c = request.split ? bucket(col, budget) : { key: "all", type: "all", label: "", count: 0 };
    // Count still accounts for input size; numeric work is unnecessary for count aggregates.
    canonical(value, budget);
    const number = decimal(value, request.parseStrings);
    if (!rowGroups.has(r.key)) { rowGroups.set(r.key, r); rowTotals.set(r.key, accumulator()); cells.set(r.key, new Map()); }
    if (!colGroups.has(c.key)) { colGroups.set(c.key, c); columnTotals.set(c.key, accumulator()); }
    if (rowGroups.size > ANALYSIS_LIMITS.rowGroups || colGroups.size > ANALYSIS_LIMITS.columnGroups) throw new Error("groups");
    rowGroups.get(r.key)!.count++; colGroups.get(c.key)!.count++;
    const rowCells = cells.get(r.key)!;
    if (!rowCells.has(c.key)) rowCells.set(c.key, accumulator());
    for (const a of [rowCells.get(c.key)!, rowTotals.get(r.key)!, columnTotals.get(c.key)!, total]) accumulate(a, value, number);
  }
  const rows = [...rowGroups.values()], columns = [...colGroups.values()];
  if (request.axis && request.axis.kind !== "category") rows.sort((a, b) => compare(decimal(a.coordinate, true, true)!, decimal(b.coordinate, true, true)!));
  return { kind: "pivot", axis: request.axis, rows, columns,
    cells: rows.map(row => columns.map(col => scalar(cells.get(row.key)?.get(col.key) ?? accumulator(), request.aggregate))),
    rowTotals: rows.map(row => scalar(rowTotals.get(row.key)!, request.aggregate)),
    columnTotals: columns.map(col => scalar(columnTotals.get(col.key)!, request.aggregate)),
    total: scalar(total, request.aggregate), count: total.count, nulls: total.nulls, numeric: total.numeric, invalid: total.invalid };
}

/** Only SVG geometry is approximate; labels, totals and exports retain exact decimal text. */
export function chartRatio(value: string, maximum: string): number {
  const a = decimal(value, true, true), b = decimal(maximum, true, true);
  if (!a || !b || b.coefficient === 0n) return 0;
  const scale = Math.max(a.scale, b.scale);
  return Number((a.coefficient * ten(scale - a.scale) * 1_000_000n) / (b.coefficient * ten(scale - b.scale))) / 1_000_000;
}
export function maxMagnitude(values: Scalar[]): string {
  let max: Decimal = { coefficient: 0n, scale: 0 };
  for (const value of values) {
    const d = value.value == null ? null : decimal(value.value, true, true);
    if (d) { d.coefficient = d.coefficient < 0n ? -d.coefficient : d.coefficient; if (compare(d, max) > 0) max = d; }
  }
  return decimalText(max);
}
