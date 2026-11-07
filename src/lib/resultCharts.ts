import { add, chartRatio, compare, decimal, decimalText, type AxisOptions, type Bucket, type Decimal, type Scalar } from "./resultAnalysis";

export const CHART_KINDS = ["bar", "stackedBar", "horizontalBar", "horizontalStackedBar", "line", "area", "stackedArea", "combo", "stackedCombo", "waterfall", "tornado", "pie", "donut", "heatmap", "treemap", "scatter", "value", "trend", "kpi", "gauge"] as const;
export type ChartKind = typeof CHART_KINDS[number];
export interface ChartSeries { key: string; label: string; values: Scalar[]; summary?: Scalar }
export interface MetricOptions { target: string; minimum: string; maximum: string; direction: "higher" | "lower"; comparison: "previous" | "first" }
export const DEFAULT_METRIC_OPTIONS: MetricOptions = { target: "", minimum: "0", maximum: "100", direction: "higher", comparison: "previous" };
export type MetricKind = "value" | "trend" | "kpi" | "gauge";
export const metricChart = (kind: ChartKind): kind is MetricKind => ["value", "trend", "kpi", "gauge"].includes(kind);
export const aggregateCard = (kind: ChartKind) => ["value", "kpi", "gauge"].includes(kind);
export const supportsContinuousAxis = (kind: ChartKind) => ["bar", "stackedBar", "line", "area", "stackedArea", "combo", "stackedCombo", "trend"].includes(kind);
export interface ChartInput { axis?: AxisOptions; rows: Bucket[]; series: ChartSeries[]; kind: ChartKind; options?: MetricOptions }
export interface Level { start: Scalar; end: Scalar; value: Scalar }
export const ZERO: Scalar = { value: "0", rounded: false };
/** Approximate Latin/CJK glyph widths while retaining full labels in SVG titles. */
export function shortChartLabel(text: string, budget = 24): string {
  let units = 0, result = "";
  for (const character of text) {
    units += character.codePointAt(0)! > 255 ? 2 : 1;
    if (units > budget) return result + "…";
    result += character;
  }
  return result;
}
export function scalarText(value: Scalar): string { return value.value == null ? "NULL" : `${value.rounded ? "≈ " : ""}${value.value}`; }
export function sign(value: Scalar): number {
  const coefficient = value.value == null ? 0n : decimal(value.value, true, true)?.coefficient ?? 0n;
  return coefficient < 0n ? -1 : coefficient > 0n ? 1 : 0;
}
export function plus(a: Scalar, b: Scalar): Scalar {
  if (a.value == null || b.value == null) return { value: null, rounded: false };
  return { value: decimalText(add(decimal(a.value, true, true)!, decimal(b.value, true, true)!)), rounded: a.rounded || b.rounded };
}
export function sum(values: Scalar[]): Scalar { return values.filter(v => v.value != null).reduce(plus, ZERO); }
export const singleSeries = (kind: ChartKind) => ["waterfall", "pie", "donut", "treemap"].includes(kind);
export const comboChart = (kind: ChartKind) => kind === "combo" || kind === "stackedCombo";
export function chartIssue({ rows, series, kind, axis, options = DEFAULT_METRIC_OPTIONS }: ChartInput): string | null {
  if (kind === "scatter") return "raw_scatter";
  const continuous = axis && axis.kind !== "category";
  if (continuous) {
    if (!supportsContinuousAxis(kind)) return "axis_kind";
    if (rows.length > 200) return "axis_limit";
    const coordinates = rows.map(row => decimal(row.coordinate, true, true));
    if (coordinates.some((value, i) => !value || i > 0 && coordinates[i - 1] && compare(value, coordinates[i - 1]!) <= 0)) return "axis_data";
  } else if (!aggregateCard(kind) && rows.length > 60) return "categories";
  if (!series.length) return "select_series";
  if (series.length > 12) return "series_limit";
  if (singleSeries(kind) && series.length !== 1) return "single_series";
  if (kind === "tornado" && series.length !== 2) return "two_series";
  if (comboChart(kind) && series.length < 2) return "combo_series";
  const values = series.flatMap(s => s.values);
  if (series.some(s => s.values.length !== rows.length) || values.some(v => v.value != null && !decimal(v.value, true, true))) return "invalid";
  if (kind === "kpi" && !decimal(options.target)) return "target";
  if (kind === "gauge") {
    const min = decimal(options.minimum), max = decimal(options.maximum);
    if (!min || !max || compare(min, max) >= 0) return "range";
  }
  if (aggregateCard(kind)) {
    return series.some(s => !s.summary || s.summary.value != null && !decimal(s.summary.value, true, true)) ? "summary" : null;
  }
  if (kind === "waterfall" && values.some(v => v.value == null)) return "waterfall_null";
  if (["pie", "donut", "treemap", "tornado"].includes(kind) && values.some(v => sign(v) < 0)) return "negative";
  if (["pie", "donut", "treemap"].includes(kind) && !values.some(v => sign(v) > 0)) return "positive";
  if (!values.some(v => v.value != null)) return "empty";
  return null;
}
/** Positive and negative stacks have independent baselines; NULL never becomes a plotted zero. */
export function stackLevels(series: ChartSeries[]): Level[][] {
  const positive: Scalar[] = [], negative: Scalar[] = [];
  return series.map(s => s.values.map((value, index) => {
    const totals = sign(value) < 0 ? negative : positive;
    const start = totals[index] ?? ZERO;
    if (value.value == null) return { start, end: start, value };
    const end = plus(start, value); totals[index] = end;
    return { start, end, value };
  }));
}
export function waterfallLevels(values: Scalar[]): Level[] {
  let balance = ZERO;
  const levels = values.map(value => {
    const start = balance; balance = plus(balance, value);
    return { start, end: balance, value };
  });
  return [...levels, { start: ZERO, end: balance, value: balance }];
}
/** Bounded scientific conversion avoids overflow and a fixed decimal ratio quantum. */
function coordinateFraction(a: Decimal, b: Decimal): number {
  if (a.coefficient === 0n || b.coefficient === 0n) return 0;
  const left = (a.coefficient < 0n ? -a.coefficient : a.coefficient).toString();
  const right = (b.coefficient < 0n ? -b.coefficient : b.coefficient).toString();
  const magnitude = Number(`0.${left.slice(0, 16)}`) / Number(`0.${right.slice(0, 16)}`);
  const exponent = left.length - a.scale - right.length + b.scale;
  const sign = (a.coefficient < 0n) === (b.coefficient < 0n) ? 1 : -1;
  return sign * Number(`${magnitude}e${exponent}`);
}
/** Inclusive of zero; subtract the exact minimum before converting to pixel ratios. */
export function numericDomain(values: Scalar[], includeZero = true) {
  const first = values.find(value => value.value != null);
  let min = !includeZero && first ? decimal(first.value, true, true)! : decimal("0")!, max = min;
  for (const value of values) {
    if (value.value == null) continue;
    const d = decimal(value.value, true, true)!;
    if (compare(d, min) < 0) min = d;
    if (compare(d, max) > 0) max = d;
  }
  const offset = { ...min, coefficient: -min.coefficient };
  const spanDecimal = add(max, offset), span = decimalText(spanDecimal);
  return {
    min: decimalText(min), max: decimalText(max),
    coordinateRatio(value: Scalar): number {
      if (value.value == null) return 0;
      if (span === "0") return 0.5;
      return coordinateFraction(add(decimal(value.value, true, true)!, offset), spanDecimal);
    },
    ratio(value: Scalar): number {
      if (value.value == null) return 0;
      if (span === "0") return includeZero ? 0 : 0.5;
      return chartRatio(decimalText(add(decimal(value.value, true, true)!, offset)), span);
    },
  };
}
/** Coordinate differences are computed exactly before reducing them to SVG ratios. */
export function axisLayout(rows: Bucket[], axis?: AxisOptions) {
  if (!axis || axis.kind === "category") return null;
  const values = rows.map(row => ({ value: row.coordinate!, rounded: false }));
  const domain = numericDomain(values, false), ratios = values.map(domain.coordinateRatio);
  return { ratios, minimum: rows[0]?.label ?? "", maximum: rows.at(-1)?.label ?? "" };
}
export interface Rectangle { index: number; x: number; y: number; width: number; height: number }
/** Balanced binary treemap; every nonzero rectangle has area proportional to its weight. */
export function treeRectangles(values: Scalar[], width: number, height: number): Rectangle[] {
  const total = sum(values).value!;
  const items = values.map((v, index) => ({ index, weight: v.value == null ? 0 : chartRatio(v.value, total) })).filter(i => i.weight > 0);
  const rectangles: Rectangle[] = [];
  function partition(list: typeof items, x: number, y: number, w: number, h: number) {
    if (list.length === 0) return;
    if (list.length === 1) { rectangles.push({ index: list[0].index, x, y, width: w, height: h }); return; }
    const totalWeight = list.reduce((a, b) => a + b.weight, 0);
    let split = 1, weight = list[0].weight;
    while (split < list.length - 1 && Math.abs(weight + list[split].weight - totalWeight / 2) < Math.abs(weight - totalWeight / 2)) weight += list[split++].weight;
    const fraction = weight / totalWeight;
    if (w >= h) { partition(list.slice(0, split), x, y, w * fraction, h); partition(list.slice(split), x + w * fraction, y, w * (1 - fraction), h); }
    else { partition(list.slice(0, split), x, y, w, h * fraction); partition(list.slice(split), x, y + h * fraction, w, h * (1 - fraction)); }
  }
  partition(items, 0, 0, width, height);
  return rectangles;
}


export function minus(a: Scalar, b: Scalar): Scalar {
  if (a.value == null || b.value == null) return { value: null, rounded: false };
  const right = decimal(b.value, true, true)!;
  return { value: decimalText(add(decimal(a.value, true, true)!, { ...right, coefficient: -right.coefficient })), rounded: a.rounded || b.rounded };
}
/** (current - reference) / abs(reference) * 100. Zero reference has no defined percent. */
export function percentChange(current: Scalar, reference: Scalar): Scalar {
  const difference = minus(current, reference);
  if (difference.value == null || reference.value == null) return { value: null, rounded: false };
  const a = decimal(difference.value, true, true)!, b = decimal(reference.value, true, true)!;
  if (b.coefficient === 0n) return { value: null, rounded: false };
  const numerator = a.coefficient * 100n * 10n ** BigInt(b.scale + 6);
  const denominator = (b.coefficient < 0n ? -b.coefficient : b.coefficient) * 10n ** BigInt(a.scale);
  let coefficient = numerator / denominator;
  const remainder = numerator % denominator;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= denominator) coefficient += numerator < 0n ? -1n : 1n;
  let scale = 6;
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  return { value: decimalText({ coefficient, scale }), rounded: difference.rounded || remainder !== 0n };
}
export function gaugePosition(value: Scalar, minimum: string, maximum: string) {
  if (value.value == null) return { ratio: null, outside: 0 };
  const low: Scalar = { value: decimalText(decimal(minimum)!), rounded: false }, high: Scalar = { value: decimalText(decimal(maximum)!), rounded: false };
  const d = decimal(value.value, true, true)!;
  const outside = compare(d, decimal(low.value, true, true)!) < 0 ? -1 : compare(d, decimal(high.value, true, true)!) > 0 ? 1 : 0;
  return { outside, ratio: outside < 0 ? 0 : outside > 0 ? 1 : chartRatio(minus(value, low).value!, minus(high, low).value!) };
}
