import { CALCULATION_LIMITS, CALCULATION_TYPES, prepareCalculations, rewriteReferences, validateCalculatedFields, type CalculatedField } from "./calculatedFields";
import { decimal, compare, type Aggregate, type AxisOptions } from "./resultAnalysis";
import { CHART_KINDS, DEFAULT_METRIC_OPTIONS, aggregateCard, supportsContinuousAxis, type ChartKind, type MetricOptions } from "./resultCharts";
import { DEFAULT_TIME_OPTIONS, TIME_BUCKETS, TIME_INPUTS, type TimeOptions } from "./resultTime";

export const ANALYSIS_CONFIG_BYTES = 64 * 1024;
export const BINDING_ROLES = ["profile", "row", "split", "measure", "x", "y", "label"] as const;
export type BindingRole = typeof BINDING_ROLES[number];
export interface AnalysisColumn { name: string; data_type?: string }
export interface ColumnBinding { name: string; dataType: string; ordinal: number }
export type AnalysisBinding = ColumnBinding | { calculated: number };
export type AnalysisMapping = Partial<Record<BindingRole | `input:${number}`, number>>;
export interface PresetCalculations { inputs: ColumnBinding[]; fields: CalculatedField[] }
export type SeriesChoice = { mode: "total" | "all" | "choose" } | { mode: "keys"; keys: string[] };
export interface AnalysisConfiguration {
  version: 1 | 2; calculations?: PresetCalculations; mode: "profile" | "pivot" | "chart"; chart: ChartKind;
  bindings: Partial<Record<BindingRole, AnalysisBinding>>;
  aggregate: Aggregate; parseStrings: boolean; axisKind: AxisOptions["kind"];
  timeOptions: TimeOptions; metricOptions: MetricOptions; sample: boolean; series: SeriesChoice;
}
export interface AnalysisPreset { id: string; revision: string; name: string; updated_at: string; config: AnalysisConfiguration }
export interface AnalysisPresetSummary { id: string; revision: string; name: string; updated_at: string; mode: AnalysisConfiguration["mode"]; chart: ChartKind; has_series_values: boolean }
export interface SaveAnalysisPreset { id: string | null; revision: string | null; name: string; config: AnalysisConfiguration }
export interface AnalysisSettings {
  mode: AnalysisConfiguration["mode"]; chart: ChartKind; column: number; row: number; split: number; measure: number;
  aggregate: Aggregate; parseStrings: boolean; axisKind: AxisOptions["kind"]; timeOptions: TimeOptions;
  calculatedFields?: CalculatedField[]; metricOptions: MetricOptions; scatterX: number; scatterY: number; scatterLabel: number; sample: boolean;
}
const fail = (code = "invalid"): never => { throw new Error(`preset_${code}`); };
const object = (value: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) return fail();
  return record;
};
const choice = <T extends string>(value: unknown, allowed: readonly T[]): T => typeof value === "string" && allowed.includes(value as T) ? value as T : fail();
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const text = (value: unknown, max: number): string => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail();
function validBindings(config: Pick<AnalysisConfiguration, "mode" | "chart">) {
  if (config.mode === "profile") return { required: ["profile"], optional: [] };
  if (config.mode === "chart" && config.chart === "scatter") return { required: ["x", "y"], optional: ["label"] };
  return { required: config.mode === "chart" && aggregateCard(config.chart) ? ["measure"] : ["row", "measure"], optional: ["split"] };
}
/** Strict configuration-only schema: analysis exports, source rows and unknown fields are refused. */
export function parseAnalysisConfiguration(value: unknown): AnalysisConfiguration {
  const record = object(value, ["version", "mode", "chart", "bindings", "aggregate", "parseStrings", "axisKind", "timeOptions", "metricOptions", "sample", "series"], ["calculations"]);
  if (record.version !== 1 && record.version !== 2) return fail("version");
  const parseBinding = (value: unknown): ColumnBinding => {
    const b = object(value, ["name", "dataType", "ordinal"]);
    if (!Number.isInteger(b.ordinal) || Number(b.ordinal) < 0 || Number(b.ordinal) > 65535) return fail();
    return { name: text(b.name, 512), dataType: text(b.dataType, 128), ordinal: b.ordinal as number };
  };
  let calculations: PresetCalculations | undefined;
  if (record.version === 2) {
    const c = object(record.calculations, ["inputs", "fields"]);
    if (!Array.isArray(c.inputs) || c.inputs.length > 1024 || !Array.isArray(c.fields) || !c.fields.length || c.fields.length > CALCULATION_LIMITS.fields) return fail();
    calculations = { inputs: c.inputs.map(parseBinding), fields: c.fields.map(value => {
      const f = object(value, ["id", "name", "type", "expression"]);
      if (typeof f.expression !== "string" || f.expression.length > CALCULATION_LIMITS.expression || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(f.expression)) return fail();
      return { id: text(f.id, 64), name: text(f.name, 100), type: choice(f.type, CALCULATION_TYPES), expression: f.expression };
    }) };
    try { validateCalculatedFields(calculations.fields, calculations.inputs.map(b => ({ name: b.name, data_type: b.dataType }))); } catch { return fail(); }
  } else if (Object.hasOwn(record, "calculations")) return fail();
  const mode = choice(record.mode, ["profile", "pivot", "chart"] as const), chart = choice(record.chart, CHART_KINDS);
  const roles = validBindings({ mode, chart }), source = object(record.bindings, roles.required, roles.optional);
  const bindings: AnalysisConfiguration["bindings"] = {};
  for (const [role, value] of Object.entries(source)) {
    if (value && typeof value === "object" && Object.hasOwn(value, "calculated")) {
      const b = object(value, ["calculated"]); if (!calculations || !Number.isInteger(b.calculated) || Number(b.calculated) < 0 || Number(b.calculated) >= calculations.fields.length) return fail();
      bindings[role as BindingRole] = { calculated: b.calculated as number };
    } else bindings[role as BindingRole] = parseBinding(value);
  }
  const time = object(record.timeOptions, ["input", "naive", "bucket"]);
  const metric = object(record.metricOptions, ["target", "minimum", "maximum", "direction", "comparison"]);
  const metricOptions: MetricOptions = { target: text(metric.target, 272), minimum: text(metric.minimum, 272), maximum: text(metric.maximum, 272), direction: choice(metric.direction, ["higher", "lower"] as const), comparison: choice(metric.comparison, ["previous", "first"] as const) };
  if (mode === "chart" && chart === "kpi" && !decimal(metricOptions.target)) return fail("target");
  if (mode === "chart" && chart === "gauge") {
    const min = decimal(metricOptions.minimum), max = decimal(metricOptions.maximum);
    if (!min || !max || compare(min, max) >= 0) return fail("range");
  }
  const selected = object(record.series, ["mode"], ["keys"]);
  const seriesMode = choice(selected.mode, ["total", "all", "choose", "keys"] as const);
  let series: SeriesChoice;
  if (seriesMode === "keys") {
    if (!Array.isArray(selected.keys) || !selected.keys.length || selected.keys.length > 12) return fail();
    const keys = selected.keys.map(key => text(key, 2048));
    if (new Set(keys).size !== keys.length || keys.some(key => !key.length)) return fail();
    series = { mode: "keys", keys };
  } else { if (Object.hasOwn(selected, "keys")) return fail(); series = { mode: seriesMode }; }
  const config: AnalysisConfiguration = { version: record.version, ...(calculations ? { calculations } : {}), mode, chart, bindings,
    aggregate: choice(record.aggregate, ["count", "nonNull", "sum", "mean", "min", "max"] as const), parseStrings: bool(record.parseStrings), axisKind: choice(record.axisKind, ["category", "number", "time"] as const),
    timeOptions: { input: choice(time.input, TIME_INPUTS), naive: choice(time.naive, ["utc", "reject"] as const), bucket: choice(time.bucket, TIME_BUCKETS) },
    metricOptions, sample: bool(record.sample), series };
  if (new TextEncoder().encode(JSON.stringify(config)).length > ANALYSIS_CONFIG_BYTES) return fail("size");
  return config;
}
export function parseAnalysisConfigurationText(input: string): AnalysisConfiguration {
  if (input.length > ANALYSIS_CONFIG_BYTES || new TextEncoder().encode(input).length > ANALYSIS_CONFIG_BYTES) return fail("size");
  try { return parseAnalysisConfiguration(JSON.parse(input)); }
  catch (cause) { if (cause instanceof Error && cause.message.startsWith("preset_")) throw cause; return fail(); }
}
/** Capture only active field roles and options; never source labels, SQL, rows or result statistics. */
export function captureAnalysisConfiguration(columns: AnalysisColumn[], settings: AnalysisSettings, selection: SeriesChoice, includeSeriesValues = false): AnalysisConfiguration {
  const fields = settings.calculatedFields ?? [];
  const plan = fields.length ? prepareCalculations(fields, columns) : undefined;
  const calculations: PresetCalculations | undefined = plan && { inputs: plan.inputs.map(i => ({ name: columns[i].name, dataType: columns[i].data_type ?? "", ordinal: i })),
    fields: fields.map(f => ({ ...f, expression: rewriteReferences(f.expression, i => i < columns.length ? plan.inputs.indexOf(i) : plan.inputs.length + i - columns.length) })) };
  const bindings: AnalysisConfiguration["bindings"] = {};
  const bind = (role: BindingRole, index: number) => {
    if (index >= columns.length && fields[index - columns.length]) { bindings[role] = { calculated: index - columns.length }; return; }
    const column = columns[index]; if (!column) return fail("mismatch");
    bindings[role] = { name: column.name, dataType: column.data_type ?? "", ordinal: index };
  };
  if (settings.mode === "profile") bind("profile", settings.column);
  else if (settings.mode === "chart" && settings.chart === "scatter") {
    bind("x", settings.scatterX); bind("y", settings.scatterY); if (settings.scatterLabel >= 0) bind("label", settings.scatterLabel);
  } else {
    if (settings.mode !== "chart" || !aggregateCard(settings.chart)) bind("row", settings.row);
    bind("measure", settings.measure); if (settings.split >= 0) bind("split", settings.split);
  }
  const metricOptions = { ...DEFAULT_METRIC_OPTIONS };
  if (settings.mode === "chart") {
    if (settings.chart === "kpi") { metricOptions.target = settings.metricOptions.target; metricOptions.direction = settings.metricOptions.direction; }
    if (settings.chart === "gauge") { metricOptions.minimum = settings.metricOptions.minimum; metricOptions.maximum = settings.metricOptions.maximum; }
    if (settings.chart === "trend") metricOptions.comparison = settings.metricOptions.comparison;
  }
  const axisKind = settings.mode === "chart" && supportsContinuousAxis(settings.chart) ? settings.axisKind : "category";
  const series: SeriesChoice = settings.mode !== "chart" || settings.chart === "scatter" ? { mode: "total" }
    : selection.mode === "keys" && !includeSeriesValues ? { mode: "choose" } : selection;
  return parseAnalysisConfiguration({ version: calculations ? 2 : 1, ...(calculations ? { calculations } : {}), mode: settings.mode, chart: settings.mode === "chart" ? settings.chart : "bar", bindings,
    aggregate: settings.aggregate, parseStrings: settings.parseStrings, axisKind, timeOptions: axisKind === "time" ? settings.timeOptions : DEFAULT_TIME_OPTIONS,
    metricOptions, sample: settings.sample, series });
}
/** Only unique, exact-name/type matches are proposed. Derived bindings stay attached to the saved formula. */
export function suggestAnalysisMapping(config: AnalysisConfiguration, columns: AnalysisColumn[]): AnalysisMapping {
  const mapping: AnalysisMapping = {};
  const match = (binding: ColumnBinding) => {
    const named = columns.flatMap((column, i) => column.name === binding.name ? [i] : []);
    return named.length === 1 && (columns[named[0]].data_type ?? "").trim().toLowerCase() === binding.dataType.trim().toLowerCase() ? named[0] : undefined;
  };
  for (const [role, binding] of Object.entries(config.bindings)) mapping[role as BindingRole] = "calculated" in binding ? columns.length + binding.calculated : match(binding);
  config.calculations?.inputs.forEach((binding,i) => { mapping[`input:${i}`] = match(binding); });
  // Keep absent matches absent, as before the version-2 extension.
  return Object.fromEntries(Object.entries(mapping).filter(([,value]) => value !== undefined));
}
export function applyAnalysisConfiguration(config: AnalysisConfiguration, columns: AnalysisColumn[], mapping: AnalysisMapping): AnalysisSettings {
  config = parseAnalysisConfiguration(config);
  const sourceIndex = (index: number | undefined) => { if (!Number.isInteger(index) || index! < 0 || !columns[index!]) return fail("mismatch"); return index!; };
  const mapped: Partial<Record<BindingRole, number>> = {};
  for (const [role, binding] of Object.entries(config.bindings)) mapped[role as BindingRole] = "calculated" in binding ? columns.length + binding.calculated : sourceIndex(mapping[role as BindingRole]);
  let calculatedFields: CalculatedField[] | undefined;
  if (config.calculations) {
    const inputs = config.calculations.inputs.map((_,i) => sourceIndex(mapping[`input:${i}`]));
    calculatedFields = config.calculations.fields.map(f => ({ ...f, expression: rewriteReferences(f.expression, i => i < inputs.length ? inputs[i] : columns.length + i - inputs.length) }));
    try { validateCalculatedFields(calculatedFields, columns); } catch { return fail("mismatch"); }
  }
  return { mode: config.mode, chart: config.chart, column: mapped.profile ?? 0, row: mapped.row ?? 0, split: mapped.split ?? -1, measure: mapped.measure ?? 0,
    aggregate: config.aggregate, parseStrings: config.parseStrings, axisKind: config.axisKind, timeOptions: { ...config.timeOptions }, metricOptions: { ...config.metricOptions },
    scatterX: mapped.x ?? 0, scatterY: mapped.y ?? 0, scatterLabel: mapped.label ?? -1, sample: config.sample, ...(calculatedFields ? { calculatedFields } : {}) };
}
