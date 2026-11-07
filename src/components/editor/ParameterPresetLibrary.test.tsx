import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryParametersDialog } from "./QueryParametersDialog";
import { useI18n } from "@/store/i18n";
import type { ParameterPreset, ParameterPresetSummary } from "@/lib/parameterPresets";

const api = vi.hoisted(() => ({ listParameterPresets: vi.fn(), getParameterPreset: vi.fn(), saveParameterPreset: vi.fn(), renameParameterPreset: vi.fn(), deleteParameterPreset: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
const preset: ParameterPreset = { id: "saved", revision: "first", name: "Reusable", updated_at: "2026-11-06", driver: "sqlite", mode: "single", atomic: true,
  parameters: [{ name: "value", kind: "text" }], sets: [[{ name: "value", kind: "text", value: "stored-value" }]] };
function summary(value: ParameterPreset): ParameterPresetSummary {
  const { sets, atomic: _atomic, ...rest } = value;
  return { ...rest, set_count: sets?.length ?? 0, has_values: sets !== null };
}
const run = vi.fn(), batch = vi.fn(), prepare = vi.fn();
function dialog() {
  return render(<QueryParametersDialog names={["value"]} previous={[{ name: "value", kind: "text", value: "unsaved-input" }]} defaults={[]}
    driver="sqlite" connectionName="Test" onClose={vi.fn()} onRun={run} onBatchRun={batch} onPrepareBatch={prepare} />);
}
async function library() {
  fireEvent.click(screen.getByText("Saved parameter presets"));
  await screen.findByRole("option", { name: /Reusable/ });
  fireEvent.change(screen.getByLabelText("Choose a preset"), { target: { value: preset.id } });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("saved parameter presets", () => {
  beforeEach(() => {
    vi.resetAllMocks(); useI18n.setState({ lang: "en" });
    prepare.mockResolvedValue(["value"]);
    api.listParameterPresets.mockResolvedValue([summary(preset)]);
    api.getParameterPreset.mockResolvedValue(preset);
    api.saveParameterPreset.mockResolvedValue(preset);
    api.renameParameterPreset.mockResolvedValue({ ...preset, name: "Renamed", revision: "second" });
    api.deleteParameterPreset.mockResolvedValue(undefined);
  });
  it("saves definitions only by default and never executes or sends current values", async () => {
    dialog(); await library();
    fireEvent.click(screen.getByRole("button", { name: "Save new preset" }));
    const editor = screen.getByRole("dialog", { name: "Save new preset" });
    fireEvent.change(within(editor).getByLabelText("Preset name"), { target: { value: "Types" } });
    expect(within(editor).getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(within(editor).getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(api.saveParameterPreset).toHaveBeenCalledOnce());
    expect(api.saveParameterPreset).toHaveBeenCalledWith({ driver: "sqlite", mode: "single", atomic: true, parameters: [{ name: "value", kind: "text" }], sets: null, id: null, revision: null, name: "Types" });
    expect(run).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
  });
  it("includes exact values only after opting in and loads them in another dialog without running", async () => {
    const first = dialog(); await library();
    fireEvent.change(screen.getByLabelText("value · Type"), { target: { value: "integer" } });
    fireEvent.change(screen.getByLabelText("value · Value"), { target: { value: "9223372036854775807" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new preset" }));
    const editor = screen.getByRole("dialog", { name: "Save new preset" });
    fireEvent.change(within(editor).getByLabelText("Preset name"), { target: { value: "Large integer" } });
    fireEvent.click(within(editor).getByRole("checkbox"));
    fireEvent.click(within(editor).getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(api.saveParameterPreset).toHaveBeenCalledOnce());
    const request = api.saveParameterPreset.mock.calls[0][0];
    expect(request.sets).toEqual([[{ name: "value", kind: "integer", value: "9223372036854775807" }]]);
    first.unmount();
    api.getParameterPreset.mockResolvedValue({ ...preset, ...request, id: preset.id });
    dialog(); await library(); fireEvent.click(screen.getByRole("button", { name: "Load preset" }));
    await waitFor(() => expect(screen.getByLabelText("value · Value")).toHaveValue("9223372036854775807"));
    expect(screen.getByLabelText("value · Save default")).not.toBeChecked();
    expect(run).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
  });
  it("loads typed batch NULL/empty values and verifies future parameter names first", async () => {
    const saved: ParameterPreset = { ...preset, mode: "batch", sets: [[{ name: "value", kind: "text", value: null }], [{ name: "value", kind: "text", value: "" }]], atomic: false };
    api.getParameterPreset.mockResolvedValue(saved);
    const pending = deferred<string[]>(); prepare.mockReturnValue(pending.promise);
    dialog(); await library(); fireEvent.click(screen.getByRole("button", { name: "Load preset" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Run with parameters" })).toBeDisabled();
    await act(async () => pending.resolve(["value"]));
    expect(screen.getByLabelText("Set 1 · value · NULL")).toBeChecked();
    expect(screen.getByLabelText("Set 2 · value · NULL")).not.toBeChecked();
    expect(screen.getByLabelText("Set 2 · value")).toHaveValue("");
    expect(screen.getByLabelText("Wrap the batch in one transaction when the script and session allow it")).not.toBeChecked();
    expect(batch).not.toHaveBeenCalled();
  });
  it("clears unsaved values when loading definitions without turning them into NULL", async () => {
    api.getParameterPreset.mockResolvedValue({ ...preset, sets: null });
    dialog(); await library(); fireEvent.click(screen.getByRole("button", { name: "Load preset" }));
    await waitFor(() => expect(screen.getByLabelText("value · Value")).toHaveValue(""));
    expect(screen.getByLabelText("value · NULL")).not.toBeChecked();
  });
  it("keeps current inputs on mismatched names or a failed generation check", async () => {
    api.getParameterPreset.mockResolvedValue({ ...preset, parameters: [{ name: "other", kind: "text" }] });
    dialog(); await library(); fireEvent.click(screen.getByRole("button", { name: "Load preset" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match this query");
    expect(screen.getByLabelText("value · Value")).toHaveValue("unsaved-input");
    api.getParameterPreset.mockResolvedValue({ ...preset, mode: "batch" });
    prepare.mockRejectedValue(new Error("connection generation changed"));
    fireEvent.click(screen.getByRole("button", { name: "Load preset" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not verify the current connection"));
    expect(screen.getByLabelText("value · Value")).toHaveValue("unsaved-input");
    expect(batch).not.toHaveBeenCalled();
  });
  it("sends the selected revision for replacement and keeps failed edits open", async () => {
    api.saveParameterPreset.mockRejectedValue("preset_conflict");
    dialog(); await library(); fireEvent.click(screen.getByRole("button", { name: "Replace selected" }));
    const editor = screen.getByRole("dialog", { name: "Replace selected" });
    fireEvent.click(within(editor).getByRole("button", { name: "Save preset" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("changed in another tab");
    expect(api.saveParameterPreset).toHaveBeenCalledWith(expect.objectContaining({ id: "saved", revision: "first", sets: null }));
    expect(editor).toBeInTheDocument();
    expect(screen.getByLabelText("value · Value")).toHaveValue("unsaved-input");
  });
  it("renames and deletes with revisions, without sending query values", async () => {
    dialog(); await library(); fireEvent.click(screen.getByRole("button", { name: "Rename preset" }));
    let editor = screen.getByRole("dialog", { name: "Rename preset" });
    fireEvent.change(within(editor).getByLabelText("Preset name"), { target: { value: "Renamed" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(api.renameParameterPreset).toHaveBeenCalledWith("saved", "first", "Renamed"));
    await waitFor(() => expect(editor).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
    editor = screen.getByRole("dialog", { name: "Delete preset" });
    expect(within(editor).getByText(/Values already loaded/)).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "Delete saved preset" }));
    await waitFor(() => expect(api.deleteParameterPreset).toHaveBeenCalledWith("saved", "first"));
    expect(api.saveParameterPreset).not.toHaveBeenCalled();
  });
  it("ignores an old list response after another tab updates the library", async () => {
    const old = deferred<ParameterPresetSummary[]>(); api.listParameterPresets.mockReturnValueOnce(old.promise);
    dialog(); fireEvent.click(screen.getByText("Saved parameter presets"));
    await waitFor(() => expect(api.listParameterPresets).toHaveBeenCalledOnce());
    act(() => window.dispatchEvent(new Event("parameter-presets-updated")));
    await screen.findByRole("option", { name: /Reusable/ });
    await act(async () => old.resolve([{ ...summary(preset), name: "Obsolete" }]));
    expect(screen.queryByRole("option", { name: /Obsolete/ })).not.toBeInTheDocument();
  });
  it("disables operations when search hides the selected preset", async () => {
    dialog(); await library();
    fireEvent.change(screen.getByLabelText("Search preset names"), { target: { value: "no match" } });
    for (const name of ["Load preset", "Replace selected", "Rename preset", "Delete preset"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByLabelText("Choose a preset")).toHaveValue("");
  });
  it("disables preset loading and input edits while batch names are being checked", async () => {
    const pending = deferred<string[]>(); prepare.mockReturnValue(pending.promise);
    dialog(); await library();
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    expect(screen.getByRole("button", { name: "Load preset" })).toBeDisabled();
    expect(screen.getByLabelText("value · Value")).toBeDisabled();
    await act(async () => pending.resolve(["value"]));
    expect(screen.getByLabelText("Set 1 · value")).toHaveValue("unsaved-input");
    expect(screen.getByRole("button", { name: "Load preset" })).toBeEnabled();
  });
});
