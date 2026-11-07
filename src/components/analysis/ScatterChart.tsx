import { forwardRef } from "react";
import type { Scatter } from "@/lib/resultAnalysis";
import { shortChartLabel as short, numericDomain, scalarText } from "@/lib/resultCharts";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useT } from "@/store/i18n";
export const ScatterChart = forwardRef<SVGSVGElement, { data: Scatter; title: string; xLabel: string; yLabel: string }>(({ data, title, xLabel, yLabel }, ref) => {
  const t = useT(); const { theme } = useTheme(); const dark = theme === "dark";
  if (!data.points.length) return <p role="status" className="p-6 text-sm text-muted-foreground">{t("analysis.no_data")}</p>;
  const x = numericDomain([data.xMin, data.xMax], false), y = numericDomain([data.yMin, data.yMax], false);
  const ink = dark ? "#cbd5e1" : "#334155", muted = dark ? "#94a3b8" : "#64748b";
  return <svg ref={ref} xmlns="http://www.w3.org/2000/svg" width="800" height="470" viewBox="0 0 800 470" role="img" data-chart-kind="scatter" aria-label={title} className="h-auto w-full min-w-[480px]" fontFamily="system-ui, sans-serif" fontSize="11" fill={ink}>
    <title>{title}</title><rect width="800" height="470" rx="10" fill={dark ? "#111827" : "#f8fafc"} />
    <text x="24" y="27" fontSize="14" fontWeight="600"><title>{title}</title>{short(title, 70)}</text>
    <text x="80" y="53"><title>{yLabel}</title>{short(yLabel, 42)}</text>
    <line x1="80" x2="760" y1="380" y2="380" stroke={muted} /><line x1="80" x2="80" y1="70" y2="380" stroke={muted} />
    <text x="70" y="79" textAnchor="end"><title>{y.max}</title>{short(y.max, 10)}</text><text x="70" y="380" textAnchor="end"><title>{y.min}</title>{short(y.min, 10)}</text>
    <text x="80" y="402"><title>{x.min}</title>{short(x.min, 28)}</text><text x="760" y="402" textAnchor="end"><title>{x.max}</title>{short(x.max, 28)}</text>
    <text x="420" y="425" textAnchor="middle"><title>{xLabel}</title>{short(xLabel, 50)}</text>
    {data.points.map(point => {
      const description = `${point.label ?? t("analysis.point_row", { n: point.index + 1 })} · ${xLabel}: ${scalarText(point.x)} · ${yLabel}: ${scalarText(point.y)}`;
      return <circle key={point.index} cx={80 + 680 * x.coordinateRatio(point.x)} cy={380 - 310 * y.coordinateRatio(point.y)} r="3.5" fill={dark ? "#2dd4bf" : "#0f766e"} fillOpacity="0.65" tabIndex={0} role="img" aria-label={description}><title>{description}</title></circle>;
    })}
    <text x="24" y="451" fill={muted}>{t(data.sampled ? "analysis.sampled_plot" : "analysis.complete_plot", { plotted: data.points.length, valid: data.numeric })}</text>
  </svg>;
});
ScatterChart.displayName = "ScatterChart";
