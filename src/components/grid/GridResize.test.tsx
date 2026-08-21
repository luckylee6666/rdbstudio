import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataGrid } from "./DataGrid";
import { TableDataGrid } from "@/components/data/TableDataGrid";

function resizer(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(".cursor-col-resize");
  if (!element) throw new Error("column resizer not found");
  return element;
}

describe("grid column resizing", () => {
  it("stops query-result resizing when the window loses focus", () => {
    const { container } = render(
      <DataGrid columns={[{ name: "id" }]} rows={[]} />
    );
    const handle = resizer(container);
    const header = handle.parentElement!;

    expect(header).toHaveStyle({ width: "160px" });
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent(window, new Event("blur"));
    fireEvent.mouseMove(window, { clientX: 260 });

    expect(header).toHaveStyle({ width: "160px" });
  });

  it("stops table-data resizing when the window loses focus", () => {
    const { container } = render(
      <TableDataGrid
        columns={[
          {
            name: "id",
            data_type: "int",
            nullable: false,
            is_primary_key: true,
          },
        ]}
        rows={[]}
        editable
        onSortClick={() => undefined}
        onCellEdit={() => undefined}
        onRowRevert={() => undefined}
        onRowDelete={() => undefined}
      />
    );
    const handle = resizer(container);
    const header = handle.parentElement!;

    expect(header).toHaveStyle({ width: "160px" });
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent(window, new Event("blur"));
    fireEvent.mouseMove(window, { clientX: 260 });

    expect(header).toHaveStyle({ width: "160px" });
  });
});
