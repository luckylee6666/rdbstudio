import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { OfflineModelView } from "./OfflineModelView";
import { newModel, type ModelRecord } from "@/lib/offlineModel";
import { useWorkspace } from "@/store/workspace";
import { useI18n } from "@/store/i18n";

vi.mock("@/components/models/ModelCanvas", () => ({ ModelCanvas: ({ model, layoutVersion }: { model: ModelRecord["model"]; layoutVersion: number }) => <div data-testid="model-canvas" data-layout-version={layoutVersion}>{model.tables.map(t => t.name).join(",")}</div> }));
const tab = { id: "offline-models", kind: "model" as const, title: "Offline models", modelId: "one" };
let record: ModelRecord;
let rejectSave = false;
let rejectGet = false;
let requests: string[];
beforeEach(() => {
  clearMocks(); localStorage.clear(); useI18n.setState({ lang: "en" });
  useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  record = { id: "one", revision: "r1", name: "Design", updated_at: "now", model: { ...newModel(), tables: [{ id: "t", name: "items", schema: "", comment: "", position: { x: 0, y: 0 }, columns: [] }] } };
  rejectSave = false; rejectGet = false; requests = [];
  mockIPC((command, payload) => {
    requests.push(command);
    if (command === "list_offline_models") return [{ id: record.id, revision: record.revision, name: record.name, updated_at: "now", dialect: "sqlite", tables: record.model.tables.length, relations: 0 }];
    if (command === "get_offline_model") { if (rejectGet) throw new Error("preset_storage"); return structuredClone(record); }
    if (command === "save_offline_model") {
      if (rejectSave) throw new Error("preset_conflict");
      const request = (payload as { request: { revision: string; name: string; model: ModelRecord["model"] } }).request;
      if (request.revision !== record.revision) throw new Error("preset_conflict");
      record = { ...record, name: request.name, revision: record.revision + "n", model: structuredClone(request.model) };
      return structuredClone(record);
    }
    return undefined;
  });
});
afterEach(clearMocks);

it("restores a saved model under StrictMode without touching database commands", async () => {
  render(<StrictMode><OfflineModelView tab={tab} /></StrictMode>);
  expect(await screen.findByTestId("model-canvas")).toHaveTextContent("items");
  expect(screen.getByRole("button", { name: "Add table" })).toBeEnabled();
  expect(requests.filter(command => command === "get_offline_model")).toHaveLength(1);
  expect(requests.every(command => ["list_offline_models", "get_offline_model"].includes(command))).toBe(true);
});

it("retains edit drafts after a save conflict and only records successful edits in undo history", async () => {
  render(<OfflineModelView tab={tab} />); await screen.findByTestId("model-canvas");
  fireEvent.change(screen.getByRole("combobox", { name: "Tables" }), { target: { value: "t" } });
  fireEvent.click(screen.getByRole("button", { name: "Edit table" }));
  const dialog = screen.getByRole("dialog", { name: "Edit table" });
  fireEvent.change(within(dialog).getByLabelText("Table name"), { target: { value: "renamed" } });
  rejectSave = true; fireEvent.click(within(dialog).getByRole("button", { name: "Apply & save" }));
  await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("changed elsewhere"));
  expect(screen.getByTestId("model-canvas")).toHaveTextContent("items");
  expect(within(dialog).getByLabelText("Table name")).toHaveValue("renamed");
  expect(screen.getByRole("button", { name: "Undo model change" })).toBeDisabled();
  rejectSave = false; fireEvent.click(within(dialog).getByRole("button", { name: "Apply & save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByTestId("model-canvas")).toHaveTextContent("renamed");
  fireEvent.click(screen.getByRole("button", { name: "Undo model change" }));
  await waitFor(() => expect(screen.getByTestId("model-canvas")).toHaveTextContent("items"));
  expect(record.model.tables[0].name).toBe("items");
  fireEvent.click(screen.getByRole("button", { name: "Redo model change" }));
  await waitFor(() => expect(screen.getByTestId("model-canvas")).toHaveTextContent("renamed"));
  expect(record.model.tables[0].name).toBe("renamed");
});

it("hides a portal when its tab becomes inactive and preserves the unsubmitted field draft", async () => {
  render(<OfflineModelView tab={tab} />); await screen.findByTestId("model-canvas");
  fireEvent.click(screen.getByRole("button", { name: "Add table" }));
  fireEvent.change(screen.getByLabelText("Table name"), { target: { value: "draft_table" } });
  act(() => useWorkspace.setState({ activeTabId: "another" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => useWorkspace.setState({ activeTabId: tab.id }));
  expect(screen.getByLabelText("Table name")).toHaveValue("draft_table");
  expect(requests).not.toContain("save_offline_model");
});

it("requests a fresh viewport fit only after arrangement or reload succeeds", async () => {
  render(<OfflineModelView tab={tab} />); const canvas = await screen.findByTestId("model-canvas");
  rejectSave = true;
  fireEvent.click(screen.getByRole("button", { name: "Arrange tables" }));
  await screen.findByRole("alert");
  expect(canvas).toHaveAttribute("data-layout-version", "0");
  rejectSave = false;
  fireEvent.click(screen.getByRole("button", { name: "Arrange tables" }));
  await waitFor(() => expect(canvas).toHaveAttribute("data-layout-version", "1"));
  fireEvent.click(screen.getByRole("button", { name: "Reload saved model" }));
  rejectGet = true;
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reload saved model" }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Could not read or save"));
  expect(canvas).toHaveAttribute("data-layout-version", "1");
  expect(screen.getByRole("button", { name: "Undo model change" })).toBeEnabled();
  rejectGet = false;
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reload saved model" }));
  await waitFor(() => expect(canvas).toHaveAttribute("data-layout-version", "2"));
});
