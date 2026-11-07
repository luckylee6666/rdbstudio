import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { AnalysisPresetLibrary } from "./AnalysisPresetLibrary";
import { ResultAnalysis } from "./ResultAnalysis";
import { captureAnalysisConfiguration, type AnalysisSettings, type AnalysisConfiguration } from "@/lib/analysisPresets";
import { DEFAULT_TIME_OPTIONS } from "@/lib/resultTime";
import { DEFAULT_METRIC_OPTIONS } from "@/lib/resultCharts";
import { analyze, type AnalysisRequest } from "@/lib/resultAnalysis";
import { saveTextFile } from "@/lib/csv";
import { useI18n } from "@/store/i18n";
const api = vi.hoisted(() => ({ listAnalysisPresets: vi.fn(), getAnalysisPreset: vi.fn(), saveAnalysisPreset: vi.fn(), renameAnalysisPreset: vi.fn(), deleteAnalysisPreset: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/lib/csv", async original => ({ ...await original<object>(), saveTextFile: vi.fn().mockResolvedValue(null) }));
const columns = [{ name: "day", data_type: "TEXT" }, { name: "amount", data_type: "INTEGER" }, { name: "region", data_type: "TEXT" }];
const settings: AnalysisSettings = { mode: "chart", chart: "combo", column: 0, row: 0, split: 2, measure: 1, aggregate: "sum", parseStrings: true, axisKind: "category", timeOptions: DEFAULT_TIME_OPTIONS, metricOptions: DEFAULT_METRIC_OPTIONS, scatterX: 0, scatterY: 1, scatterLabel: -1, sample: true };
const rows = [["one", 1, "East"], ["one", 3, "West"], ["two", 2, "East"], ["two", 6, "West"]];
const pivot = analyze({ kind: "pivot", rows: rows.map(r => [r[0], r[2], r[1]]), parseStrings: true, aggregate: "sum", split: true });
if (pivot.kind !== "pivot") throw new Error();
const keys = pivot.columns.map(b => b.key).reverse();
const config = captureAnalysisConfiguration(columns, settings, { mode: "keys", keys }, true);
const saved = { id: "id", revision: "rev", name: "Reusable", updated_at: "2026-11-06", config };
const summary = { ...saved, mode: config.mode, chart: config.chart, has_series_values: true };
const onLoad = vi.fn(), onOpenChange = vi.fn();
const capture = (include: boolean) => captureAnalysisConfiguration(columns, settings, { mode: "keys", keys }, include);
function library(target = columns) { return render(<AnalysisPresetLibrary columns={target} capture={capture} disabled={false} onLoad={onLoad} onOpenChange={onOpenChange} />); }
async function open() { fireEvent.click(screen.getByRole("button", { name: "Analysis configurations" })); await screen.findByRole("option", { name: /Reusable/ }); fireEvent.change(screen.getByLabelText("Select configuration"), { target: { value: "id" } }); }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class WorkerMock {
  static all: WorkerMock[] = []; request!: AnalysisRequest; onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor() { WorkerMock.all.push(this); } postMessage(request: AnalysisRequest) { this.request = request; } terminate() {}
  finish() { this.onmessage?.({ data: { result: analyze(this.request) } }); }
}
beforeEach(() => {
  vi.resetAllMocks(); useI18n.setState({ lang: "en" }); WorkerMock.all = []; vi.stubGlobal("Worker", WorkerMock);
  api.listAnalysisPresets.mockResolvedValue([summary]); api.getAnalysisPreset.mockResolvedValue(saved); api.saveAnalysisPreset.mockResolvedValue(saved); api.renameAnalysisPreset.mockResolvedValue(saved);
});
afterEach(() => vi.unstubAllGlobals());
describe("analysis configuration library", () => {
  it("stores no selected source values by default; replacement and rename use the selected revision", async () => {
    library(); expect(api.listAnalysisPresets).not.toHaveBeenCalled(); await open();
    fireEvent.click(screen.getByRole("button", { name: "Save current as new" }));
    fireEvent.change(screen.getByLabelText("Configuration name"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(api.saveAnalysisPreset).toHaveBeenCalledOnce());
    expect(api.saveAnalysisPreset.mock.calls[0][0]).toMatchObject({ id: null, revision: null, name: "New", config: { series: { mode: "choose" } } });
    expect(JSON.stringify(api.saveAnalysisPreset.mock.calls)).not.toContain("West");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save current as new" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Replace with current" }));
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(api.saveAnalysisPreset).toHaveBeenCalledTimes(2));
    expect(api.saveAnalysisPreset.mock.calls[1][0]).toMatchObject({ id: "id", revision: "rev", config: { series: { mode: "keys", keys } } });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Replace with current" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Rename" })); fireEvent.change(screen.getByLabelText("Configuration name"), { target: { value: "Renamed" } }); fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(api.renameAnalysisPreset).toHaveBeenCalledWith("id", "rev", "Renamed"));
    expect(onLoad).not.toHaveBeenCalled();
  });
  it("keeps failed replacement open and requires explicit delete confirmation", async () => {
    api.saveAnalysisPreset.mockRejectedValue("preset_conflict"); library(); await open(); fireEvent.click(screen.getByRole("button", { name: "Replace with current" })); fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); fireEvent.click(screen.getByRole("button", { name: "Delete" })); expect(api.deleteAnalysisPreset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete configuration" })); await waitFor(() => expect(api.deleteAnalysisPreset).toHaveBeenCalledWith("id", "rev"));
  });
  it("requires explicit mappings for duplicate names and changed types before applying", async () => {
    library([columns[0], columns[0], { ...columns[1], data_type: "TEXT" }, columns[2]]); await open(); fireEvent.click(screen.getByRole("button", { name: "Load and map fields" }));
    const dialog = await screen.findByRole("dialog", { name: "Review column mapping" });
    expect(within(dialog).getByLabelText("Row dimension")).toHaveValue(""); expect(within(dialog).getByLabelText("Measure")).toHaveValue("");
    expect(within(dialog).getByLabelText("Column dimension")).toHaveValue("3"); expect(screen.getByRole("button", { name: "Apply to snapshot" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Row dimension"), { target: { value: "1" } }); fireEvent.change(within(dialog).getByLabelText("Measure"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to snapshot" })); expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ row: 1, measure: 2, split: 3 }), config);
  });
  it("exports standalone definitions with opt-in reset and rejects result JSON imports", async () => {
    library(); await open(); fireEvent.click(screen.getByRole("button", { name: "Export current configuration" }));
    const dialog = screen.getByRole("dialog", { name: "Export current configuration" });
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked(); fireEvent.click(within(dialog).getByRole("button", { name: "Export current configuration" }));
    await waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce());
    expect(JSON.parse(vi.mocked(saveTextFile).mock.calls[0][1]).series).toEqual({ mode: "choose" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Export current configuration" })).toBeNull());
    const text = vi.fn().mockResolvedValue('{"version":1,"result":{"rows":["private"]}}');
    fireEvent.change(screen.getByLabelText("Import configuration JSON"), { target: { files: [{ size: 80, text }] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid configuration"); expect(onLoad).not.toHaveBeenCalled();
  });
  it("checks file size before reading and ignores late file results after unmount", async () => {
    const ui = library(); await open(); const text = vi.fn(); fireEvent.change(screen.getByLabelText("Import configuration JSON"), { target: { files: [{ size: 65537, text }] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("64 KiB"); expect(text).not.toHaveBeenCalled();
    const pending = deferred<string>(); fireEvent.change(screen.getByLabelText("Import configuration JSON"), { target: { files: [{ size: 500, text: () => pending.promise }] } });
    ui.unmount(); await act(async () => pending.resolve(JSON.stringify(config))); expect(onLoad).not.toHaveBeenCalled();
  });
  it("applies all controls atomically, invalidates stale jobs and keeps saved series order", async () => {
    render(<ResultAnalysis snapshot={{ columns: [columns[2], columns[1], columns[0]], rows: rows.map(r => [r[2],r[1],r[0]]), label: "private SQL", scope: "result" }} onClose={vi.fn()} />);
    const old = WorkerMock.all[0]; await open(); fireEvent.click(screen.getByRole("button", { name: "Load and map fields" })); await screen.findByRole("dialog", { name: "Review column mapping" }); fireEvent.click(screen.getByRole("button", { name: "Apply to snapshot" }));
    expect(screen.getByLabelText("Chart type")).toHaveValue("combo"); expect(screen.getByLabelText("Row dimension")).toHaveValue("2");
    act(() => old.finish()); expect(screen.getByRole("button", { name: "Export analysis JSON" })).toBeDisabled();
    act(() => WorkerMock.all.at(-1)!.finish());
    fireEvent.click(screen.getByRole("button", { name: "Export chart SVG" })); await waitFor(() => expect(saveTextFile).toHaveBeenCalled());
    const svg = vi.mocked(saveTextFile).mock.calls[0][1]; expect(svg.indexOf("West [string]")).toBeLessThan(svg.indexOf("East [string]"));
  });
  it.each(["choose", "missing"])("blocks misleading chart export for %s series and recovers with explicit selection", async mode => {
    const c: AnalysisConfiguration = { ...config, chart: "line", series: mode === "choose" ? { mode: "choose" } : { mode: "keys", keys: [keys[0], "absent"] } };
    api.getAnalysisPreset.mockResolvedValue({ ...saved, config: c });
    render(<ResultAnalysis snapshot={{ columns, rows, label: "Snapshot", scope: "result" }} onClose={vi.fn()} />); await open(); fireEvent.click(screen.getByRole("button", { name: "Load and map fields" })); await screen.findByRole("dialog", { name: "Review column mapping" }); fireEvent.click(screen.getByRole("button", { name: "Apply to snapshot" })); act(() => WorkerMock.all.at(-1)!.finish());
    expect(screen.queryByRole("button", { name: "Export chart SVG" })).toBeNull();
    expect(screen.getByText(mode === "choose" ? "Select at least one series to display." : "Some saved series are absent. Review and select the visible series again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all" })); expect(screen.getByRole("button", { name: "Export chart SVG" })).toBeEnabled();
  });
});
