import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResultChart } from "./ResultChart";
import { ResultAnalysis } from "./ResultAnalysis";
import { ResultAnalysisButton } from "./ResultAnalysisButton";
import { analyze, type AnalysisRequest } from "@/lib/resultAnalysis";
import { useI18n } from "@/store/i18n";
import { saveTextFile } from "@/lib/csv";
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/lib/csv", async original => ({ ...await original<object>(), saveTextFile: vi.fn().mockResolvedValue(null) }));
class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request!: AnalysisRequest;
  terminated = false;
  constructor() { TestWorker.instances.push(this); }
  postMessage(request: AnalysisRequest) { this.request = request; }
  terminate() { this.terminated = true; }
  finish() { this.onmessage?.({ data: { result: analyze(this.request) } }); }
}
const snapshot = {
  label: "SELECT snapshot", scope: "result" as const,
  columns: [{ name: "group", data_type: "TEXT" }, { name: "amount", data_type: "NUMERIC" }, { name: "group", data_type: "TEXT" }],
  rows: [["A", "9223372036854775807", "x"], ["A", "0.1", "x"], ["B", null, "y"]],
};
const finish = () => act(() => TestWorker.instances.at(-1)!.finish());
beforeEach(() => { TestWorker.instances = []; vi.stubGlobal("Worker", TestWorker); useI18n.setState({ lang: "en" }); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
describe("ResultAnalysis", () => {
  it("analyses only selected columns, clears old results immediately and cancels stale work", async () => {
    const ui = render(<ResultAnalysis snapshot={snapshot} onClose={vi.fn()} />);
    const old = TestWorker.instances[0];
    expect(old.request.rows).toEqual([["A"], ["A"], ["B"]]);
    fireEvent.change(screen.getByLabelText("Profile column"), { target: { value: "1" } });
    expect(old.terminated).toBe(true);
    act(() => old.finish());
    expect(screen.getByText("Analyzing snapshot…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export analysis JSON" })).toBeDisabled();
    finish();
    expect(screen.getByText("9223372036854775807.1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Profile column"), { target: { value: "2" } });
    expect(screen.queryByText("9223372036854775807.1")).toBeNull();
    const current = TestWorker.instances.at(-1)!; ui.unmount(); expect(current.terminated).toBe(true);
  });
  it("captures the opening snapshot and does not swap it when parent rows change", async () => {
    const ui = render(<ResultAnalysisButton {...snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze data" }));
    ui.rerender(<ResultAnalysisButton {...snapshot} rows={[["changed", 1]]} />);
    await waitFor(() => expect(TestWorker.instances).toHaveLength(1));
    finish(); expect(screen.getByText("A [string]")).toBeInTheDocument(); expect(screen.queryByText("changed [string]")).toBeNull();
    expect(screen.getByText(/snapshot · 3 rows/)).toBeInTheDocument();
  });
  it("uses index-based dimensions for duplicate names and preserves exact export values", async () => {
    render(<ResultAnalysis snapshot={snapshot} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pivot table" }));
    fireEvent.change(screen.getByLabelText("Column dimension"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Aggregation"), { target: { value: "sum" } });
    finish();
    expect(TestWorker.instances.at(-1)!.request.rows).toEqual(snapshot.rows.map(r => [r[0], r[2], r[1]]));
    fireEvent.click(screen.getByRole("button", { name: "Export analysis JSON" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(vi.mocked(saveTextFile).mock.calls[0][1]);
    expect(payload.scope).toBe("result"); expect(payload.result.total.value).toBe("9223372036854775807.1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export pivot CSV" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Export pivot CSV" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveTextFile).mock.calls[1][1]).toContain("9223372036854775807.1");
  });
  it("reuses pivot calculations when switching charts and exposes full exact values in SVG", async () => {
    render(<ResultAnalysis snapshot={snapshot} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Aggregation"), { target: { value: "sum" } }); finish();
    const count = TestWorker.instances.length;
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "line" } });
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "area" } });
    expect(TestWorker.instances.length).toBe(count);
    const chart = screen.getAllByRole("img")[0]; expect(chart.innerHTML).toContain("9223372036854775807.1");
    fireEvent.click(screen.getByRole("button", { name: "Export chart SVG" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalled());
    expect(vi.mocked(saveTextFile).mock.calls[0][1]).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
  it("selects multiple series without recomputing data and exports only the visible chart series", async () => {
    render(<ResultAnalysis snapshot={snapshot} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Column dimension"), { target: { value: "2" } }); finish();
    const jobs = TestWorker.instances.length;
    fireEvent.change(screen.getByLabelText("Chart series"), { target: { value: "-2" } });
    expect(screen.getByRole("checkbox", { name: "x [string]" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "y [string]" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "x [string]" }));
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "heatmap" } });
    expect(TestWorker.instances.length).toBe(jobs);
    fireEvent.click(screen.getByRole("button", { name: "Export chart SVG" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalled());
    const svg = vi.mocked(saveTextFile).mock.calls[0][1];
    expect(svg).toContain('data-chart-kind="heatmap"'); expect(svg).toContain('width="800"');
    expect(svg).toContain("y [string]"); expect(svg).not.toContain("x [string]");
  });
  it("blocks empty or excessive selections and allows reducing the series explicitly", () => {
    const many = { ...snapshot, rows: Array.from({ length: 13 }, (_, i) => ["A", 1, `s${i}`]) };
    render(<ResultAnalysis snapshot={many} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Column dimension"), { target: { value: "2" } }); finish();
    fireEvent.change(screen.getByLabelText("Chart series"), { target: { value: "-2" } });
    expect(screen.getByRole("status")).toHaveTextContent("at most 12");
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("status")).toHaveTextContent("at least one");
    fireEvent.click(screen.getByRole("checkbox", { name: "s0 [string]" }));
    expect(screen.getByRole("button", { name: "Export chart SVG" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
  });
  it("prevents unsupported chart exports without dropping selected series", () => {
    render(<ResultAnalysis snapshot={snapshot} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Column dimension"), { target: { value: "2" } }); finish();
    fireEvent.change(screen.getByLabelText("Chart series"), { target: { value: "-2" } });
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "pie" } });
    expect(screen.getByRole("status")).toHaveTextContent("requires one series");
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "x [string]" })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "stackedCombo" } });
    expect(screen.getByRole("button", { name: "Export chart SVG" })).toBeEnabled();
  });
  it("reports worker failure, permits retry and prevents export of stale output", () => {
    render(<ResultAnalysis snapshot={snapshot} onClose={vi.fn()} />);
    act(() => TestWorker.instances.at(-1)!.onerror!());
    expect(screen.getByRole("alert")).toHaveTextContent("background analysis worker");
    fireEvent.click(screen.getByRole("button", { name: "Retry analysis" })); finish();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("does not clone more than the allowed row count and labels table pages explicitly", () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, scope: "page", rows: Array(50_001).fill([1]) }} onClose={vi.fn()} />);
    expect(TestWorker.instances).toHaveLength(0); expect(screen.getByRole("alert")).toHaveTextContent("50,000");
    expect(screen.getByText(/Other pages and unsaved changes are not included/)).toBeInTheDocument();
  });
  it("rejects a repeated oversized payload before creating or posting to a worker", () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, rows: Array(40).fill(["x".repeat(1024 * 1024)]) }} onClose={vi.fn()} />);
    expect(TestWorker.instances).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("32 MiB");
  });
  it("does not start a worker if closed during chunked preflight", async () => {
    const ui = render(<ResultAnalysis snapshot={{ ...snapshot, rows: Array(2000).fill([1]) }} onClose={vi.fn()} />);
    ui.unmount();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(TestWorker.instances).toHaveLength(0);
  });
  it("escapes formula-like pivot labels in CSV, while JSON retains original values", async () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, columns: [{ name: "=header", data_type: "TEXT" }], rows: [["=1+1"]] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pivot table" })); finish();
    fireEvent.click(screen.getByRole("button", { name: "Export pivot CSV" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalled());
    expect(vi.mocked(saveTextFile).mock.calls[0][1]).toContain("'=header");
    expect(vi.mocked(saveTextFile).mock.calls[0][1]).toContain("'=1+1 [string]");
  });
  it("projects raw scatter pairs, cancels stale pivot work and exports exact coordinates", async () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, rows: [["=label", "9223372036854775806", "1"], ["b", "9223372036854775807", "2"]] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const pivotWorker = TestWorker.instances.at(-1)!;
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "scatter" } });
    fireEvent.change(screen.getByLabelText("Y column"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Point label"), { target: { value: "0" } });
    expect(pivotWorker.terminated).toBe(true);
    act(() => pivotWorker.finish());
    expect(screen.getByRole("button", { name: "Export analysis JSON" })).toBeDisabled();
    expect(TestWorker.instances.at(-1)!.request).toMatchObject({ kind: "scatter", sample: true, labels: true, rows: [["9223372036854775806", "1", "=label"], ["9223372036854775807", "2", "b"]] });
    finish();
    fireEvent.click(screen.getByRole("button", { name: "Export plotted points CSV" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveTextFile).mock.calls[0][1]).toContain("'=label");
    expect(vi.mocked(saveTextFile).mock.calls[0][1]).toContain("9223372036854775807");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export analysis JSON" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Export analysis JSON" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(2));
    expect(JSON.parse(vi.mocked(saveTextFile).mock.calls[1][1])).toMatchObject({ configuration: { scatterX: 1, scatterY: 2, scatterLabel: 0, sample: true }, result: { kind: "scatter", sampled: false, numeric: 2 } });
  });
  it("collapses card rows, preserves weighted means and gates target/range exports without recomputing", () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, rows: [["A", 2, "x"], ["A", 4, "x"], ["B", 30, "y"]] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Aggregation"), { target: { value: "mean" } });
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "value" } });
    expect(TestWorker.instances.at(-1)!.request.rows).toEqual([[null, null, 2], [null, null, 4], [null, null, 30]]);
    expect(screen.queryByLabelText("Row dimension")).toBeNull(); finish();
    expect(screen.getByRole("img", { name: "Total: 12" })).toBeInTheDocument();
    const workers = TestWorker.instances.length;
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "kpi" } });
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Target", { exact: true }), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Export chart SVG" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "gauge" } });
    fireEvent.change(screen.getByLabelText("Gauge maximum"), { target: { value: "0" } });
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Gauge maximum"), { target: { value: "10" } });
    expect(screen.getByText("Above configured range")).toBeInTheDocument();
    expect(TestWorker.instances).toHaveLength(workers);
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "trend" } });
    expect(TestWorker.instances.at(-1)!.request.rows).toEqual([["A", null, 2], ["A", null, 4], ["B", null, 30]]);
    expect(screen.getByRole("button", { name: "Export analysis JSON" })).toBeDisabled(); finish();
    expect(screen.getByRole("img", { name: "Total · B: 30" })).toBeInTheDocument();
  });
  it("exposes sampling in the result and removes exports when unsampled input overflows", async () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, rows: Array.from({ length: 2001 }, (_, i) => [i, i, null]) }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "scatter" } });
    await waitFor(() => expect(TestWorker.instances.at(-1)?.request.kind).toBe("scatter")); finish();
    expect(screen.getByRole("status")).toHaveTextContent("Sample: 2000 of 2001");
    const old = TestWorker.instances.at(-1)!;
    fireEvent.click(screen.getByLabelText(/Use a reproducible sample/));
    expect(screen.getByRole("button", { name: "Export analysis JSON" })).toBeDisabled();
    await waitFor(() => expect(TestWorker.instances.at(-1)).not.toBe(old));
    const current = TestWorker.instances.at(-1)!;
    expect(current.request).toMatchObject({ sample: false });
    expect(() => analyze(current.request)).toThrow("points");
    act(() => current.onmessage?.({ data: { error: "points" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("More than 2,000");
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
  });
  it("recomputes time grouping from source rows, ignores old workers and exports UTC configuration", async () => {
    const rows = [["2026-11-11", 30, "a"], ["2026-11-01T08:00:00+08:00", 2, "a"], ["2026-11-01T00:00:00Z", 4, "a"]];
    render(<ResultAnalysis snapshot={{ ...snapshot, rows }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "line" } });
    fireEvent.change(screen.getByLabelText("Aggregation"), { target: { value: "mean" } });
    const category = TestWorker.instances.at(-1)!;
    fireEvent.change(screen.getByLabelText("Horizontal axis"), { target: { value: "time" } });
    expect(category.terminated).toBe(true);
    act(() => category.finish());
    expect(screen.getByRole("button", { name: "Export analysis JSON" })).toBeDisabled();
    expect(TestWorker.instances.at(-1)!.request).toMatchObject({ axis: { kind: "time", time: { input: "iso", naive: "utc", bucket: "instant" } }, rows: rows.map(r => [r[0], null, r[1]]) });
    finish();
    expect(screen.getByRole("img", { name: /2026-11-01T00:00:00Z.*: 3/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Time grouping (UTC)"), { target: { value: "month" } }); finish();
    expect(screen.getByRole("img", { name: /2026-11-01T00:00:00Z.*: 12/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export analysis JSON" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalled());
    const payload = JSON.parse(vi.mocked(saveTextFile).mock.calls[0][1]);
    expect(payload.configuration).toMatchObject({ axisKind: "time", timeOptions: { bucket: "month" } });
    expect(payload.result.rows).toHaveLength(1);
    expect(payload.result.rows[0].label).toBe("2026-11-01T00:00:00Z");
    expect(payload.result.total.value).toBe("12");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export pivot CSV" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Export pivot CSV" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveTextFile).mock.calls[1][1]).toContain("group · UTC · Month · ISO / SQL date or timestamp");
  });
  it("normalizes numeric dimensions independently of measure parsing and exports axis metadata", async () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, rows: [["10", "4", "a"], ["1", "2", "a"], [1, "6", "a"]] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Horizontal axis"), { target: { value: "number" } });
    fireEvent.change(screen.getByLabelText("Aggregation"), { target: { value: "mean" } }); finish();
    expect(screen.getByRole("img", { name: /1 \[number\].*: 4$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Interpret numeric text as numbers")); finish();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export analysis JSON" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalled());
    const payload = JSON.parse(vi.mocked(saveTextFile).mock.calls[0][1]);
    expect(payload.configuration).toMatchObject({ axisKind: "number", parseStrings: false });
    expect(payload.result.rows.map((r: { coordinate: string }) => r.coordinate)).toEqual(["1", "10"]);
    expect(payload.result.total.value).toBeNull();
  });
  it("gates invalid time exports and restores the selected time axis after categorical-only charts", () => {
    render(<ResultAnalysis snapshot={{ ...snapshot, rows: [["2026-11-06 12:00:00", 1, "a"]] }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    fireEvent.change(screen.getByLabelText("Horizontal axis"), { target: { value: "time" } }); finish();
    fireEvent.change(screen.getByLabelText("Timestamps without an offset"), { target: { value: "reject" } });
    const worker = TestWorker.instances.at(-1)!;
    expect(() => analyze(worker.request)).toThrow("axis_time");
    act(() => worker.onmessage?.({ data: { error: "axis_time" } }));
    expect(screen.getByRole("alert")).toHaveTextContent("Check input units and offset rules");
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Timestamps without an offset"), { target: { value: "utc" } }); finish();
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "pie" } });
    expect(TestWorker.instances.at(-1)!.request).toMatchObject({ axis: { kind: "category" } }); finish();
    expect(screen.queryByLabelText("Horizontal axis")).toBeNull();
    fireEvent.change(screen.getByLabelText("Chart type"), { target: { value: "line" } });
    expect(screen.getByLabelText("Horizontal axis")).toHaveValue("time");
    expect(TestWorker.instances.at(-1)!.request).toMatchObject({ axis: { kind: "time" } }); finish();
    fireEvent.change(screen.getByLabelText("Time input format"), { target: { value: "nanoseconds" } });
    expect(TestWorker.instances.at(-1)!.request).toMatchObject({ axis: { kind: "time", time: { input: "nanoseconds" } } });
    expect(screen.queryByLabelText("Timestamps without an offset")).toBeNull();
  });
  it("draws zero bars at zero height and limits chart categories explicitly", () => {
    const rows = [{ key: "a", label: "a", type: "string", count: 1 }];
    const ui = render(<ResultChart rows={rows} values={[{ value: "0", rounded: false }]} kind="bar" title="Zeros" />);
    const svg = screen.getByRole("img", { name: "Zeros" });
    expect(svg.querySelectorAll("rect")[1].getAttribute("height")).toBe("0");
    ui.rerender(<ResultChart rows={Array.from({ length: 61 }, (_, i) => ({ ...rows[0], key: String(i) }))} values={[]} kind="bar" title="Many" />);
    expect(screen.getByRole("status")).toHaveTextContent("60 categories");
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("keeps export failures local to the dialog and retains statistics", async () => {
    vi.mocked(saveTextFile).mockRejectedValueOnce(new Error("disk"));
    render(<ResultAnalysis snapshot={snapshot} onClose={vi.fn()} />); finish();
    fireEvent.click(screen.getByRole("button", { name: "Export analysis JSON" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not export analysis"));
    expect(within(screen.getByRole("dialog")).getByText("A [string]")).toBeInTheDocument();
  });
});
