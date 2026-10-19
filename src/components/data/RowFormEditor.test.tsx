import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowFormEditor, base64FromHex, binaryPayloadExceedsEditLimit, MAX_BINARY_EDIT_BYTES } from "./RowFormEditor";
import type { GridRow } from "./TableDataGrid";
import type { ColumnInfo } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const onCellEdit = vi.fn();
const onRowDelete = vi.fn();
const onRowRevert = vi.fn();
const row = (values: unknown[]): GridRow => ({ key: "row-1", values, kind: "existing" });
const column = (name: string, data_type: string, nullable = true): ColumnInfo => ({
  name, data_type, nullable, is_primary_key: false, default_value: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("RowFormEditor", () => {
  it("preserves unsafe-to-number BIGINT edits as exact decimal strings", () => {
    render(<RowFormEditor columns={[column("id", "BIGINT", false)]} rows={[row(["9007199254740993"])]} editable onCellEdit={onCellEdit} onRowDelete={onRowDelete} onRowRevert={onRowRevert} />);
    const input = screen.getByRole("textbox", { name: "id" });
    fireEvent.change(input, { target: { value: "9007199254740994" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onCellEdit).toHaveBeenCalledWith("row-1", 0, "9007199254740994");
  });

  it("commits NULL from the explicit nullable control", () => {
    onCellEdit.mockClear();
    render(<RowFormEditor columns={[column("name", "TEXT")]} rows={[row(["Alice"])]} editable onCellEdit={onCellEdit} onRowDelete={onRowDelete} onRowRevert={onRowRevert} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCellEdit).toHaveBeenCalledWith("row-1", 0, null);
  });

  it("edits binary data through validated hexadecimal bytes", () => {
    onCellEdit.mockClear();
    render(<RowFormEditor columns={[column("payload", "BLOB")]} rows={[row([{ $binary: "AP8=" }])]} editable onCellEdit={onCellEdit} onRowDelete={onRowDelete} onRowRevert={onRowRevert} />);
    const input = screen.getByRole("textbox", { name: "Hexadecimal content" });
    expect(input).toHaveValue("00 ff");
    fireEvent.change(input, { target: { value: "01 02" } });
    fireEvent.blur(input);
    expect(onCellEdit).toHaveBeenCalledWith("row-1", 0, { $binary: "AQI=" });
    expect(base64FromHex("01 02")).toBe("AQI=");
  });

  it("refuses to expand binary values above the edit budget", () => {
    const fullGroups = Math.floor(MAX_BINARY_EDIT_BYTES / 3) * 4;
    // 8 MiB ends with two bytes and one padding character. One extra byte
    // fits in the same encoded character count, but has no padding.
    expect(binaryPayloadExceedsEditLimit("A".repeat(fullGroups) + "AAA=")).toBe(false);
    expect(binaryPayloadExceedsEditLimit("A".repeat(fullGroups) + "AAAA")).toBe(true);
    expect(binaryPayloadExceedsEditLimit("A".repeat(Math.ceil(MAX_BINARY_EDIT_BYTES / 3) * 4 + 1))).toBe(true);
    expect(binaryPayloadExceedsEditLimit("AA==")).toBe(false);
  });

  it("shows a PNG preview as a base64 data URL and omits previews for other files", () => {
    // Use the application's valid PNG asset rather than a header-only sample.
    const png = readFileSync("src/assets/mark.png").toString("base64");
    const { rerender } = render(<RowFormEditor columns={[column("payload", "BLOB")]} rows={[row([{ $binary: png }])]} editable onCellEdit={onCellEdit} onRowDelete={onRowDelete} onRowRevert={onRowRevert} />);
    expect(screen.getByRole("img", { name: "Image preview" })).toHaveAttribute("src", `data:image/png;base64,${png}`);

    rerender(<RowFormEditor columns={[column("payload", "BLOB")]} rows={[row([{ $binary: "AP8=" }])]} editable onCellEdit={onCellEdit} onRowDelete={onRowDelete} onRowRevert={onRowRevert} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps binary values read-only when the row is not editable", () => {
    onCellEdit.mockClear();
    render(<RowFormEditor columns={[column("payload", "BLOB")]} rows={[row([{ $binary: "AP8=" }])]} editable={false} onCellEdit={onCellEdit} onRowDelete={onRowDelete} onRowRevert={onRowRevert} />);
    const input = screen.getByRole("textbox", { name: "Hexadecimal content" });
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Load from file" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "01 02" } });
    fireEvent.blur(input);
    expect(onCellEdit).not.toHaveBeenCalled();
  });

  it("stacks row fields when the measured form container is narrow", () => {
    let resize!: ResizeObserverCallback;
    let observed: Element | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(target: Element) {
        observed = target;
        resize([{ target, contentRect: { width: 800 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    });
    render(<RowFormEditor columns={[column("name", "TEXT")]} rows={[row(["Alice"])]} editable onCellEdit={onCellEdit} onRowDelete={onRowDelete} onRowRevert={onRowRevert} />);
    const input = screen.getByRole("textbox", { name: "name" });
    expect(observed).not.toBeNull();
    expect(input.closest(".grid")).toHaveClass("grid-cols-[200px_minmax(0,1fr)]");
    act(() => resize([{ target: observed!, contentRect: { width: 400 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(input.closest(".grid")).toHaveClass("grid-cols-1");
    expect(screen.getByRole("button", { name: "Revert row" }).parentElement).toHaveClass("flex-wrap");
  });

  it("does not apply a pending file read after the row becomes read-only", async () => {
    const openMock = vi.mocked(open);
    const invokeMock = vi.mocked(invoke);
    openMock.mockResolvedValue("/tmp/value.bin");
    let finishRead!: (value: string) => void;
    invokeMock.mockReturnValue(new Promise<string>((resolve) => { finishRead = resolve; }));
    onCellEdit.mockClear();
    const props = {
      columns: [column("payload", "BLOB")],
      rows: [row([{ $binary: "AP8=" }])],
      onCellEdit,
      onRowDelete,
      onRowRevert,
    };
    const { rerender } = render(<RowFormEditor {...props} editable />);
    fireEvent.click(screen.getByRole("button", { name: "Load from file" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("read_binary_file", { path: "/tmp/value.bin" }));

    rerender(<RowFormEditor {...props} editable={false} />);
    await act(async () => { finishRead("AQI="); });
    expect(onCellEdit).not.toHaveBeenCalled();
  });
});
