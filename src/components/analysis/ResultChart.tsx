import { forwardRef, useMemo, type ReactNode } from "react";
import { chartRatio, maxMagnitude, type AxisOptions, type Bucket, type Scalar } from "@/lib/resultAnalysis";
import { axisLayout, shortChartLabel as short, chartIssue, DEFAULT_METRIC_OPTIONS, metricChart, comboChart, numericDomain, scalarText, sign, stackLevels, sum, treeRectangles, waterfallLevels, ZERO, type ChartKind, type ChartSeries, type MetricOptions, type Level } from "@/lib/resultCharts";
import { MetricChart } from "./MetricChart";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useT } from "@/store/i18n";
export type { ChartKind } from "@/lib/resultCharts";
const palettes = {
  light: ["#0f766e", "#2563eb", "#c2410c", "#9333ea", "#be123c", "#4d7c0f", "#0369a1", "#a16207", "#6d28d9", "#b91c1c", "#047857", "#475569"],
  dark: ["#2dd4bf", "#60a5fa", "#fb923c", "#c084fc", "#fb7185", "#a3e635", "#38bdf8", "#facc15", "#a78bfa", "#f87171", "#34d399", "#cbd5e1"],
};
interface Props { axis?: AxisOptions; rows: Bucket[]; values?: Scalar[]; series?: ChartSeries[]; kind: ChartKind; title: string; options?: MetricOptions }

export const ResultChart = forwardRef<SVGSVGElement, Props>(({ rows, values, series: provided, kind, title, axis, options = DEFAULT_METRIC_OPTIONS }, ref) => {
  const t = useT();
  const { theme } = useTheme();
  const series = useMemo(() => provided ?? [{ key: "single", label: t("analysis.total"), values: values ?? [] }], [provided, values, t]);
  const issue = chartIssue({ rows, series, kind, options, axis });
  if (issue) return <p role="status" className="p-6 text-sm text-muted-foreground">{t(`analysis.chart_error.${issue}`)}</p>;
  if (metricChart(kind)) return <MetricChart ref={ref} kind={kind} title={title} rows={rows} series={series} options={options} axis={axis} />;
  const continuous = axisLayout(rows, axis);
  const dark = theme === "dark", ink = dark ? "#cbd5e1" : "#334155", paper = dark ? "#111827" : "#f8fafc";
  const colors = palettes[theme], color = (i: number) => colors[i % colors.length];
  const label = (row: Bucket) => `${row.label === "" ? t("analysis.empty_value") : row.label} [${row.type}]`;
  const detail = (row: number, s: number) => `${label(rows[row])} · ${series[s].label}: ${scalarText(series[s].values[row])}`;
  const group = (key: string, description: string, children: ReactNode) => <g key={key} tabIndex={0} role="img" aria-label={description}><title>{description}</title>{children}</g>;
  const categoryChart = ["pie", "donut", "treemap"].includes(kind);
  const legend = kind === "heatmap" ? [
    { key: "positive", label: t("analysis.positive_values"), color: "#2dd4bf" },
    { key: "negative", label: t("analysis.negative_values"), color: "#fb7185" },
    { key: "zero", label: t("analysis.zero_values"), color: dark ? "#334155" : "#e2e8f0" },
  ] : kind === "waterfall" ? [
    { key: "increase", label: t("analysis.increase"), color: color(0) },
    { key: "decrease", label: t("analysis.decrease"), color: dark ? "#fb7185" : "#be123c" },
    { key: "total", label: t("analysis.total"), color: color(1) },
  ] : categoryChart ? rows.map((row, i) => ({ key: row.key, label: `${label(row)}: ${scalarText(series[0].values[i])}`, color: color(i) }))
    : series.map((s, i) => ({ key: s.key, label: s.label + (comboChart(kind) && i === series.length - 1 ? ` · ${t("analysis.line")}` : ""), color: color(i) }));
  const legendHeight = Math.ceil(legend.length / 3) * 22 + 24;
  let content: ReactNode;
  let plotBottom = 390;

  if (kind === "pie" || kind === "donut") {
    const data = series[0].values, total = sum(data), cx = 400, cy = 205, radius = 145;
    let running = ZERO;
    content = <>
      {data.map((value, i) => {
        if (sign(value) <= 0) return null;
        const start = chartRatio(running.value!, total.value!) * 2 * Math.PI - Math.PI / 2;
        running = sum([running, value]);
        const end = chartRatio(running.value!, total.value!) * 2 * Math.PI - Math.PI / 2;
        const point = (angle: number) => `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
        const path = end - start >= 2 * Math.PI - 1e-10
          ? `M ${cx},${cy - radius} A ${radius},${radius} 0 1 1 ${cx},${cy + radius} A ${radius},${radius} 0 1 1 ${cx},${cy - radius} Z`
          : `M ${cx},${cy} L ${point(start)} A ${radius},${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${point(end)} Z`;
        return group(rows[i].key, detail(i, 0), <path d={path} fill={color(i)} stroke={paper} strokeWidth="1" />);
      })}
      {kind === "donut" && <><circle cx={cx} cy={cy} r={85} fill={paper} /><text x={cx} y={cy - 6} textAnchor="middle">{t("analysis.total")}</text><text x={cx} y={cy + 15} fontSize="14" fontWeight="600" textAnchor="middle"><title>{scalarText(total)}</title>{short(scalarText(total), 18)}</text></>}
    </>;
  } else if (kind === "treemap") {
    content = treeRectangles(series[0].values, 744, 320).map(rect => group(rows[rect.index].key, detail(rect.index, 0), <>
      <rect x={28 + rect.x} y={50 + rect.y} width={rect.width} height={rect.height} fill={color(rect.index)} stroke={paper} strokeWidth="2" />
      {rect.width > 60 && rect.height > 32 && <text x={36 + rect.x} y={70 + rect.y} fill={dark ? "#111827" : "#ffffff"} fontWeight="600">{short(rows[rect.index].label || t("analysis.empty_value"), Math.max(2, Math.floor((rect.width - 16) / 8)))}</text>}
    </>));
  } else if (kind === "heatmap") {
    const cellWidth = 610 / series.length, cellHeight = 28;
    const max = maxMagnitude(series.flatMap(s => s.values));
    plotBottom = 106 + rows.length * cellHeight;
    content = <>
      {series.map((s, j) => <text key={s.key} x={170 + j * cellWidth + cellWidth / 2} y={66} textAnchor="middle"><title>{s.label}</title>{short(s.label, Math.max(3, Math.floor(cellWidth / 7)))}</text>)}
      {rows.map((row, i) => <g key={row.key}>
        <text x="160" y={97 + i * cellHeight} textAnchor="end"><title>{label(row)}</title>{short(label(row), 22)}</text>
        {series.map((s, j) => {
          const value = s.values[i], ratio = value.value == null ? 0 : chartRatio(value.value, max);
          const opacity = Math.abs(ratio);
          return group(s.key, detail(i, j), <>
            <rect x={170 + j * cellWidth} y={78 + i * cellHeight} width={cellWidth - 2} height={cellHeight - 2} fill={dark ? "#334155" : "#e2e8f0"} />
            {value.value != null && <rect x={170 + j * cellWidth} y={78 + i * cellHeight} width={cellWidth - 2} height={cellHeight - 2} fill={ratio < 0 ? "#fb7185" : "#2dd4bf"} fillOpacity={opacity} />}
            <text x={170 + (j + 0.5) * cellWidth} y={96 + i * cellHeight} textAnchor="middle" fill={opacity > 0.55 ? "#111827" : ink}>{short(scalarText(value), Math.max(3, Math.floor(cellWidth / 7)))}</text>
          </>);
        })}
      </g>)}
      <text x="170" y={plotBottom - 4} fontSize="10">{t("analysis.heatmap_scale", { n: short(max, 35) })}<title>{max}</title></text>
    </>;
  } else {
    const horizontal = ["horizontalBar", "horizontalStackedBar", "tornado"].includes(kind);
    const stacked = ["stackedBar", "horizontalStackedBar", "stackedArea", "stackedCombo"].includes(kind);
    const combo = comboChart(kind), barCount = combo ? series.length - 1 : series.length;
    const stack = stackLevels(combo ? series.slice(0, -1) : series);
    const waterfall = kind === "waterfall" ? waterfallLevels(series[0].values) : null;
    const levels: Level[][] = waterfall ? [waterfall] : series.map((s, j) => s.values.map((value, i) => stacked && j < barCount ? stack[j][i] : { start: ZERO, end: value, value }));
    const axisValues = levels.flatMap(s => s.flatMap(v => [v.start, v.end]));
    const domain = numericDomain(axisValues);
    const categories = waterfall ? [...rows, { key: "waterfall-total", label: t("analysis.total"), type: "total", count: 0 }] : rows;
    const top = 60, bottom = horizontal ? top + Math.max(240, categories.length * Math.max(28, (stacked || kind === "tornado" ? 1 : barCount) * 9)) : 310;
    const left = horizontal ? 180 : 75, right = 760, width = right - left;
    plotBottom = bottom + (horizontal ? 50 : 100);
    const zero = horizontal ? left + width * domain.ratio(ZERO) : bottom - (bottom - top) * domain.ratio(ZERO);
    const step = (horizontal ? bottom - top : width) / Math.max(categories.length, 1);
    const padding = continuous ? 32 : 0;
    const categoryPosition = (i: number) => continuous ? left + padding + continuous.ratios[i] * (width - 2 * padding) : (horizontal ? top : left) + step * (i + 0.5);
    const valuePosition = (value: Scalar) => horizontal ? left + domain.ratio(value) * width : bottom - domain.ratio(value) * (bottom - top);
    const barWidthAt = (i: number) => {
      const divisor = stacked || waterfall || kind === "tornado" ? 1 : barCount;
      if (!continuous) return step * 0.75 / divisor;
      const previous = i > 0 ? categoryPosition(i) - categoryPosition(i - 1) : Infinity;
      const next = i + 1 < rows.length ? categoryPosition(i + 1) - categoryPosition(i) : Infinity;
      // Allocate width to the whole group first so dense multi-series groups do not expand over neighbors.
      return Math.max(1, Math.min(48, Math.min(previous, next) * 0.75)) / divisor;
    };
    const max = maxMagnitude(axisValues);
    const isLine = (j: number) => kind === "line" || kind === "area" || kind === "stackedArea" || combo && j === series.length - 1;
    content = <>
      {kind === "tornado" ? <>
        <line x1={(left + right) / 2} x2={(left + right) / 2} y1={top} y2={bottom} stroke="#64748b" />
        <text x={left} y={top - 12} textAnchor="start">{short(max, 30)}<title>{max}</title></text>
        <text x={right} y={top - 12} textAnchor="end">{short(max, 30)}<title>{max}</title></text>
      </> : <>
        <line x1={horizontal ? zero : left} x2={horizontal ? zero : right} y1={horizontal ? top : zero} y2={horizontal ? bottom : zero} stroke="#64748b" />
        <text x={horizontal ? left : left - 10} y={horizontal ? bottom + 20 : bottom + 4} textAnchor={horizontal ? "start" : "end"}><title>{domain.min}</title>{short(domain.min, horizontal ? 35 : 10)}</text>
        <text x={horizontal ? right : left - 10} y={horizontal ? bottom + 20 : top + 4} textAnchor="end"><title>{domain.max}</title>{short(domain.max, horizontal ? 35 : 10)}</text>
        {domain.min !== "0" && domain.max !== "0" && <text x={horizontal ? zero : left - 10} y={horizontal ? bottom + 20 : zero + 4} textAnchor="end">0</text>}
      </>}
      {levels.flatMap((data, j) => data.map((level, i) => {
        if (level.value.value == null || isLine(j)) return null;
        const description = waterfall ? `${label(categories[i])}: ${scalarText(level.value)} · ${t("analysis.balance")}: ${scalarText(level.end)}` : detail(i, j);
        let a = valuePosition(level.start), b = valuePosition(level.end);
        if (kind === "tornado") { a = (left + right) / 2; b = a + (j === 0 ? -1 : 1) * chartRatio(level.value.value, max) * width / 2; }
        const barWidth = barWidthAt(i);
        const offset = stacked || waterfall || kind === "tornado" ? 0 : (j - (barCount - 1) / 2) * barWidth;
        const fill = waterfall ? i === categories.length - 1 ? color(1) : sign(level.value) < 0 ? dark ? "#fb7185" : "#be123c" : color(0) : color(j);
        return group(`${series[j].key}:${categories[i].key}`, description, horizontal ? <rect x={Math.min(a, b)} y={categoryPosition(i) + offset - barWidth / 2} width={Math.abs(a - b)} height={barWidth} fill={fill} />
          : <rect x={categoryPosition(i) + offset - barWidth / 2} y={Math.min(a, b)} width={barWidth} height={Math.abs(a - b)} fill={fill} />);
      }))}
      {levels.map((data, j) => {
        if (!isLine(j)) return null;
        // A negative stack belongs below zero; separate sign runs instead of bridging unrelated baselines.
        const runs: { x: number; high: number; low: number }[][] = [];
        let run: { x: number; high: number; low: number }[] = [], previous = 0;
        data.forEach((level, i) => {
          const current = sign(level.value);
          if (level.value.value == null || stacked && current !== previous) { if (run.length) runs.push(run); run = []; }
          if (level.value.value != null) run.push({ x: categoryPosition(i), high: valuePosition(level.end), low: valuePosition(level.start) });
          previous = current;
        });
        if (run.length) runs.push(run);
        return <g key={series[j].key}>{runs.map((points, index) => kind === "area" || kind === "stackedArea"
          ? <polygon key={index} points={[...points.map(p => `${p.x},${p.high}`), ...points.slice().reverse().map(p => `${p.x},${p.low}`)].join(" ")} fill={color(j)} fillOpacity="0.3" stroke={color(j)} strokeWidth="1.5" />
          : <polyline key={index} points={points.map(p => `${p.x},${p.high}`).join(" ")} fill="none" stroke={color(j)} strokeWidth="2" />)}</g>;
      })}
      {levels.flatMap((data, j) => !isLine(j) ? [] : data.map((level, i) => level.value.value == null ? null
        : group(`${series[j].key}:${categories[i].key}`, detail(i, j), <circle cx={categoryPosition(i)} cy={valuePosition(level.end)} r="3" fill={color(j)} />)))}
      {waterfall && waterfall.slice(0, -1).map((level, i) => <line key={i} x1={categoryPosition(i) + barWidthAt(i) / 2} x2={categoryPosition(i + 1) - barWidthAt(i + 1) / 2} y1={valuePosition(level.end)} y2={valuePosition(level.end)} stroke="#64748b" strokeDasharray="3 3" />)}
      {continuous ? <>
        <line x1={left} x2={right} y1={bottom} y2={bottom} stroke="#64748b" />
        <line x1={categoryPosition(0)} x2={categoryPosition(0)} y1={bottom} y2={bottom + 6} stroke="#64748b" />
        <text x={categoryPosition(0)} y={bottom + 25} textAnchor={rows.length === 1 ? "middle" : "start"}><title>{continuous.minimum}</title>{short(continuous.minimum, 36)}</text>
        {rows.length > 1 && <><line x1={categoryPosition(rows.length - 1)} x2={categoryPosition(rows.length - 1)} y1={bottom} y2={bottom + 6} stroke="#64748b" /><text x={categoryPosition(rows.length - 1)} y={bottom + 25} textAnchor="end"><title>{continuous.maximum}</title>{short(continuous.maximum, 36)}</text></>}
        <text x={(left + right) / 2} y={bottom + 55} textAnchor="middle">{axis?.kind === "time" ? t("analysis.axis_time_label", { bucket: t(`analysis.time_bucket.${axis.time.bucket}`) }) : t("analysis.axis_number_label")}</text>
      </> : categories.map((row, i) => horizontal
        ? <text key={row.key} x={left - 12} y={categoryPosition(i) + 4} textAnchor="end"><title>{label(row)}</title>{short(row.label || t("analysis.empty_value"), 23)}</text>
        : <text key={row.key} transform={`translate(${categoryPosition(i)},${bottom + 20}) rotate(-35)`} textAnchor="end"><title>{label(row)}</title>{short(row.label || t("analysis.empty_value"), 16)}</text>)}
    </>;
  }
  const height = plotBottom + legendHeight;
  return <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 800 ${height}`} width="800" height={height} role="img" data-chart-kind={kind} data-axis-kind={axis?.kind ?? "category"} aria-label={title} className="h-auto w-full min-w-[480px]" fontFamily="system-ui, sans-serif" fontSize="11" fill={ink}>
    <title>{title}</title><rect width="800" height={height} fill={paper} rx="10" />
    <text x="24" y="25" fontSize="14" fontWeight="600">{short(title, 92)}</text>
    {content}
    {legend.map((item, i) => <g key={item.key} transform={`translate(${24 + i % 3 * 258},${plotBottom + 18 + Math.floor(i / 3) * 22})`}><title>{item.label}</title><rect width="10" height="10" y="-8" rx="2" fill={item.color} /><text x="16" y="0">{short(item.label, 34)}</text></g>)}
  </svg>;
});
ResultChart.displayName = "ResultChart";
