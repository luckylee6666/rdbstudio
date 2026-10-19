import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useI18n } from "@/store/i18n";
import { CopyTableDialog } from "./CopyTableDialog";

afterEach(clearMocks);

const nativePreview = {
  token: "native-preview",
  plan: { statements: ["CREATE TABLE items_copy AS SELECT * FROM items"], warnings: ["Triggers are not copied"], transactional: true },
};

describe("native table copies", () => {
  beforeEach(() => useI18n.setState({ lang: "en" }));

  it("uses native preview and copies more than the portable row limit", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    const onCopied = vi.fn();
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "preview_native_copy") return nativePreview;
      if (command === "apply_native_copy") return { rows_copied: 12001, elapsed_ms: 20 };
      return null;
    });
    render(<CopyTableDialog connectionId="native" schema="tenant" table="items" onClose={vi.fn()} onCopied={onCopied} />);
    expect(screen.getByRole("combobox", { name: "Copy method" })).toHaveValue("native");
    fireEvent.click(screen.getByRole("button", { name: "Preview copy" }));
    expect(await screen.findByText("Triggers are not copied")).toBeInTheDocument();
    expect(calls[0]).toEqual({ command: "preview_native_copy", payload: { id: "native", request: { schema: "tenant", source_table: "items", target_table: "items_copy" } } });
    fireEvent.click(screen.getByRole("button", { name: "Create table and copy" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("12001"));
    expect(calls.find((call) => call.command === "apply_native_copy")?.payload).toMatchObject({ token: "native-preview", operationId: expect.any(String) });
    expect(calls.some((call) => call.command === "apply_data_sync")).toBe(false);
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("requests cancellation with the operation id and keeps the dialog locked until cleanup finishes", async () => {
    let failCopy!: (error: Error) => void;
    let operationId: string | undefined;
    let cancelledId: string | undefined;
    const onClose = vi.fn();
    const onCopied = vi.fn();
    mockIPC((command, payload) => {
      if (command === "preview_native_copy") return nativePreview;
      if (command === "apply_native_copy") {
        operationId = (payload as { operationId: string }).operationId;
        return new Promise((_resolve, reject) => { failCopy = reject; });
      }
      if (command === "native_copy_progress") return { phase: "copying", elapsed_ms: 500 };
      if (command === "cancel_native_copy") { cancelledId = (payload as { operationId: string }).operationId; return true; }
      return null;
    });
    render(<CopyTableDialog connectionId="native" table="items" onClose={onClose} onCopied={onCopied} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create table and copy" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create table and copy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop copy" }));
    await waitFor(() => expect(cancelledId).toBe(operationId));
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => failCopy(new Error("table copy cancelled")));
    expect(await screen.findByRole("alert")).toHaveTextContent("cancelled");
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("does not accept cancellation once publication has started", async () => {
    let finishCopy!: (report: { rows_copied: number; elapsed_ms: number }) => void;
    const cancelled = vi.fn();
    mockIPC((command) => {
      if (command === "preview_native_copy") return nativePreview;
      if (command === "apply_native_copy") return new Promise((resolve) => { finishCopy = resolve; });
      if (command === "native_copy_progress") return { phase: "finishing", elapsed_ms: 20 };
      if (command === "cancel_native_copy") cancelled();
      return null;
    });
    render(<CopyTableDialog connectionId="native" table="items" onClose={vi.fn()} onCopied={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create table and copy" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create table and copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop copy" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Stop copy" }));
    expect(cancelled).not.toHaveBeenCalled();
    await act(async () => finishCopy({ rows_copied: 10, elapsed_ms: 30 }));
    expect(await screen.findByRole("status")).toHaveTextContent("copied 10 rows");
  });

  it("discards a preview that returns after the target connection changes", async () => {
    let finishOld!: (plan: typeof nativePreview) => void;
    mockIPC((command) => command === "preview_native_copy" ? new Promise((resolve) => { finishOld = resolve; }) : null);
    const { rerender } = render(<CopyTableDialog connectionId="old" table="items" onClose={vi.fn()} onCopied={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview copy" }));
    rerender(<CopyTableDialog connectionId="new" table="items" onClose={vi.fn()} onCopied={vi.fn()} />);
    await act(async () => finishOld(nativePreview));
    expect(screen.getByRole("button", { name: "Create table and copy" })).toBeDisabled();
    expect(screen.queryByText("Triggers are not copied")).not.toBeInTheDocument();
  });

  it("cancels its active operation when unmounted and ignores its late result", async () => {
    let finishCopy!: (report: { rows_copied: number; elapsed_ms: number }) => void;
    let operationId: string | undefined;
    const cancelled = vi.fn();
    const onCopied = vi.fn();
    mockIPC((command, payload) => {
      if (command === "preview_native_copy") return nativePreview;
      if (command === "apply_native_copy") {
        operationId = (payload as { operationId: string }).operationId;
        return new Promise((resolve) => { finishCopy = resolve; });
      }
      if (command === "native_copy_progress") return { phase: "copying", elapsed_ms: 20 };
      if (command === "cancel_native_copy") { cancelled(payload); return true; }
      return null;
    });
    const { unmount } = render(<CopyTableDialog connectionId="native" table="items" onClose={vi.fn()} onCopied={onCopied} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create table and copy" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create table and copy" }));
    await waitFor(() => expect(operationId).toBeTypeOf("string"));
    unmount();
    expect(cancelled).toHaveBeenCalledWith({ operationId });
    await act(async () => finishCopy({ rows_copied: 10, elapsed_ms: 30 }));
    expect(onCopied).not.toHaveBeenCalled();
  });
});

function preview(overrides: Record<string, unknown> = {}) {
  return {
    token: "preview-token",
    source_driver: "mysql",
    target_driver: "mysql",
    structure: {
      source_table: "items",
      target_table: "items_copy",
      target_exists: false,
      changes: [],
      statements: ["CREATE TABLE items_copy (id INT)"],
      supported: true,
      reason: null,
      ddl_transactional: true,
    },
    data_supported: true,
    data_reason: null,
    counts: {
      inserts: 2,
      updates: 0,
      deletes: 0,
      unchanged: 0,
      sample_conflict_keys: [],
    },
    rows_examined: 2,
    bytes_examined: 32,
    ...overrides,
  };
}

function renderDialog(onCopied = vi.fn(), onClose = vi.fn()) {
  render(
    <CopyTableDialog
      connectionId="conn-1"
      schema="public"
      table="items"
      onClose={onClose}
      onCopied={onCopied}
    />
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Copy method" }), { target: { value: "portable" } });
  return {
    dialog: screen.getByRole("dialog"),
    onCopied,
    onClose,
  };
}

describe("CopyTableDialog", () => {
  beforeEach(() => useI18n.setState({ lang: "en" }));

  it("previews a missing target and applies the reviewed copy plan", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    const onCopied = vi.fn();
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "preview_sync") return preview();
      if (command === "apply_data_sync") return { inserted: 2 };
      return undefined;
    });
    const { dialog } = renderDialog(onCopied);

    const buttons = within(dialog).getAllByRole("button");
    fireEvent.click(buttons[2]);
    await waitFor(() => expect(calls.some((call) => call.command === "preview_sync")).toBe(true));
    expect(calls.find((call) => call.command === "preview_sync")?.payload).toEqual({
      request: {
        source_id: "conn-1",
        target_id: "conn-1",
        source_schema: "public",
        target_schema: "public",
        source_table: "items",
        target_table: "items_copy",
        compare_deletes: false,
      },
    });

    const copyButton = within(dialog).getAllByRole("button")[3];
    expect(copyButton).toBeEnabled();
    fireEvent.click(copyButton);
    await waitFor(() =>
      expect(calls.some((call) => call.command === "apply_data_sync")).toBe(true)
    );
    expect(calls.find((call) => call.command === "apply_data_sync")?.payload).toEqual({
      token: "preview-token",
      options: { policy: "insert_only", create_missing_table: true },
    });
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["target exists", { structure: { ...preview().structure, target_exists: true } }],
    ["structure is unsupported", { structure: { ...preview().structure, supported: false, reason: "Cannot recreate this table" } }],
    ["data is unsupported", { data_supported: false, data_reason: "Source rows cannot be copied" }],
  ])("does not allow copying when %s", async (_name, overrides) => {
    mockIPC((command) => (command === "preview_sync" ? preview(overrides) : undefined));
    const { dialog } = renderDialog();
    fireEvent.click(within(dialog).getAllByRole("button")[2]);

    await waitFor(() => {
      expect(within(dialog).getAllByRole("button")[3]).toBeDisabled();
    });
  });

  it("invalidates the reviewed preview when the target name changes", async () => {
    mockIPC((command) => (command === "preview_sync" ? preview() : undefined));
    const { dialog } = renderDialog();
    fireEvent.click(within(dialog).getAllByRole("button")[2]);
    await waitFor(() => expect(within(dialog).getAllByRole("button")[3]).toBeEnabled());

    const input = within(dialog).getByDisplayValue("items_copy");
    fireEvent.change(input, { target: { value: "items_archive" } });
    expect(within(dialog).getAllByRole("button")[3]).toBeDisabled();
    expect(within(dialog).queryByText(/CREATE TABLE/)).not.toBeInTheDocument();
  });

  it("keeps the dialog busy until a pending preview finishes", async () => {
    let finishPreview!: (result: ReturnType<typeof preview>) => void;
    const onClose = vi.fn();
    mockIPC((command) => {
      if (command === "preview_sync") {
        return new Promise((resolve) => {
          finishPreview = resolve;
        });
      }
      return undefined;
    });
    const { dialog } = renderDialog(vi.fn(), onClose);
    fireEvent.click(within(dialog).getAllByRole("button")[2]);
    await waitFor(() => expect(finishPreview).toBeTypeOf("function"));

    expect(within(dialog).getAllByRole("button")[0]).toBeDisabled();
    expect(within(dialog).getAllByRole("button")[1]).toBeDisabled();
    expect(within(dialog).getAllByRole("button")[2]).toBeDisabled();
    expect(within(dialog).getAllByRole("button")[3]).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => finishPreview(preview()));
    expect(onClose).not.toHaveBeenCalled();
  });
});
