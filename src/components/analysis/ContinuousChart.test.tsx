import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyze, type AxisOptions, type Pivot } from "@/lib/resultAnalysis";
import { DEFAULT_TIME_OPTIONS } from "@/lib/resultTime";
import { DEFAULT_METRIC_OPTIONS, type ChartKind } from "@/lib/resultCharts";
import { useI18n } from "@/store/i18n";
import { ResultChart } from "./ResultChart";
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ theme: "light" }) }));
const axis: AxisOptions = { kind: "time", time: DEFAULT_TIME_OPTIONS };
const pivot = (source: unknown[][]) => analyze({ kind: "pivot", rows: source, aggregate: "mean", split: true, parseStrings: true, axis }) as Pivot;
const data = pivot([["2026-11-11", "a", 30], ["2026-11-01", "a", 2], ["2026-11-02", "a", 4], ["2026-11-01", "b", 5], ["2026-11-02", "b", 6], ["2026-11-11", "b", 7]]);
const chart = (kind: ChartKind, source = data) => <ResultChart kind={kind} rows={source.rows} series={source.columns.map((c, i) => ({ key: c.key, label: c.label, values: source.cells.map(row => row[i]) }))} title="Continuous" axis={axis} />;
beforeEach(() => useI18n.setState({ lang: "en" }));
describe("continuous chart rendering", () => {
  it.each(["bar", "stackedBar", "line", "area", "stackedArea", "combo", "stackedCombo", "trend"] as const)("renders %s with real interval spacing and portable UTC labels", kind => {
    render(chart(kind));
    const svg = screen.getByRole("img", { name: "Continuous" });
    expect(svg).toHaveAttribute("data-axis-kind", "time");
    expect(svg.textContent).toContain("Time (UTC)");
    const nodes = kind === "bar" || kind === "stackedBar" ? [...svg.querySelectorAll('g[role="img"] rect')].slice(0, 3) : [...svg.querySelectorAll("circle")].slice(0, 3);
    const positions = nodes.map((node, i) => {
      if (node.tagName !== "rect") return Number(node.getAttribute("cx"));
      const center = Number(node.getAttribute("x")) + Number(node.getAttribute("width")) / 2;
      if (kind !== "bar") return center;
      const paired = svg.querySelectorAll('g[role="img"] rect')[3 + i];
      return (center + Number(paired.getAttribute("x")) + Number(paired.getAttribute("width")) / 2) / 2;
    });
    expect(positions).toHaveLength(3);
    expect((positions[1] - positions[0]) / (positions[2] - positions[0])).toBeCloseTo(0.1, 5);
    expect(svg.innerHTML).not.toMatch(/NaN|Infinity|undefined/);
    expect(svg.innerHTML).toContain("2026-11-11T00:00:00Z");
  });
  it("uses the sorted latest time for trend comparison, not the original final row", () => {
    render(<ResultChart kind="trend" rows={data.rows} series={[{ key: "a", label: "A", values: data.cells.map(row => row[0]) }]} title="Trend" axis={axis} options={{ ...DEFAULT_METRIC_OPTIONS, comparison: "first" }} />);
    expect(screen.getByRole("img", { name: "A · 2026-11-11T00:00:00Z: 30" })).toBeInTheDocument();
    expect(screen.getByText("Difference: 28 · 1400%")).toBeInTheDocument();
  });
  it("keeps bars visible when one pair is very close relative to the full time range", () => {
    render(chart("bar", pivot([["0001-01-01", "a", 1], ["0001-01-02", "a", 1], ["9999-12-31T23:59:59Z", "a", 1]])));
    const svg = screen.getByRole("img", { name: "Continuous" });
    const bars = [...svg.querySelectorAll('g[role="img"] rect')];
    expect(bars).toHaveLength(3);
    expect(bars.every(bar => Number(bar.getAttribute("width")) >= 1)).toBe(true);
    expect(Number(bars[1].getAttribute("x"))).toBeGreaterThan(Number(bars[0].getAttribute("x")));
  });
  it("keeps 200 dense groups of 12 bars within their own coordinate intervals", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ key: String(i), label: String(i), type: "number", coordinate: String(i), count: 1 }));
    const series = Array.from({ length: 12 }, (_, i) => ({ key: String(i), label: String(i), values: rows.map(() => ({ value: "1", rounded: false })) }));
    render(<ResultChart kind="bar" rows={rows} series={series} title="Dense" axis={{ kind: "number" }} />);
    const bars = [...screen.getByRole("img", { name: "Dense" }).querySelectorAll('g[role="img"] rect')];
    expect(bars).toHaveLength(2400);
    for (let i = 0; i < 199; i++) {
      const last = bars[11 * 200 + i], next = bars[i + 1];
      expect(Number(last.getAttribute("x")) + Number(last.getAttribute("width"))).toBeLessThan(Number(next.getAttribute("x")));
    }
  });
  it("breaks lines at existing NULL groups and keeps single-coordinate labels finite", () => {
    const source = pivot([["2026-11-01", "a", 1], ["2026-11-02", "a", null], ["2026-11-11", "a", 3]]);
    const ui = render(chart("line", source));
    expect(screen.getByRole("img", { name: "Continuous" }).querySelectorAll("polyline")).toHaveLength(2);
    ui.rerender(chart("bar", pivot([["2026-11-01", "a", 1]])));
    const svg = screen.getByRole("img", { name: "Continuous" });
    expect(svg.innerHTML).not.toMatch(/NaN|Infinity|undefined/);
    expect(svg.querySelectorAll('text[text-anchor="middle"]')).not.toHaveLength(0);
  });
});
