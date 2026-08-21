import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useI18n } from "@/store/i18n";
import { DatabaseExportDialog } from "./DatabaseExportDialog";

describe("DatabaseExportDialog", () => {
  beforeEach(() => useI18n.setState({ lang: "zh" }));

  it.each([
    ["structure_data", false],
    ["structure_only", true],
  ])("exports one selected database with %s", async (content, schemaOnly) => {
    const calls: Array<Record<string, unknown>> = [];
    mockIPC((command, payload) => {
      if (command === "dump_database") {
        calls.push(payload as Record<string, unknown>);
        return { path: "/tmp/app.sql", bytes: 128, elapsed_ms: 2 };
      }
      return undefined;
    });

    render(
      <DatabaseExportDialog
        open
        connectionId="conn-1"
        driver="mysql"
        database="app"
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", {
      name: "导出数据库 · app",
    });
    fireEvent.change(within(dialog).getByDisplayValue("表结构和数据"), {
      target: { value: content },
    });
    fireEvent.change(
      within(dialog).getByPlaceholderText("/path/to/export.csv"),
      { target: { value: "/tmp/app.sql" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "导出" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      id: "conn-1",
      destPath: "/tmp/app.sql",
      database: "app",
      schemaOnly,
    });
  });
});
