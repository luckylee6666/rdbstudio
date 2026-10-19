import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useI18n } from "@/store/i18n";
import { TableMaintenanceDialog } from "./TableMaintenanceDialog";

describe("TableMaintenanceDialog", () => {
  beforeEach(() => useI18n.setState({ lang: "en" }));

  it.each([
    ["mysql", "analyze_table", "tenant", "orders"],
    ["mysql", "optimize_table", "tenant", "orders"],
    ["sqlite", "vacuum_database", "main", null],
  ] as const)("passes action and target arguments for %s %s", async (driver, action, schema, table) => {
    const calls: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "maintain_table") {
        calls.push(payload);
        return { message: "completed", elapsed_ms: 12 };
      }
      return undefined;
    });
    render(
      <TableMaintenanceDialog
        connectionId="conn-7"
        driver={driver}
        schema={schema}
        table="orders"
        onClose={vi.fn()}
      />
    );

    if (action !== "analyze_table") {
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: action },
      });
    }
    fireEvent.click(screen.getAllByRole("button")[2]);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      id: "conn-7",
      action,
      schema,
      table,
    });
  });

  it("prevents every close path while maintenance is running", async () => {
    let finish!: (value: { message: string; elapsed_ms: number }) => void;
    const onClose = vi.fn();
    mockIPC((command) => {
      if (command === "maintain_table") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return undefined;
    });
    render(
      <TableMaintenanceDialog
        connectionId="conn-7"
        driver="postgres"
        schema="tenant"
        table="orders"
        onClose={onClose}
      />
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button")[2]);
    await waitFor(() => expect(finish).toBeTypeOf("function"));

    expect(within(dialog).getAllByRole("button")[1]).toBeDisabled();
    expect(within(dialog).getAllByRole("button")[2]).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: /Close:/ })
    ).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(document.querySelector(".absolute.inset-0")!);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finish({ message: "done", elapsed_ms: 1 }));
  });

  it("shows backend failures in the dialog", async () => {
    mockIPC((command) => {
      if (command === "maintain_table") return Promise.reject("maintenance failed");
      return undefined;
    });
    render(
      <TableMaintenanceDialog
        connectionId="conn-7"
        driver="mysql"
        schema="tenant"
        table="orders"
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getAllByRole("button")[2]);
    expect(await screen.findByRole("alert")).toHaveTextContent("maintenance failed");
  });
});
