import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useI18n } from "@/store/i18n";
import { ExportDialog } from "./ExportDialog";

describe("ExportDialog SQL contents", () => {
  beforeEach(() => useI18n.setState({ lang: "zh" }));

  it.each([
    ["表结构和数据", true, true],
    ["仅表结构", true, false],
    ["仅数据", false, true],
  ])("maps %s to the backend export flags", async (_label, includeDdl, includeData) => {
    const calls: Array<Record<string, unknown>> = [];
    mockIPC((command, payload) => {
      if (command === "export_table") {
        calls.push(payload as Record<string, unknown>);
        return { rows_written: includeData ? 3 : 0, bytes: 128, elapsed_ms: 1 };
      }
      return undefined;
    });

    render(
      <ExportDialog
        open
        connectionId="conn-1"
        schema="public"
        table="users"
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "导出 · public.users" });
    fireEvent.change(within(dialog).getByDisplayValue("CSV"), {
      target: { value: "sql" },
    });
    fireEvent.change(within(dialog).getByDisplayValue("表结构和数据"), {
      target: {
        value: includeDdl && includeData
          ? "structure_data"
          : includeDdl
          ? "structure_only"
          : "data_only",
      },
    });
    fireEvent.change(
      within(dialog).getByPlaceholderText("/path/to/export.csv"),
      { target: { value: "/tmp/users.sql" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "导出" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const options = calls[0].options as Record<string, unknown>;
    expect(options.include_ddl).toBe(includeDdl);
    expect(options.include_data).toBe(includeData);
    expect(options.format).toBe("sql");
  });
});
