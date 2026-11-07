import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultChart } from "./ResultChart";
import { ScatterChart } from "./ScatterChart";
import { analyze, type Scatter } from "@/lib/resultAnalysis";
import { DEFAULT_METRIC_OPTIONS, type ChartSeries } from "@/lib/resultCharts";
import { useI18n } from "@/store/i18n";
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));
const rows = ["First", "Second", "Last"].map(label => ({ key: label, label, type: "string", count: 1 }));
const series = (values: (string | null)[], summary: string | null = "12"): ChartSeries[] => [{ key: "s", label: "Source", values: values.map(value => ({ value, rounded: false })), summary: { value: summary, rounded: false } }];
beforeEach(() => useI18n.setState({ lang: "en" }));
describe("metric and scatter rendering", () => {
  it.each(["value", "trend", "kpi", "gauge"] as const)("renders %s as a standalone SVG with finite geometry", kind => {
    render(<ResultChart kind={kind} rows={rows} series={series(["3", "30", "9"])} title="Metrics" options={{ ...DEFAULT_METRIC_OPTIONS, target: "10" }} />);
    const svg = screen.getByRole("img", { name: "Metrics" });
    expect(svg).toHaveAttribute("width", "800");
    expect(svg.getAttribute("viewBox")).toBe(`0 0 800 ${svg.getAttribute("height")}`);
    for (const element of svg.querySelectorAll("*")) for (const attr of element.getAttributeNames()) if (["cx", "cy", "x", "y", "x1", "y1", "x2", "y2", "points", "d"].includes(attr)) expect(element.getAttribute(attr)).not.toMatch(/NaN|Infinity|undefined/);
    expect(screen.getByRole("img", { name: kind === "trend" ? "Source · Last: 9" : "Source: 12" })).toBeInTheDocument();
  });
  it("uses the source summary rather than the sum or mean of displayed groups", () => {
    render(<ResultChart kind="value" rows={rows.slice(0, 2)} series={series(["3", "30"])} title="Mean" />);
    expect(screen.getByRole("img", { name: "Source: 12" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Source: 33" })).toBeNull();
  });
  it("keeps a trailing NULL and breaks the sparkline at missing values", () => {
    const ui = render(<ResultChart kind="trend" rows={rows} series={series(["10", "20", null])} title="Trend" />);
    expect(screen.getByRole("img", { name: "Source · Last: NULL" })).toBeInTheDocument();
    expect(screen.getByText(/Difference: NULL/)).toBeInTheDocument();
    ui.rerender(<ResultChart kind="trend" rows={rows} series={series(["10", null, "20"])} title="Trend" />);
    expect(screen.getByText(/Difference: NULL/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Trend" }).querySelectorAll("polyline")).toHaveLength(2);
    ui.rerender(<ResultChart kind="trend" rows={rows} series={series(["10", null, "20"])} title="Trend" options={{ ...DEFAULT_METRIC_OPTIONS, comparison: "first" }} />);
    expect(screen.getByText("Difference: 10 · 100%")).toBeInTheDocument();
  });
  it("compares the only category to itself in first mode, with zero-reference rules", () => {
    const ui = render(<ResultChart kind="trend" rows={rows.slice(0, 1)} series={series(["5"])} title="Single" options={{ ...DEFAULT_METRIC_OPTIONS, comparison: "first" }} />);
    expect(screen.getByText("Difference: 0 · 0%")).toBeInTheDocument();
    ui.rerender(<ResultChart kind="trend" rows={rows.slice(0, 1)} series={series(["0"])} title="Single" options={{ ...DEFAULT_METRIC_OPTIONS, comparison: "first" }} />);
    expect(screen.getByText("Difference: 0 · —")).toBeInTheDocument();
    ui.rerender(<ResultChart kind="trend" rows={rows.slice(0, 1)} series={series(["5"])} title="Single" />);
    expect(screen.getByText("Difference: NULL · —")).toBeInTheDocument();
  });
  it("honors lower-is-better targets and marks an out-of-range gauge", () => {
    const ui = render(<ResultChart kind="kpi" rows={rows} series={series(["1", "2", "3"], "5")} title="KPI" options={{ ...DEFAULT_METRIC_OPTIONS, target: "10", direction: "lower" }} />);
    expect(screen.getByText("Target met")).toBeInTheDocument();
    ui.rerender(<ResultChart kind="gauge" rows={rows} series={series(["1", "2", "3"], "101")} title="Gauge" />);
    expect(screen.getByText("Above configured range")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Source: 101" })).toBeInTheDocument();
  });
  it("plots adjacent i64 coordinates at distinct positions with exact accessible values", () => {
    const data = analyze({ kind: "scatter", parseStrings: true, sample: true, labels: true, rows: [["9223372036854775806", "1", "<script>x</script>"], ["9223372036854775807", "1", "b"]] }) as Scatter;
    render(<ScatterChart data={data} title="Scatter" xLabel="X" yLabel="Y" />);
    const svg = screen.getByRole("img", { name: "Scatter" });
    expect([...svg.querySelectorAll("circle")].map(c => [c.getAttribute("cx"), c.getAttribute("cy")])).toEqual([["80", "225"], ["760", "225"]]);
    expect(screen.getByRole("img", { name: /9223372036854775807/ })).toBeInTheDocument();
    expect(svg.querySelector("script")).toBeNull();
    expect(svg).toHaveAttribute("width", "800");
  });
});
