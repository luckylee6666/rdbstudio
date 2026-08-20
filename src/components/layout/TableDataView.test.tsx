import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TableDataView } from "./TableDataView";
import type { WorkspaceTab } from "@/types";

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
  TableDataGrid: ({ columns }: { columns: Array<{ name: string }> }) => (
    <div data-testid="column-names">{columns.map((column) => column.name).join(",")}</div>
  ),
}));

describe("TableDataView table identity", () => {
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
