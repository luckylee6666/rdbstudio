import { forwardRef } from "react";
import { type AxisOptions, type Bucket, type Scalar } from "@/lib/resultAnalysis";
import { axisLayout, shortChartLabel as clipped, gaugePosition, minus, numericDomain, percentChange, scalarText, sign, type ChartSeries, type MetricKind, type MetricOptions } from "@/lib/resultCharts";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useT } from "@/store/i18n";
const absent: Scalar = { value: null, rounded: false };
interface Props { axis?: AxisOptions; kind: MetricKind; title: string; rows: Bucket[]; series: ChartSeries[]; options: MetricOptions }

/** Summaries are supplied by the source-row aggregation, never by adding grouped means. */
export const MetricChart = forwardRef<SVGSVGElement, Props>(({ kind, title, rows, series, options, axis }, ref) => {
  const t = useT(); const { theme } = useTheme(); const dark = theme === "dark";
  const ink = dark ? "#e2e8f0" : "#0f172a", muted = dark ? "#94a3b8" : "#64748b";
  const accent = dark ? "#2dd4bf" : "#0f766e", danger = dark ? "#fb7185" : "#be123c";
  const columns = series.length > 1 ? 2 : 1, width = (752 - (columns - 1) * 16) / columns;
  const continuous = axisLayout(rows, axis);
  const cardHeight = kind === "trend" && continuous ? 360 : kind === "trend" || kind === "gauge" ? 300 : 250;
  const height = 64 + Math.ceil(series.length / columns) * (cardHeight + 16);
  const number = (value: Scalar, x: number, y: number) => {
    const label = clipped(scalarText(value), columns === 1 ? 35 : 19);
    const size = Math.min(34, (width - 40) / (label.length * 0.68));
    return <text x={x} y={y} textAnchor="middle" fontSize={size} fontWeight="600"><title>{scalarText(value)}</title>{label}</text>;
  };
  return <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="800" height={height} viewBox={`0 0 800 ${height}`} className="h-auto w-full min-w-[480px]" role="img" data-chart-kind={kind} data-axis-kind={axis?.kind ?? "category"} aria-label={title} fontFamily="system-ui, sans-serif" fontSize="12" fill={ink}>
    <title>{title}</title><rect width="800" height={height} rx="10" fill={dark ? "#111827" : "#f8fafc"} />
    <text x="24" y="30" fontSize="15" fontWeight="600"><title>{title}</title>{clipped(title, 72)}</text>
    {series.map((s, index) => {
      const x = 24 + (index % columns) * (width + 16), y = 54 + Math.floor(index / columns) * (cardHeight + 16);
      const lastIndex = s.values.length - 1;
      const referenceIndex = options.comparison === "first" ? 0 : lastIndex - 1;
      const value = kind === "trend" ? s.values[lastIndex] ?? absent : s.summary ?? absent;
      const reference = kind === "kpi" ? { value: options.target, rounded: false } : referenceIndex >= 0 && referenceIndex <= lastIndex ? s.values[referenceIndex] : absent;
      const delta = minus(value, reference), percent = percentChange(value, reference);
      const status = delta.value == null ? "unknown" : sign(delta) * (options.direction === "lower" ? -1 : 1) >= 0 ? "met" : "unmet";
      const position = kind === "gauge" ? gaugePosition(value, options.minimum, options.maximum) : null;
      const center = width / 2;
      const heading = kind === "trend" ? `${s.label} · ${rows[lastIndex]?.label ?? t("analysis.no_data")}` : s.label;
      return <g key={s.key} transform={`translate(${x},${y})`} tabIndex={0} role="img" aria-label={`${heading}: ${scalarText(value)}`}>
        <title>{heading}: {scalarText(value)}</title>
        <rect width={width} height={cardHeight} rx="12" fill={dark ? "#1e293b" : "#ffffff"} stroke={dark ? "#334155" : "#e2e8f0"} />
        <text x="18" y="29" fill={muted}><title>{heading}</title>{clipped(heading, columns === 1 ? 68 : 29)}</text>
        {number(value, center, kind === "gauge" ? 245 : 90)}
        {kind === "value" && <><text x={center} y="130" textAnchor="middle" fill={muted}>{t("analysis.source_total")}</text><text x={center} y="165" textAnchor="middle" fill={muted}>{t("analysis.value_hint")}</text></>}
        {kind === "kpi" && <>
          <text x={center} y="128" textAnchor="middle" fill={muted}><title>{options.target}</title>{t("analysis.target")}: {clipped(options.target, 28)}</text>
          <text x={center} y="158" textAnchor="middle" fill={status === "met" ? accent : status === "unmet" ? danger : muted}>{t(`analysis.target_${status}`)}{value.rounded ? ` · ${t("analysis.approximate")}` : ""}</text>
          <text x={center} y="189" textAnchor="middle"><title>{scalarText(delta)}</title>{t("analysis.delta")}: {clipped(scalarText(delta), 24)}</text>
          <text x={center} y="217" textAnchor="middle" fill={muted}><title>{scalarText(percent)}</title>{percent.value == null ? t("analysis.percent_unavailable") : `${clipped(scalarText(percent), 22)}%`}</text>
        </>}
        {kind === "gauge" && position && (() => {
          const radius = Math.min(center - 40, 130), cy = 188;
          const px = position.ratio == null ? center : center - Math.cos(position.ratio * Math.PI) * radius;
          const py = position.ratio == null ? cy : cy - Math.sin(position.ratio * Math.PI) * radius;
          return <>
            <path d={`M ${center - radius},${cy} A ${radius},${radius} 0 0 1 ${center + radius},${cy}`} fill="none" stroke={dark ? "#475569" : "#e2e8f0"} strokeWidth="15" strokeLinecap="round" />
            {position.ratio != null && <><line x1={center} y1={cy} x2={px} y2={py} stroke={position.outside ? danger : accent} strokeWidth="4" /><circle cx={center} cy={cy} r="5" fill={accent} /></>}
            <text x="18" y="215" fill={muted}><title>{options.minimum}</title>{clipped(options.minimum, 14)}</text><text x={width - 18} y="215" textAnchor="end" fill={muted}><title>{options.maximum}</title>{clipped(options.maximum, 14)}</text>
            <text x={center} y="273" textAnchor="middle" fill={position.outside ? danger : muted}>{t(position.outside < 0 ? "analysis.below_range" : position.outside > 0 ? "analysis.above_range" : "analysis.source_total")}</text>
          </>;
        })()}
        {kind === "trend" && (() => {
          const domain = numericDomain(s.values, false), left = 24, right = width - 24, top = 168, bottom = 247;
          const pointX = (i: number) => left + (right - left) * (continuous ? continuous.ratios[i] : s.values.length === 1 ? 0.5 : i / Math.max(s.values.length - 1, 1));
          const pointY = (v: Scalar) => bottom - domain.ratio(v) * (bottom - top);
          const segments: string[][] = []; let segment: string[] = [];
          for (let i = 0; i < s.values.length; i++) {
            if (s.values[i].value == null) { if (segment.length) segments.push(segment); segment = []; }
            else segment.push(`${pointX(i)},${pointY(s.values[i])}`);
          }
          if (segment.length) segments.push(segment);
          return <>
            <text x={center} y="119" textAnchor="middle" fill={muted}><title>{referenceIndex >= 0 ? rows[referenceIndex]?.label : ""}</title>{t(options.comparison === "first" ? "analysis.vs_first" : "analysis.vs_previous")}</text>
            <text x={center} y="143" textAnchor="middle"><title>{scalarText(delta)} · {scalarText(percent)}%</title>{t("analysis.delta")}: {clipped(scalarText(delta), 20)} · {percent.value == null ? "—" : clipped(scalarText(percent), 16) + "%"}</text>
            {segments.map((points, i) => <polyline key={i} points={points.join(" ")} fill="none" stroke={accent} strokeWidth="2" />)}
            {s.values.map((v, i) => v.value == null ? null : <circle key={i} cx={pointX(i)} cy={pointY(v)} r="2.5" fill={accent}><title>{rows[i]?.label}: {scalarText(v)}</title></circle>)}
            <text x={left} y="272" fill={muted}><title>{domain.min}</title>{clipped(domain.min, 17)}</text><text x={right} y="272" textAnchor="end" fill={muted}><title>{domain.max}</title>{clipped(domain.max, 17)}</text>
            <text x={center} y="290" textAnchor="middle" fill={muted} fontSize="10">{t("analysis.local_scale")}</text>
            {continuous && <>
              <text x={center} y="313" textAnchor="middle" fill={muted} fontSize="10">{axis?.kind === "time" ? t("analysis.axis_time_label", { bucket: t(`analysis.time_bucket.${axis.time.bucket}`) }) : t("analysis.axis_number_label")}</text>
              <text x={left} y="337" fill={muted} fontSize="10"><title>{continuous.minimum}</title>{clipped(continuous.minimum, columns === 1 ? 36 : 22)}</text>
              <text x={right} y="337" textAnchor="end" fill={muted} fontSize="10"><title>{continuous.maximum}</title>{clipped(continuous.maximum, columns === 1 ? 36 : 22)}</text>
            </>}
          </>;
        })()}
      </g>;
    })}
  </svg>;
});
MetricChart.displayName = "MetricChart";
