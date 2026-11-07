import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryBuilderView } from "./QueryBuilderView";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { useI18n } from "@/store/i18n";
import type { ColumnInfo, TreeEntry, WorkspaceTab } from "@/types";

const mocks = vi.hoisted(() => ({ listTables: vi.fn(), listColumns: vi.fn(), listDatabases: vi.fn(), closeEditorSession: vi.fn(async () => {}) }));
vi.mock("@/lib/api", () => ({ api: mocks }));
const tab: WorkspaceTab = { id: "builder:test", kind: "query-builder", title: "Query builder", connectionId: "a" };
function addTable() { fireEvent.change(screen.getByLabelText("Add a table or view…"), { target: { value: "0" } }); }
async function ready() { await screen.findByRole("option", { name: "users" }); }
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  useI18n.setState({ lang: "en" });
  useConnections.setState({ list: [{ id: "a", name: "First", driver: "sqlite" }, { id: "b", name: "Second", driver: "sqlite" }], status: { a: "connected", b: "connected" } });
  useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  mocks.listTables.mockResolvedValue([{ name: "users", kind: "table" }]);
  mocks.listColumns.mockResolvedValue([{ name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true }, { name: "name", data_type: "TEXT", nullable: false, is_primary_key: false }]);
});

describe("QueryBuilderView", () => {
  it("keeps same-name MySQL tables bound to their selected databases", async () => {
    useConnections.setState({ list: [{ id: "a", name: "MySQL", driver: "mysql", database: "first" }], status: { a: "connected" } });
    mocks.listDatabases.mockResolvedValue(["first", "second"]);
    mocks.listTables.mockImplementation(async (_id: string, schema?: string) => [{ name: "users", kind: "table", schema: schema ?? null }]);
    render(<QueryBuilderView tab={tab} />); await ready(); addTable();
    await screen.findByRole("option", { name: "second" });
    fireEvent.change(screen.getByLabelText("Database / schema"), { target: { value: "second" } });
    await screen.findByRole("option", { name: "second.users" }); addTable();
    fireEvent.change(screen.getByLabelText("Join type 1"), { target: { value: "CROSS" } });
    const sql = screen.getByLabelText("SQL preview");
    expect(sql).toHaveTextContent("FROM `first`.`users` AS `t1`");
    expect(sql).toHaveTextContent("CROSS JOIN `second`.`users` AS `t2`");
    await waitFor(() => expect(mocks.listColumns).toHaveBeenCalledWith("a", "users", "second"));
    expect(mocks.listColumns).toHaveBeenCalledWith("a", "users", "first");
  });

  it("builds a projection, persists the design and hands off SQL to the chosen connection without execution", async () => {
    const view = render(<QueryBuilderView tab={tab} />); await ready(); addTable();
    await waitFor(() => expect(mocks.listColumns).toHaveBeenCalledTimes(1));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Add output column" }));
    await screen.findByRole("option", { name: "t1.name" });
    const saved = useWorkspace.getState().tabs[0];
    expect(saved.builder?.query.sources[0].name).toBe("users");
    expect(saved.builder?.query.columns).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("rdb:workspace")!).state.tabs[0].builder.query.columns).toHaveLength(1);
    view.unmount(); render(<QueryBuilderView tab={saved} />);
    expect(screen.getByLabelText("SQL preview")).toHaveTextContent('"t1"."id"');
    fireEvent.click(screen.getByRole("button", { name: "Open in SQL editor" }));
    const opened = useWorkspace.getState().tabs.at(-1)!;
    expect(opened.kind).toBe("query"); expect(opened.connectionId).toBe("a");
    expect(opened.sql).toBe('SELECT\n  "t1"."id"\nFROM "users" AS "t1"\nLIMIT 100;');
  });

  it("requires confirmation before resetting a nonempty design on connection change", async () => {
    render(<QueryBuilderView tab={tab} />); await ready(); addTable();
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "b" } });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Connection")).toHaveValue("a");
    expect(useWorkspace.getState().tabs[0].builder?.query.sources).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Change connection" }));
    expect(screen.getByLabelText("Connection")).toHaveValue("b");
    expect(useWorkspace.getState().tabs[0].builder?.query.sources).toHaveLength(0);
  });

  it("ignores stale catalog responses after switching connections", async () => {
    let resolve!: (tables: TreeEntry[]) => void;
    mocks.listTables.mockImplementationOnce(() => new Promise<TreeEntry[]>(r => { resolve = r; }));
    mocks.listTables.mockResolvedValue([{ name: "new_table", kind: "table" }]);
    render(<QueryBuilderView tab={tab} />);
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "b" } });
    await screen.findByRole("option", { name: "new_table" });
    await act(async () => resolve([{ name: "old_table", kind: "table" }]));
    expect(screen.queryByRole("option", { name: "old_table" })).not.toBeInTheDocument();
  });

  it("ignores stale column metadata after resetting the connection", async () => {
    let resolve!: (columns: ColumnInfo[]) => void;
    mocks.listColumns.mockImplementationOnce(() => new Promise<ColumnInfo[]>(r => { resolve = r; }));
    render(<QueryBuilderView tab={tab} />); await ready(); addTable();
    await waitFor(() => expect(mocks.listColumns).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Connection"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Change connection" }));
    await ready(); addTable();
    await waitFor(() => expect(mocks.listColumns).toHaveBeenCalledTimes(2));
    await act(async () => resolve([{ name: "old_column", data_type: "TEXT", nullable: false, is_primary_key: false }]));
    fireEvent.click(screen.getByRole("button", { name: "Add output column" }));
    expect(screen.queryByRole("option", { name: "t1.old_column" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "t1.name" })).toBeInTheDocument();
  });

  it("reuses column metadata across self joins and blocks incomplete joins", async () => {
    render(<QueryBuilderView tab={tab} />); await ready(); addTable();
    await waitFor(() => expect(mocks.listColumns).toHaveBeenCalledTimes(1)); await act(async () => {});
    addTable();
    await act(async () => {});
    expect(mocks.listColumns).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Open in SQL editor" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Join type 1"), { target: { value: "CROSS" } });
    expect(screen.getByRole("button", { name: "Open in SQL editor" })).toBeEnabled();
    expect(screen.getByLabelText("SQL preview")).toHaveTextContent('CROSS JOIN "users" AS "t2"');
  });
});
