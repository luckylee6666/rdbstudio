import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ModelDdlDialog } from "./ModelDdlDialog";
import { newModel, type ModelRecord } from "@/lib/offlineModel";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { useI18n } from "@/store/i18n";
import { copyText } from "@/lib/clipboard";
import { saveTextFile } from "@/lib/csv";
vi.mock("@/components/editor/ReadOnlySql", () => ({ ReadOnlySql: ({ value }: { value: string }) => <pre data-testid="sql-preview">{value}</pre> }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("@/lib/csv", () => ({ saveTextFile: vi.fn() }));
const record: ModelRecord = { id: "m", revision: "r", name: "Model", updated_at: "now", model: { ...newModel("postgres"), tables: [{ id: "t", name: "items", schema: "audit", comment: "", position: { x: 0, y: 0 }, columns: [{ id: "c", name: "id", type: "INTEGER", nullable: false, primaryKey: true, unique: false, comment: "" }] }] } };
beforeEach(() => { vi.clearAllMocks(); useI18n.setState({ lang: "en" }); useWorkspace.setState({ tabs: [], activeTabId: null }); useConnections.setState({ list: [{ id: "pg", driver: "postgres", name: "Writable" }, { id: "ro", driver: "postgres", name: "Readonly", read_only: true }, { id: "mysql", driver: "mysql", name: "Other dialect" }, { id: "off", driver: "postgres", name: "Disconnected" }], status: { pg: "connected", ro: "connected", mysql: "connected", off: "disconnected" } }); });
it("opens only a fixed SQL snapshot in a writable matching connection, without executing", async () => {
  const close = vi.fn(); render(<ModelDdlDialog record={record} visible onClose={close} />);
  await screen.findByTestId("sql-preview");
  expect(screen.queryByRole("option", { name: "Readonly" })).not.toBeInTheDocument(); expect(screen.queryByRole("option", { name: "Other dialect" })).not.toBeInTheDocument(); expect(screen.queryByRole("option", { name: "Disconnected" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Include CREATE SCHEMA / CREATE DATABASE statements"));
  fireEvent.change(screen.getByLabelText("Connected writable database of the same dialect"), { target: { value: "pg" } });
  fireEvent.click(screen.getByRole("button", { name: "Open in query editor" }));
  expect(close).toHaveBeenCalledOnce(); const tab = useWorkspace.getState().tabs[0]; expect(tab.kind).toBe("query"); expect(tab.connectionId).toBe("pg"); expect(tab.sql).toContain('CREATE SCHEMA IF NOT EXISTS "audit"'); expect(tab.sql).not.toContain("DROP");
});
it("rechecks a selected connection after disconnection and refuses handoff", async () => {
  render(<ModelDdlDialog record={record} visible onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("Connected writable database of the same dialect"), { target: { value: "pg" } });
  act(() => useConnections.setState({ status: { pg: "disconnected" } }));
  expect(screen.getByRole("button", { name: "Open in query editor" })).toBeDisabled();
});
it("reports failed clipboard copies and exports the displayed plan", async () => {
  vi.mocked(copyText).mockResolvedValue(false); vi.mocked(saveTextFile).mockResolvedValue("chosen.sql");
  render(<ModelDdlDialog record={record} visible onClose={() => {}} />); await screen.findByTestId("sql-preview");
  fireEvent.click(screen.getByRole("button", { name: "Copy SQL" })); await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "SQL copied" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Export SQL" })); await waitFor(() => expect(saveTextFile).toHaveBeenCalledWith("Model.sql", screen.getByTestId("sql-preview").textContent, "sql"));
});
it("blocks export and handoff for invalid model definitions", () => {
  render(<ModelDdlDialog record={{ ...record, model: newModel("postgres") }} visible onClose={() => {}} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Add a table"); expect(screen.getByRole("button", { name: "Export SQL" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Open in query editor" })).toBeDisabled();
});
