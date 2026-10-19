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

  it("requests cancellation and keeps the dialog open until the dump settles", async () => {
    let rejectDump!: (reason: string) => void;
    const operationIds: string[] = [];
    const onClose = vi.fn();
    mockIPC((command, payload) => {
      if (command === "dump_database") {
        return new Promise((_, reject) => {
          rejectDump = reject;
        });
      }
      if (command === "cancel_db_io") {
        operationIds.push((payload as { operationId: string }).operationId);
        return true;
      }
      return undefined;
    });

    render(
      <DatabaseExportDialog
        open
        connectionId="conn-1"
        driver="mysql"
        database="app"
        onClose={onClose}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "导出数据库 · app" });
    fireEvent.change(
      within(dialog).getByPlaceholderText("/path/to/export.csv"),
      { target: { value: "/tmp/app.sql" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "导出" }));
    await waitFor(() => expect(rejectDump).toBeTypeOf("function"));

    fireEvent.click(within(dialog).getByRole("button", { name: "停止导出" }));
    await waitFor(() => expect(operationIds).toHaveLength(1));
    expect(operationIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(
      within(dialog).getByRole("button", { name: "正在停止导出…" })
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "关闭: 导出数据库 · app" })
    ).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      rejectDump("cancelled by backend");
    });
    expect(await within(dialog).findByText("导出已取消")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the dump failure when cancellation was requested but another error ended it", async () => {
    let rejectDump!: (reason: string) => void;
    mockIPC((command) => {
      if (command === "dump_database") {
        return new Promise((_, reject) => {
          rejectDump = reject;
        });
      }
      if (command === "cancel_db_io") return true;
      return undefined;
    });

    render(
      <DatabaseExportDialog
        open
        connectionId="conn-1"
        driver="postgres"
        database="public"
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "导出 Schema · public" });
    fireEvent.change(
      within(dialog).getByPlaceholderText("/path/to/export.csv"),
      { target: { value: "/tmp/app.sql" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "导出" }));
    await waitFor(() => expect(rejectDump).toBeTypeOf("function"));
    fireEvent.click(within(dialog).getByRole("button", { name: "停止导出" }));
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "正在停止导出…" })
      ).toBeDisabled()
    );

    await act(async () => {
      rejectDump("failed to write dump: permission denied");
    });
    expect(
      await within(dialog).findByText(
        "failed to write dump: permission denied"
      )
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("导出已取消")).not.toBeInTheDocument();
  });
});
