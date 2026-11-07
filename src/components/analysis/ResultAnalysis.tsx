import { CalculatedFieldsEditor, calculationErrorText } from "./CalculatedFieldsEditor";
import { calculationColumns, prepareCalculations, type CalculatedField } from "@/lib/calculatedFields";
import { calculationFailure, type PipelineResponse, type AnalysisPipelineRequest } from "@/lib/analysisPipeline";
import { AnalysisPresetLibrary } from "./AnalysisPresetLibrary";
import { captureAnalysisConfiguration, type AnalysisConfiguration, type AnalysisSettings, type SeriesChoice } from "@/lib/analysisPresets";
import { cloneElement, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useT } from "@/store/i18n";
import { saveTextFile, toCSV } from "@/lib/csv";
import { ANALYSIS_LIMITS, projectionBudget, type AxisOptions, type Aggregate, type Bucket, type Scalar } from "@/lib/resultAnalysis";
import { ScatterChart } from "./ScatterChart";
import { ResultChart } from "./ResultChart";
import { CHART_KINDS, chartIssue, supportsContinuousAxis, aggregateCard, DEFAULT_METRIC_OPTIONS, type MetricOptions, type ChartKind, type ChartSeries } from "@/lib/resultCharts";
import { DEFAULT_TIME_OPTIONS, TIME_INPUTS, TIME_BUCKETS, type TimeOptions } from "@/lib/resultTime";
import { cn } from "@/lib/cn";

interface Column { name: string; data_type?: string }
export interface AnalysisSnapshot { columns: Column[]; rows: unknown[][]; scope: "result" | "page"; label: string }
const categoryAxis: AxisOptions = { kind: "category" };
const numberAxis: AxisOptions = { kind: "number" };
const selectClass = "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs";
const operations: Aggregate[] = ["count", "nonNull", "sum", "mean", "min", "max"];
const numericType = (type = "") => /^(?:tinyint|smallint|mediumint|bigint|int\d*|integer|int2|int4|int8|float\d*|double(?: precision)?|real|numeric|decimal|number|money)(?:\b|\()/i.test(type);
// Spreadsheet applications can interpret dimension/header text as formulas.
const csvLabel = (value: string) => /^[=+@\-\t\r\n]/.test(value) ? "'" + value : value;
const text = (value: Scalar) => value.value == null ? "NULL" : (value.rounded ? "≈ " : "") + value.value;

export function ResultAnalysis({ snapshot, onClose }: { snapshot: AnalysisSnapshot; onClose: () => void }) {
  const t = useT();
  const [calculatedFields, setCalculatedFields] = useState<CalculatedField[]>([]);
  const [calculationEditor, setCalculationEditor] = useState(false);
  const columns = useMemo(() => [...snapshot.columns, ...calculationColumns(calculatedFields)], [snapshot.columns, calculatedFields]);
  const [mode, setMode] = useState<"profile" | "pivot" | "chart">("profile");
  const [column, setColumn] = useState(0);
  const [row, setRow] = useState(0);
  const [split, setSplit] = useState(-1);
  const [measure, setMeasure] = useState(() => Math.max(0, columns.findIndex(c => numericType(c.data_type))));
  const [aggregate, setAggregate] = useState<Aggregate>("count");
  const [parseStrings, setParseStrings] = useState(() => numericType(columns[0]?.data_type));
  const [chart, setChart] = useState<ChartKind>("bar");
  const [axisKind, setAxisKind] = useState<AxisOptions["kind"]>("category");
  const [timeOptions, setTimeOptions] = useState<TimeOptions>({ ...DEFAULT_TIME_OPTIONS });
  const [metricOptions, setMetricOptions] = useState<MetricOptions>({ ...DEFAULT_METRIC_OPTIONS });
  const [scatterX, setScatterX] = useState(() => Math.max(0, columns.findIndex(c => numericType(c.data_type))));
  const [scatterY, setScatterY] = useState(() => { const first = Math.max(0, columns.findIndex(c => numericType(c.data_type))); const next = columns.findIndex((c, i) => i !== first && numericType(c.data_type)); return next >= 0 ? next : columns.length > 1 ? first === 0 ? 1 : 0 : 0; });
  const [scatterLabel, setScatterLabel] = useState(-1);
  const [sample, setSample] = useState(true);
  const [series, setSeries] = useState(-1);
  const [presetSelection, setPresetSelection] = useState<SeriesChoice | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const [job, setJob] = useState<PipelineResponse & { request: object } | null>(null);
  const [exporting, setExporting] = useState(false);
  const locked = exporting || libraryOpen || calculationEditor;
  const [exportError, setExportError] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const kind = mode === "profile" ? "profile" : mode === "chart" && chart === "scatter" ? "scatter" : "pivot";
  const selectedAxis = useMemo<AxisOptions>(() => axisKind === "time" ? { kind: "time", time: timeOptions } : axisKind === "number" ? numberAxis : categoryAxis, [axisKind, timeOptions]);
  const axis = mode === "chart" && supportsContinuousAxis(chart) ? selectedAxis : categoryAxis;
  const collapseRows = mode === "chart" && aggregateCard(chart);
  // Stable request identity invalidates old output synchronously, before the effect starts a new worker.
  const requestKey = `${kind}:${column}:${row}:${split}:${measure}:${aggregate}:${parseStrings}:${collapseRows}:${scatterX}:${scatterY}:${scatterLabel}:${sample}:${JSON.stringify(axis)}:${JSON.stringify(calculatedFields)}:${attempt}`;
  const requestIdentity = useRef({ key: requestKey, token: {} });
  if (requestIdentity.current.key !== requestKey) requestIdentity.current = { key: requestKey, token: {} };
  const token = requestIdentity.current.token;
  const active = job?.request === token ? job : null;
  const result = active?.result;
  const error = active?.error;

  useEffect(() => {
    let worker: Worker | undefined, cancelled = false;
    setExportError(false);
    if (snapshot.rows.length > ANALYSIS_LIMITS.rows) { setJob({ request: token, error: "rows" }); return; }
    const prepare = async () => {
      try {
        const validateRow = projectionBudget();
        const projection = kind === "profile" ? [column] : kind === "scatter" ? [scatterX, scatterY, scatterLabel] : [collapseRows ? -1 : row, split, measure];
        const calculations = calculatedFields.length ? prepareCalculations(calculatedFields, snapshot.columns, projection) : undefined;
        const rows: unknown[][] = [];
        for (let index = 0; index < snapshot.rows.length; index++) {
          const source = snapshot.rows[index];
          const projected = calculations ? calculations.inputs.map(i => source[i]) : kind === "profile" ? [source[column]] : kind === "scatter" ? [source[scatterX], source[scatterY], scatterLabel < 0 ? null : source[scatterLabel]]
            : [collapseRows ? null : source[row], split < 0 ? null : source[split], source[measure]];
          validateRow(projected);
          rows.push(projected);
          if (index % 256 === 255) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (cancelled) return;
          }
        }
        if (cancelled) return;
        worker = new Worker(new URL("../../lib/resultAnalysis.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = event => {
          if (!cancelled) setJob({ request: token, ...event.data });
          worker?.terminate();
        };
        const failed = () => { if (!cancelled) setJob({ request: token, error: "worker" }); worker?.terminate(); };
        worker.onerror = failed;
        worker.onmessageerror = failed;
        const request: AnalysisPipelineRequest = kind === "profile"
          ? { kind, parseStrings, rows }
          : kind === "scatter" ? { kind, parseStrings, sample, labels: scatterLabel >= 0, rows }
          : { kind, parseStrings, aggregate, split: split >= 0, rows, axis };
        worker.postMessage(calculations ? { ...request, calculations } : request);
      } catch (failure) {
        worker?.terminate();
        if (!cancelled) setJob({ request: token, ...calculationFailure(failure) });
      }
    };
    void prepare();
    return () => { cancelled = true; worker?.terminate(); };
  }, [snapshot, kind, column, row, split, measure, aggregate, parseStrings, token, collapseRows, scatterX, scatterY, scatterLabel, sample, axis, calculatedFields]);

  const bucketLabel = (b: Bucket) => b.type === "all" ? t("analysis.all") : `${b.label === "" ? t("analysis.empty_value") : b.label} [${b.type}]`;
  const dimensionOptions = columns.map((c, i) => <option key={i} value={i}>{i + 1}. {c.name} · {c.data_type || "?"}</option>);
  const field = (label: string, control: ReactElement<{ "aria-label"?: string }>) => <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">{t(label)}{cloneElement(control, { "aria-label": t(label) })}</label>;
  const output = result?.kind === "pivot" ? result : null;
  const selectedSeries = series === -2 ? -2 : output && series >= 0 && series < output.columns.length ? series : -1;
  const effectiveHidden = presetSelection?.mode === "choose" ? new Set(output?.columns.map(b => b.key))
    : presetSelection?.mode === "keys" ? new Set(output?.columns.filter(b => !presetSelection.keys.includes(b.key)).map(b => b.key))
    : presetSelection?.mode === "all" ? new Set<string>() : hiddenSeries;
  const missingSeries = presetSelection?.mode === "keys" && !!output && presetSelection.keys.some(key => !output.columns.some(b => b.key === key));
  const orderedColumns = presetSelection?.mode === "keys" && output ? presetSelection.keys.flatMap(key => { const i = output.columns.findIndex(b => b.key === key); return i < 0 ? [] : [{ b: output.columns[i], i }]; }) : output?.columns.map((b,i) => ({ b, i }));
  const chartSeries: ChartSeries[] = !output ? [] : selectedSeries === -2
    ? orderedColumns!.flatMap(({ b, i }) => effectiveHidden.has(b.key) ? [] : [{ key: b.key, label: bucketLabel(b), values: output.cells.map(cells => cells[i]), summary: output.columnTotals[i] }])
    : [{ key: selectedSeries < 0 ? "total" : output.columns[selectedSeries].key,
      label: selectedSeries < 0 ? t("analysis.total") : bucketLabel(output.columns[selectedSeries]),
      values: selectedSeries < 0 ? output.rowTotals : output.cells.map(cells => cells[selectedSeries]), summary: selectedSeries < 0 ? output.total : output.columnTotals[selectedSeries] }];
  const chartTitle = `${collapseRows ? columns[measure]?.name : columns[row]?.name} · ${t(`analysis.${aggregate}`)} · ${selectedSeries === -2 ? t("analysis.multiple_series") : chartSeries[0]?.label ?? ""}`;
  const chartError = output ? chartIssue({ rows: output.rows, series: chartSeries, kind: chart, options: metricOptions, axis: output.axis }) : "empty";

  const scatter = result?.kind === "scatter" ? result : null;
  const scatterTitle = `${columns[scatterY]?.name} × ${columns[scatterX]?.name}`;
  const canExportChart = mode === "chart" && (scatter ? scatter.points.length > 0 : !!output && !chartError && !missingSeries);
  const setTime = <K extends keyof TimeOptions>(key: K, value: TimeOptions[K]) => setTimeOptions(current => ({ ...current, [key]: value }));
  const setMetric = <K extends keyof MetricOptions>(key: K, value: MetricOptions[K]) => setMetricOptions(current => ({ ...current, [key]: value }));

  const exportData = async (format: "json" | "csv" | "svg") => {
    if (!result || exporting) return;
    setExporting(true); setExportError(false);
    try {
      let content: string;
      if (format === "svg") {
        if (!svg.current) return;
        content = new XMLSerializer().serializeToString(svg.current);
      } else if (format === "csv" && result.kind === "pivot") {
        const dimension = columns[row].name;
        const header = result.axis?.kind === "time" ? `${dimension} · UTC · ${t(`analysis.time_bucket.${result.axis.time.bucket}`)} · ${t(`analysis.time_input.${result.axis.time.input}`)}`
          : result.axis?.kind === "number" ? `${dimension} · ${t("analysis.axis.number")}` : dimension;
        content = toCSV([header, ...result.columns.map(bucketLabel), t("analysis.total")].map(csvLabel), [
          ...result.rows.map((b, i) => [csvLabel(bucketLabel(b)), ...result.cells[i].map(text), text(result.rowTotals[i])]),
          [t("analysis.total"), ...result.columnTotals.map(text), text(result.total)],
        ]);
      } else if (format === "csv" && result.kind === "scatter") {
        content = toCSV([t("analysis.row_number"), t("analysis.point_label"), `${t("analysis.scatter_x")}: ${columns[scatterX].name}`, `${t("analysis.scatter_y")}: ${columns[scatterY].name}`].map(csvLabel),
          result.points.map(point => [point.index + 1, csvLabel(point.label ?? ""), point.x.value, point.y.value]));
      } else {
        content = JSON.stringify({ version: 1, source: snapshot.label, scope: snapshot.scope, loadedRows: snapshot.rows.length,
          columns, calculatedFields, calculationStats: active?.calculationStats, configuration: { column, row, split, measure, aggregate, parseStrings, chart, axisKind, timeOptions, metricOptions, scatterX, scatterY, scatterLabel, sample, series: selectedSeries, hiddenSeries: [...effectiveHidden], presetSeries: presetSelection }, result }, null, 2);
      }
      await saveTextFile(`result-analysis.${format}`, content, format);
    } catch { setExportError(true); }
    finally { setExporting(false); }
  };
  const settings: AnalysisSettings = { calculatedFields, mode, chart, column, row, split, measure, aggregate, parseStrings, axisKind, timeOptions, metricOptions, scatterX, scatterY, scatterLabel, sample };
  const selection: SeriesChoice = presetSelection ?? (series >= 0 && !output ? { mode: "choose" } : selectedSeries === -1 ? { mode: "total" } : selectedSeries === -2 && !hiddenSeries.size ? { mode: "all" }
    : chartSeries.length ? { mode: "keys", keys: chartSeries.map(s => s.key) } : { mode: "choose" });
  const loadConfiguration = (next: AnalysisSettings, config: AnalysisConfiguration) => {
    setCalculatedFields(next.calculatedFields ?? []);
    setMode(next.mode); setChart(next.chart); setColumn(next.column); setRow(next.row); setSplit(next.split); setMeasure(next.measure);
    setAggregate(next.aggregate); setParseStrings(next.parseStrings); setAxisKind(next.axisKind); setTimeOptions(next.timeOptions); setMetricOptions(next.metricOptions);
    setScatterX(next.scatterX); setScatterY(next.scatterY); setScatterLabel(next.scatterLabel); setSample(next.sample);
    setSeries(config.series.mode === "total" ? -1 : -2); setHiddenSeries(new Set()); setPresetSelection(config.series);
    setAttempt(n => n + 1); setExportError(false);
  };
  const applyCalculatedFields = (next: CalculatedField[]) => {
    const remap = (index: number) => {
      if (index < snapshot.columns.length) return index;
      const found = next.findIndex(f => f.id === calculatedFields[index - snapshot.columns.length]?.id);
      return found < 0 ? 0 : snapshot.columns.length + found;
    };
    setColumn(remap(column)); setRow(remap(row)); setMeasure(remap(measure)); setSplit(split < 0 ? split : remap(split));
    setScatterX(remap(scatterX)); setScatterY(remap(scatterY)); setScatterLabel(scatterLabel < 0 ? scatterLabel : remap(scatterLabel));
    setCalculatedFields(next); setCalculationEditor(false); setAttempt(n => n+1);
  };
  const changeMode = (next: typeof mode) => {
    if ((mode === "profile") !== (next === "profile")) setParseStrings(numericType(columns[next === "profile" ? column : measure]?.data_type));
    setMode(next);
  };
  return <Modal open onClose={onClose} title={t("analysis.title")} width={1000} closeDisabled={locked} footer={<>
    {exportError && <span role="alert" className="text-xs text-danger">{t("analysis.export_failed")}</span>}
    <Button size="sm" disabled={!result || locked} onClick={() => void exportData("json")}>{t("analysis.export")}</Button>
    {scatter && <Button size="sm" disabled={locked} onClick={() => void exportData("csv")}>{t("analysis.export_points_csv")}</Button>}
    {output && <Button size="sm" disabled={locked} onClick={() => void exportData("csv")}>{t("analysis.export_csv")}</Button>}
    {canExportChart && <Button size="sm" disabled={locked} onClick={() => void exportData("svg")}>{t("analysis.export_svg")}</Button>}
    <Button size="sm" onClick={onClose} disabled={locked}>{t("common.close")}</Button>
  </>}>
    <div className="space-y-4 text-sm">
      <div><p className="truncate font-medium" title={snapshot.label}>{snapshot.label}</p><p className="mt-1 text-xs text-muted-foreground">{t(`analysis.scope.${snapshot.scope}`, { n: snapshot.rows.length })}</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={locked} onClick={() => setCalculationEditor(true)}>{t("analysis.calculations.title")}{calculatedFields.length > 0 ? ` (${calculatedFields.length})` : ""}</Button>
      <AnalysisPresetLibrary columns={snapshot.columns} capture={includeSeries => captureAnalysisConfiguration(snapshot.columns, settings, selection, includeSeries)} onLoad={loadConfiguration} disabled={exporting || calculationEditor} onOpenChange={setLibraryOpen} /></div>
      {calculationEditor && <CalculatedFieldsEditor columns={snapshot.columns} rows={snapshot.rows} fields={calculatedFields} onApply={applyCalculatedFields} onClose={() => setCalculationEditor(false)} />}
      <div className="flex flex-wrap gap-1 border-b border-border pb-2" role="group" aria-label={t("analysis.title")}>
        {(["profile", "pivot", "chart"] as const).map(value => <Button key={value} size="sm" variant={mode === value ? "primary" : "ghost"} aria-pressed={mode === value} disabled={locked} onClick={() => changeMode(value)}>{t(`analysis.${value}`)}</Button>)}
      </div>
      {mode === "chart" && <div className="grid grid-cols-2 gap-3">{field("analysis.chart_type", <select className={selectClass} value={chart} disabled={locked} onChange={e => setChart(e.target.value as ChartKind)}>{CHART_KINDS.map(v => <option key={v} value={v}>{t(`analysis.${v}`)}</option>)}</select>)}</div>}
      <fieldset disabled={locked} className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {mode === "profile" ? field("analysis.column", <select className={selectClass} value={column} onChange={e => { const index = Number(e.target.value); setColumn(index); setParseStrings(numericType(columns[index]?.data_type)); }}>{dimensionOptions}</select>) : kind === "scatter" ? <>
            {field("analysis.scatter_x", <select className={selectClass} value={scatterX} onChange={e => setScatterX(Number(e.target.value))}>{dimensionOptions}</select>)}
            {field("analysis.scatter_y", <select className={selectClass} value={scatterY} onChange={e => setScatterY(Number(e.target.value))}>{dimensionOptions}</select>)}
            {field("analysis.point_label", <select className={selectClass} value={scatterLabel} onChange={e => setScatterLabel(Number(e.target.value))}><option value={-1}>{t("analysis.row_number")}</option>{dimensionOptions}</select>)}
          </> : <>
            {!collapseRows && field("analysis.row", <select className={selectClass} value={row} onChange={e => setRow(Number(e.target.value))}>{dimensionOptions}</select>)}
            {field("analysis.split", <select className={selectClass} value={split} onChange={e => { setSplit(Number(e.target.value)); setSeries(-1); setPresetSelection(null); setHiddenSeries(new Set()); }}><option value={-1}>{t("analysis.none")}</option>{dimensionOptions}</select>)}
            {field("analysis.measure", <select className={selectClass} value={measure} onChange={e => { const index = Number(e.target.value); setMeasure(index); setParseStrings(numericType(columns[index]?.data_type)); }}>{dimensionOptions}</select>)}
            {field("analysis.aggregate", <select className={selectClass} value={aggregate} onChange={e => setAggregate(e.target.value as Aggregate)}>{operations.map(value => <option key={value} value={value}>{t(`analysis.${value}`)}</option>)}</select>)}
          </>}
        </div>
        {mode === "chart" && supportsContinuousAxis(chart) && <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {field("analysis.axis", <select className={selectClass} value={axisKind} onChange={e => setAxisKind(e.target.value as AxisOptions["kind"])}>{(["category", "number", "time"] as const).map(value => <option key={value} value={value}>{t(`analysis.axis.${value}`)}</option>)}</select>)}
            {axisKind === "time" && <>
              {field("analysis.time_input", <select className={selectClass} value={timeOptions.input} onChange={e => setTime("input", e.target.value as TimeOptions["input"])}>{TIME_INPUTS.map(value => <option key={value} value={value}>{t(`analysis.time_input.${value}`)}</option>)}</select>)}
              {timeOptions.input === "iso" && field("analysis.time_naive", <select className={selectClass} value={timeOptions.naive} onChange={e => setTime("naive", e.target.value as TimeOptions["naive"])}><option value="utc">{t("analysis.time_naive.utc")}</option><option value="reject">{t("analysis.time_naive.reject")}</option></select>)}
              {field("analysis.time_bucket", <select className={selectClass} value={timeOptions.bucket} onChange={e => setTime("bucket", e.target.value as TimeOptions["bucket"])}>{TIME_BUCKETS.map(value => <option key={value} value={value}>{t(`analysis.time_bucket.${value}`)}</option>)}</select>)}
            </>}
          </div>
          {axisKind !== "category" && <p className="text-xs text-muted-foreground">{t(axisKind === "time" ? "analysis.time_hint" : "analysis.number_hint")}</p>}
        </>}
        {kind === "scatter" && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={sample} onChange={e => setSample(e.target.checked)} />{t("analysis.sample_option")}</label>}
        {collapseRows && <p className="text-xs text-muted-foreground">{t("analysis.card_source_hint")}</p>}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={parseStrings} onChange={e => setParseStrings(e.target.checked)} />{t("analysis.strings")}</label>
      </fieldset>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("analysis.rules")}</summary><p className="mt-1">{t("analysis.numeric_hint")}</p></details>
      {!result && !error && <div role="status" className="flex items-center gap-2 py-10 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("analysis.busy")}</div>}
      {error && <div role="alert" className="space-y-2 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs"><p>{error === "calculation" ? calculationErrorText(active!, t, calculatedFields) : t(`analysis.error.${["rows", "size", "depth", "groups", "value", "worker", "points", "axis_time", "axis_number"].includes(error) ? error : "value"}`)}</p><Button size="sm" onClick={() => setAttempt(n => n + 1)}>{t("analysis.retry")}</Button></div>}
      {result && <>
        {!!active?.calculationStats?.roundedRows && <p role="status" className="rounded-md bg-accent p-2 text-xs">{t("analysis.calculations.rounded", { n: active.calculationStats.roundedRows })}</p>}
        <dl className={result.kind === "profile" ? "grid grid-cols-2 gap-2 sm:grid-cols-4" : "flex flex-wrap gap-x-5 gap-y-1 rounded-md bg-surface-muted/30 px-3 py-2"}>
          {(result.kind === "profile" ? ["count", "nulls", "empty", "distinct", "singletons", "numeric", "invalid"] : ["count", "nulls", "numeric", "invalid"]).map(key => <div key={key} className={result.kind === "profile" ? "min-w-0 rounded-lg border border-border/70 bg-surface-muted/30 p-3" : "flex items-center gap-2"}><dt className="text-[11px] text-muted-foreground">{t(`analysis.${key === "count" ? "count_rows" : key}`)}</dt><dd className={result.kind === "profile" ? "mt-1 text-lg font-semibold tabular-nums" : "text-xs font-semibold tabular-nums"}>{result[key as keyof typeof result] as number}</dd></div>)}
        </dl>
        {result.kind === "profile" && <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">{(["min", "max", "sum", "mean", "median"] as const).map(key => <div key={key} className="min-w-0 rounded-lg border border-border/70 p-3"><dt className="text-xs text-muted-foreground">{t(`analysis.${key}`)}</dt><dd className="mt-1 break-all font-mono text-xs">{text(result[key])}</dd></div>)}</dl>
          <p className="text-xs text-muted-foreground">{t("analysis.distinct_hint")}</p>
          <div><h3 className="mb-2 text-xs font-medium">{t("analysis.types")}</h3><div className="flex flex-wrap gap-2">{Object.entries(result.types).map(([type, count]) => <span key={type} className="rounded-md bg-accent px-2 py-1 text-xs">{type} · {count}</span>)}</div></div>
          <div><h3 className="mb-2 font-medium">{t("analysis.distribution")}</h3><div className="max-h-72 overflow-auto rounded-lg border border-border"><table className="w-full table-fixed text-xs"><thead className="sticky top-0 bg-surface-elevated"><tr><th className="w-1/2 p-2 text-left">{t("analysis.value")}</th><th className="p-2 text-left">{t("analysis.frequency")}</th></tr></thead><tbody>{result.top.map(b => <tr key={b.key} className="border-t border-border/50"><td className="truncate p-2 font-mono" title={bucketLabel(b)}>{bucketLabel(b)}</td><td className="p-2"><div className="flex items-center gap-2"><div className="h-1.5 flex-1 rounded bg-accent"><div className="h-full rounded bg-brand" style={{ width: `${100 * b.count / Math.max(result.count, 1)}%` }} /></div><span className="w-14 text-right tabular-nums">{b.count}</span></div></td></tr>)}</tbody></table></div></div>
        </>}
        {scatter && <>
          <p role="status" className="rounded-md bg-accent p-2 text-xs">{t(scatter.sampled ? "analysis.sampled_plot" : "analysis.complete_plot", { plotted: scatter.points.length, valid: scatter.numeric })}</p>
          <p className="text-xs text-muted-foreground">{t("analysis.scatter_hint")}</p>
          <div className="overflow-x-auto rounded-lg border border-border"><ScatterChart ref={svg} data={scatter} title={scatterTitle} xLabel={columns[scatterX].name} yLabel={columns[scatterY].name} /></div>
        </>}
        {output && (mode === "chart" ? <>
          <div className="grid grid-cols-2 gap-3">{field("analysis.series", <select className={selectClass} value={selectedSeries} disabled={locked} onChange={e => { setSeries(Number(e.target.value)); setPresetSelection(null); setHiddenSeries(new Set()); }}><option value={-1}>{t("analysis.total")}</option><option value={-2}>{t("analysis.multiple_series")}</option>{output.columns.map((b, i) => <option key={b.key} value={i}>{bucketLabel(b)}</option>)}</select>)}
          </div>
          {selectedSeries === -2 && <fieldset disabled={locked} className="rounded-md border border-border p-2">
            <legend className="px-1 text-xs text-muted-foreground">{t("analysis.visible_series", { n: chartSeries.length })}</legend>
            <div className="mb-2 flex gap-2"><Button size="sm" variant="ghost" onClick={() => { setPresetSelection(null); setHiddenSeries(new Set()); }}>{t("analysis.select_all")}</Button><Button size="sm" variant="ghost" onClick={() => { setPresetSelection(null); setHiddenSeries(new Set(output.columns.map(b => b.key))); }}>{t("analysis.clear_series")}</Button></div>
            <div className="grid max-h-24 grid-cols-2 gap-2 overflow-auto md:grid-cols-3">{output.columns.map(b => <label key={b.key} className="flex min-w-0 items-center gap-2 text-xs" title={bucketLabel(b)}><input type="checkbox" aria-label={bucketLabel(b)} checked={!effectiveHidden.has(b.key)} onChange={e => { const next = new Set(effectiveHidden); if (e.target.checked) next.delete(b.key); else next.add(b.key); setHiddenSeries(next); setPresetSelection(null); }} /><span className="truncate">{bucketLabel(b)}</span></label>)}</div>
          </fieldset>}
          <fieldset disabled={locked} className="grid grid-cols-2 gap-3">
            {chart === "kpi" && <>{field("analysis.target", <input className={selectClass} maxLength={272} value={metricOptions.target} onChange={e => setMetric("target", e.target.value)} />)}{field("analysis.target_direction", <select className={selectClass} value={metricOptions.direction} onChange={e => setMetric("direction", e.target.value as MetricOptions["direction"])}><option value="higher">{t("analysis.higher")}</option><option value="lower">{t("analysis.lower")}</option></select>)}</>}
            {chart === "gauge" && <>{field("analysis.range_min", <input className={selectClass} maxLength={272} value={metricOptions.minimum} onChange={e => setMetric("minimum", e.target.value)} />)}{field("analysis.range_max", <input className={selectClass} maxLength={272} value={metricOptions.maximum} onChange={e => setMetric("maximum", e.target.value)} />)}</>}
            {chart === "trend" && field("analysis.compare_with", <select className={selectClass} value={metricOptions.comparison} onChange={e => setMetric("comparison", e.target.value as MetricOptions["comparison"])}><option value="previous">{t("analysis.previous_item")}</option><option value="first">{t("analysis.first_item")}</option></select>)}
          </fieldset>
          {chart === "trend" && <p className="text-xs text-muted-foreground">{t(axis.kind === "category" ? "analysis.trend_hint" : "analysis.continuous_trend_hint")}</p>}
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("analysis.chart_rules")}</summary><p className="mt-1">{t(axis.kind === "category" ? "analysis.chart_hint" : "analysis.continuous_chart_hint")}</p><p className="mt-1">{t("analysis.chart_semantics")}</p></details>
          {missingSeries ? <p role="alert" className="text-xs text-danger">{t("analysis.presets.missing_series")}</p> : <div className="overflow-x-auto rounded-lg border border-border"><ResultChart ref={svg} rows={output.rows} series={chartSeries} kind={chart} title={chartTitle} options={metricOptions} axis={output.axis} /></div>}
        </> : <div className="max-h-96 overflow-auto rounded-lg border border-border"><table className="w-full border-collapse text-xs"><thead className="sticky top-0 z-10 bg-surface-elevated"><tr><th className="p-2 text-left">{columns[row].name}</th>{output.columns.map(b => <th key={b.key} className="max-w-52 truncate p-2 text-right" title={bucketLabel(b)}>{bucketLabel(b)}</th>)}<th className="p-2 text-right">{t("analysis.total")}</th></tr></thead><tbody>{output.rows.map((b, i) => <tr key={b.key} className="border-t border-border/60"><th className="max-w-52 truncate p-2 text-left font-normal" title={bucketLabel(b)}>{bucketLabel(b)}</th>{[...output.cells[i], output.rowTotals[i]].map((v, j) => <td key={j} className={cn("max-w-64 truncate p-2 text-right font-mono", j === output.cells[i].length && "font-semibold")} title={text(v)}>{text(v)}</td>)}</tr>)}</tbody><tfoot className="border-t border-border bg-surface-muted/40 font-semibold"><tr><th className="p-2 text-left">{t("analysis.total")}</th>{[...output.columnTotals, output.total].map((v, i) => <td key={i} className="max-w-64 truncate p-2 text-right font-mono" title={text(v)}>{text(v)}</td>)}</tr></tfoot></table></div>)}
      </>}
    </div>
  </Modal>;
}
