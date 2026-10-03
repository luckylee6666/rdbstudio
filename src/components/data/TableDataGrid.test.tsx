import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TableDataGrid, type GridRow } from "./TableDataGrid";
import type { ColumnInfo } from "@/types";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      key: index,
      index,
      start: index * 29,
    })),
  }),
}));

const columns: ColumnInfo[] = [
  { name: "name", data_type: "TEXT", nullable: true, is_primary_key: false, default_value: null },
];
const rows: GridRow[] = [{ key: "row-1", values: ["before"], kind: "existing" }];

describe("TableDataGrid cell editing", () => {
  it("discards an Escape-cancelled draft on subsequent unmount", () => {
    const onCellEdit = vi.fn();
    const view = render(
      <TableDataGrid
        columns={columns}
        rows={rows}
        editable
        onSortClick={vi.fn()}
        onCellEdit={onCellEdit}
        onRowRevert={vi.fn()}
        onRowDelete={vi.fn()}
      />
    );
    fireEvent.doubleClick(screen.getByText("before"));
    const input = screen.getByDisplayValue("before");
    fireEvent.change(input, { target: { value: "cancelled draft" } });
    fireEvent.keyDown(input, { key: "Escape" });
    view.unmount();
    expect(onCellEdit).not.toHaveBeenCalled();
  });
});
