import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importSelect } from "@/lib/importSelect";
import { QueryBuilderView } from "./QueryBuilderView";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { useI18n } from "@/store/i18n";
import type { ColumnInfo, TreeEntry, WorkspaceTab } from "@/types";

const mocks = vi.hoisted(() => ({ queryBuilderStarWidth: vi.fn(), listTables: vi.fn(), listColumns: vi.fn(), listDatabases: vi.fn(), closeEditorSession: vi.fn(async () => {}) }));
vi.mock("@/lib/api", () => ({ api: mocks }));
const tab: WorkspaceTab = { id: "builder:test", kind: "query-builder", title: "Query builder", connectionId: "a" };
function addTable() { fireEvent.change(screen.getByLabelText("Add a table or view…"), { target: { value: "0" } }); }
async function ready() { await screen.findByRole("option", { name: "users" }); }
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  useI18n.setState({ lang: "en" });
  useConnections.setState({ list: [{ id: "a", name: "First", driver: "sqlite" }, { id: "b", name: "Second", driver: "sqlite" }], status: { a: "connected", b: "connected" } });
  useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  mocks.queryBuilderStarWidth.mockResolvedValue(2);
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

  it("edits parameter placeholders, restores the draft and hands off names only", async () => {
    const view = render(<QueryBuilderView tab={tab} />); await ready(); addTable();
    fireEvent.click(screen.getByRole("button", { name: "Add output column" }));
    fireEvent.change(screen.getByLabelText(/1 · Expression kind$/), { target: { value: "parameter" } });
    const name = screen.getByLabelText(/1 · Parameter name$/);
    const handoff = screen.getByRole("button", { name: "Open in SQL editor" });
    expect(handoff).toBeDisabled();
    fireEvent.change(name, { target: { value: "label" } });
    fireEvent.change(screen.getByLabelText("LIMIT"), { target: { value: ":page_size" } });
    fireEvent.change(screen.getByLabelText("OFFSET"), { target: { value: ":page_size" } });
    expect(handoff).toBeEnabled();
    const saved = JSON.parse(localStorage.getItem("rdb:workspace")!).state.tabs[0];
    expect(saved.builder.query.columns[0].expression).toEqual({ kind: "parameter", name: "label" });
    view.unmount(); render(<QueryBuilderView tab={saved} />);
    expect(screen.getByLabelText(/1 · Parameter name$/)).toHaveValue("label");
    fireEvent.click(screen.getByRole("button", { name: "Open in SQL editor" }));
    const opened = useWorkspace.getState().tabs.at(-1)!;
    expect(opened.sql).toMatch(/SELECT\s+:label\s+FROM .*\nLIMIT :page_size\nOFFSET :page_size;/);
    expect(opened.queryParameterDefaults).toEqual([{ name: "page_size", kind: "integer" }]);
  });

  it("edits UNION branches independently and preserves the result tail through restore and removal", async () => {
    const query = importSelect("SELECT 1 AS k UNION ALL SELECT 2 AS k ORDER BY k LIMIT :size", "sqlite");
    const seeded: WorkspaceTab = { ...tab, builder: {version: 1, connectionId: "a", catalogSchema: "", query} };
    useWorkspace.setState({ tabs: [seeded], activeTabId: tab.id });
    const view = render(<QueryBuilderView tab={seeded} />); await ready();
    fireEvent.change(screen.getByLabelText("Edit SELECT branch"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Combine with previous SELECT"), { target: { value: "UNION" } });
    fireEvent.change(screen.getByLabelText("Sort direction 1"), { target: { value: "DESC" } });
    fireEvent.click(screen.getByRole("button", { name: "Add UNION branch" }));
    expect(screen.getByRole("button", { name: "Open in SQL editor" })).toBeDisabled();
    addTable();
    await screen.findByText("The SELECT branches must return the same number of columns.");
    expect(screen.getByRole("button", { name: "Open in SQL editor" })).toBeDisabled();
    await waitFor(() => expect(mocks.listColumns).toHaveBeenCalledWith("a", "users", undefined));
    fireEvent.click(screen.getByRole("button", { name: "Add output column" }));
    const saved = JSON.parse(localStorage.getItem("rdb:workspace")!).state.tabs[0];
    expect(saved.builder.query.unions.map((item: {operator: string}) => item.operator)).toEqual(["UNION", "UNION ALL"]);
    view.unmount(); render(<QueryBuilderView tab={saved} />); await ready();
    const remove = screen.getByRole("button", { name: "Remove branch" });
    fireEvent.click(remove); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("SQL preview")).toHaveTextContent("1 AS");
    fireEvent.click(remove);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove branch" }));
    const preview = screen.getByLabelText("SQL preview").textContent!;
    expect(preview).toContain('SELECT\n  2 AS "k"\nUNION ALL\nSELECT\n  "t1"."id"');
    expect(preview).not.toContain("1 AS");
    expect(preview).toContain("ORDER BY k DESC\nLIMIT :size;");
    fireEvent.click(screen.getByRole("button", { name: "Open in SQL editor" }));
    expect(useWorkspace.getState().tabs.at(-1)).toMatchObject({
      sql: preview, queryParameterDefaults: [{ name: "size", kind: "integer" }],
    });
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
