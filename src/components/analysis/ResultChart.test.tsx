import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultChart } from "./ResultChart";
import { CHART_KINDS, metricChart, type ChartSeries } from "@/lib/resultCharts";
import { useI18n } from "@/store/i18n";
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));
const rows = ["A", "B", "中文长分类名称中文长分类名称"].map(label => ({ key: label, label, type: "string", count: 1 }));
const makeSeries = (values: (string | null)[][]): ChartSeries[] => values.map((vs, i) => ({ key: String(i), label: `Series ${i}`, values: vs.map(value => ({ value, rounded: false })) }));
beforeEach(() => useI18n.setState({ lang: "en" }));
describe("result chart rendering", () => {
  it.each(CHART_KINDS.filter(kind => kind !== "scatter" && !metricChart(kind)))("renders %s with bounded finite geometry and portable dimensions", kind => {
    const multiple = ["combo", "stackedCombo", "tornado"].includes(kind);
    render(<ResultChart rows={rows} series={makeSeries(multiple ? [["1", "2", "3"], ["4", "5", "6"]] : [["1", "2", "3"]])} kind={kind} title="Sample" />);
    const chart = screen.getByRole("img", { name: "Sample" });
    expect(chart).toHaveAttribute("width", "800"); expect(chart.getAttribute("viewBox")).toBe(`0 0 800 ${chart.getAttribute("height")}`);
    for (const element of chart.querySelectorAll("rect,circle,line,path,polygon,polyline")) {
      for (const attr of element.getAttributeNames()) if (["x", "y", "cx", "cy", "r", "width", "height", "x1", "x2", "y1", "y2", "d", "points"].includes(attr)) expect(element.getAttribute(attr)).not.toMatch(/NaN|Infinity|undefined/);
    }
    if (kind !== "waterfall") expect(chart.textContent).toContain("Series 0");
  });
  it("shows exact waterfall balances, escapes data as text and adds a distinct total", () => {
    render(<ResultChart rows={[{ ...rows[0], label: "<script>alert(1)</script>" }, rows[1]]} series={makeSeries([["9223372036854775807", "0.1"]])} kind="waterfall" title="Running" />);
    expect(screen.getAllByRole("img", { name: /Running balance: 9223372036854775807.1/ })).toHaveLength(2);
    expect(document.querySelector("script")).toBeNull();
    const svg = screen.getByRole("img", { name: "Running" }); expect(svg.textContent).toContain("Total [total]");
  });
  it("draws combinations with a line and maintains NULL gaps", () => {
    const ui = render(<ResultChart rows={rows} series={makeSeries([["1", "2", "3"], ["4", null, "6"]])} kind="stackedCombo" title="Combination" />);
    let svg = screen.getByRole("img", { name: "Combination" });
    expect(svg.querySelectorAll("polyline")).toHaveLength(2);
    const bars = svg.querySelectorAll('g[role="img"] rect');
    expect(bars).toHaveLength(3);
    expect(bars[2].compareDocumentPosition(svg.querySelector("polyline")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(svg.textContent).toContain("Series 1 · Line");
    ui.rerender(<ResultChart rows={rows} series={makeSeries([["-1", "0", "1"], ["-2", "0", "3"]])} kind="stackedArea" title="Areas" />);
    svg = screen.getByRole("img", { name: "Areas" });
    expect(svg.querySelectorAll("polygon")).toHaveLength(6);
  });
  it("shows NULL and zero separately in heatmaps and mirrors nonnegative tornado values", () => {
    const ui = render(<ResultChart rows={rows} series={makeSeries([["-1", "0", null]])} kind="heatmap" title="Heat" />);
    expect(screen.getByRole("img", { name: /A \[string\].*: -1/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /B \[string\].*: 0/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /NULL$/ })).toBeInTheDocument();
    ui.rerender(<ResultChart rows={[rows[0]]} series={makeSeries([["5"], ["5"]])} kind="tornado" title="Tornado" />);
    const groups = screen.getAllByRole("img").slice(1);
    const first = groups[0].querySelector("rect")!, second = groups[1].querySelector("rect")!;
    expect(Number(first.getAttribute("x")) + Number(first.getAttribute("width"))).toBe(Number(second.getAttribute("x")));
    expect(first.getAttribute("width")).toBe(second.getAttribute("width"));
  });
  it("reports unsuitable values instead of drawing an empty or misleading chart", () => {
    render(<ResultChart rows={rows} series={makeSeries([["-1", "2", "3"]])} kind="donut" title="Rejected" />);
    expect(screen.getByRole("status")).toHaveTextContent("nonnegative");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
