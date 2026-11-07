import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableDataView } from "./TableDataView";
import type { WorkspaceTab } from "@/types";
import { usePrefs } from "@/store/prefs";

const apiMocks = vi.hoisted(() => ({
  listColumns: vi.fn(async (_id: string, table: string) =>
    table === "customers"
      ? [
          { name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true },
          { name: "name", data_type: "TEXT", nullable: false, is_primary_key: false },
        ]
      : [
          { name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true },
          { name: "amount", data_type: "REAL", nullable: true, is_primary_key: false },
        ]
  ),
  fetchTableData: vi.fn(async (_id: string, query: { table: string }) => ({
    columns:
      query.table === "customers"
        ? [
            { name: "id", data_type: "INTEGER" },
            { name: "name", data_type: "TEXT" },
          ]
        : [
            { name: "id", data_type: "INTEGER" },
            { name: "amount", data_type: "REAL" },
          ],
    rows: query.table === "customers" ? [[1, "Alice"]] : [[1, 99.5]],
    elapsed_ms: 1,
    truncated: false,
  })),
  countTableRows: vi.fn(async () => 1),
  describeTable: vi.fn(async () => ({ foreign_keys: [] })),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));
vi.mock("@/components/data/TableDataGrid", () => ({
  TableDataGrid: ({ columns, rows, onSortClick }: { columns: Array<{ name: string }>; rows: Array<{values: unknown[]}>; onSortClick: (column: string) => void }) => (
    <div><div data-testid="column-names">{columns.map((column) => column.name).join(",")}</div>
      <div data-testid="rows">{JSON.stringify(rows.map(row => row.values))}</div>
      <button onClick={() => onSortClick("id")}>Sort id</button>
    </div>
  ),
}));

describe("TableDataView table identity", () => {
  beforeEach(() => { vi.clearAllMocks(); usePrefs.setState({ gridPageSize: 1 }); });

  it("renders and pages while the count is pending, without recounting on pagination or sorting", async () => {
    let resolveCount!: (count: number) => void;
    apiMocks.countTableRows.mockImplementationOnce(() => new Promise<number>(resolve => { resolveCount = resolve; }));
    render(<TableDataView tab={{ id: "a", kind: "table-data", title: "customers", table: "customers", connectionId: "c1" }} />);
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("Alice"));
    expect(apiMocks.countTableRows).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(apiMocks.fetchTableData).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Sort id" }));
    await waitFor(() => expect(apiMocks.fetchTableData).toHaveBeenCalledTimes(3));
    expect(apiMocks.countTableRows).toHaveBeenCalledTimes(1);
    await act(async () => resolveCount(42));
    expect(screen.getByText("1–1 of 42")).toBeInTheDocument();
  });

  it("does not let an old table count replace a new table count", async () => {
    let resolveOld!: (count: number) => void;
    apiMocks.countTableRows.mockImplementationOnce(() => new Promise<number>(resolve => { resolveOld = resolve; }));
    const tab: WorkspaceTab = { id: "a", kind: "table-data", title: "customers", table: "customers", connectionId: "c1" };
    const view = render(<TableDataView tab={tab} />);
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("Alice"));
    view.rerender(<TableDataView tab={{ ...tab, id: "b", title: "orders", table: "orders" }} />);
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("99.5"));
    await act(async () => resolveOld(999));
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });
  it("replaces metadata when the same component instance receives another table", async () => {
    const customers: WorkspaceTab = {
      id: "data:c1:main:customers",
      kind: "table-data",
      title: "customers",
      connectionId: "c1",
      schema: "main",
      table: "customers",
    };
    const orders: WorkspaceTab = {
      ...customers,
      id: "data:c1:main:orders",
      title: "orders",
      table: "orders",
    };

    const view = render(<TableDataView tab={customers} />);
    await waitFor(() =>
      expect(screen.getByTestId("column-names")).toHaveTextContent("id,name")
    );

    view.rerender(<TableDataView tab={orders} />);

    await waitFor(() =>
      expect(screen.getByTestId("column-names")).toHaveTextContent("id,amount")
    );
    expect(screen.getByTestId("column-names")).not.toHaveTextContent("name");
  });
});
