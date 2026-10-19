import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useI18n } from "@/store/i18n";
import { SequenceManager, type SequenceOptions } from "./SequenceManager";

const options: SequenceOptions = {
  schema: "public",
  name: "order_ids",
  data_type: "bigint",
  start: "9007199254740993123",
  increment: "2",
  min: "1",
  max: "9223372036854775807",
  cache: "8",
  cycle: false,
};

beforeEach(() => useI18n.setState({ lang: "en" }));
afterEach(() => clearMocks());

describe("SequenceManager", () => {
  it("filters the schema catalog and loads exact sequence options", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "list_schema_objects") return { objects: [
        { kind: "function", name: "next_order", schema: "public" },
        { kind: "sequence", name: "order_ids", schema: "public" },
      ], truncated: false };
      if (command === "get_sequence_options") return options;
      return undefined;
    });

    render(<SequenceManager connectionId="pg-1" schema="public" />);
    fireEvent.click(await screen.findByRole("button", { name: /order_ids/ }));
    expect(await screen.findByRole("textbox", { name: "Start value" })).toHaveValue(options.start);
    expect(screen.queryByRole("button", { name: /next_order/ })).toBeNull();
    expect(calls).toContainEqual({ command: "get_sequence_options", payload: { id: "pg-1", schema: "public", name: "order_ids" } });
  });

  it("creates a sequence while preserving large numeric values as strings", async () => {
    let saved: Record<string, unknown> | undefined;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: [], truncated: false };
      if (command === "save_sequence") { saved = payload as Record<string, unknown>; return null; }
      return undefined;
    });
    render(<SequenceManager connectionId="pg-1" schema="public" />);
    fireEvent.click(await screen.findByRole("button", { name: "New sequence" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "order_ids" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Start value" }), { target: { value: ` ${options.start} ` } });
    fireEvent.change(screen.getByRole("textbox", { name: "Maximum" }), { target: { value: ` ${options.max} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Create sequence" }));

    await waitFor(() => expect(saved).toBeDefined());
    expect(saved).toEqual({
      id: "pg-1",
      options: { ...options, increment: "1", cache: "1" },
      create: true,
      restart: null,
    });
  });

  it("confirms restart before sending the numeric restart string", async () => {
    let saved: Record<string, unknown> | undefined;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "sequence", name: options.name, schema: options.schema }], truncated: false };
      if (command === "get_sequence_options") return options;
      if (command === "save_sequence") { saved = payload as Record<string, unknown>; return null; }
      return undefined;
    });
    render(<SequenceManager connectionId="pg-1" schema="public" initialName={options.name} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Restart the sequence after saving" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Restart at" }), { target: { value: "9007199254740993125" } });
    fireEvent.click(screen.getByRole("button", { name: "Save options" }));

    expect(await screen.findByText(/Restarting can reuse numbers/)).toBeInTheDocument();
    expect(saved).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Restart sequence" }));
    await waitFor(() => expect(saved).toMatchObject({ create: false, restart: "9007199254740993125" }));
    expect((saved?.options as SequenceOptions).start).toBe(options.start);
  });

  it("requires a second confirmation before dropping a sequence", async () => {
    let dropped: Record<string, unknown> | undefined;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "sequence", name: options.name, schema: options.schema }], truncated: false };
      if (command === "get_sequence_options") return options;
      if (command === "drop_sequence") { dropped = payload as Record<string, unknown>; return null; }
      return undefined;
    });
    render(<SequenceManager connectionId="pg-1" schema="public" initialName={options.name} />);
    fireEvent.click(await screen.findByRole("button", { name: "Drop sequence" }));
    expect(dropped).toBeUndefined();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Drop sequence" }));
    await waitFor(() => expect(dropped).toEqual({ id: "pg-1", schema: "public", name: "order_ids" }));
  });

  it("preserves the exact schema and quoted sequence name when saving an existing object", async () => {
    const spaced: SequenceOptions = { ...options, schema: " app ", name: " order ids " };
    let saved: Record<string, unknown> | undefined;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "sequence", name: spaced.name, schema: spaced.schema }], truncated: false };
      if (command === "get_sequence_options") return spaced;
      if (command === "save_sequence") { saved = payload as Record<string, unknown>; return null; }
      return undefined;
    });
    render(<SequenceManager connectionId="pg-1" schema="public" initialName={spaced.name} />);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(spaced.name);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save options" }));

    await waitFor(() => expect(saved).toBeDefined());
    expect((saved?.options as SequenceOptions).schema).toBe(spaced.schema);
    expect((saved?.options as SequenceOptions).name).toBe(spaced.name);
  });

  it("does not let a stale catalog response replace a newly selected connection", async () => {
    let finishOld!: (value: { objects: Array<{ kind: string; name: string; schema: string }>; truncated: boolean }) => void;
    mockIPC((command, payload) => {
      if (command !== "list_schema_objects") return undefined;
      if ((payload as { id: string }).id === "pg-old") return new Promise((resolve) => { finishOld = resolve; });
      return { objects: [{ kind: "sequence", name: "new_target", schema: "public" }], truncated: false };
    });
    const view = render(<SequenceManager connectionId="pg-old" schema="public" />);
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    view.rerender(<SequenceManager connectionId="pg-new" schema="public" />);
    expect(await screen.findByRole("button", { name: /new_target/ })).toBeInTheDocument();
    await act(async () => finishOld({ objects: [{ kind: "sequence", name: "stale_target", schema: "public" }], truncated: false }));
    expect(screen.queryByRole("button", { name: /stale_target/ })).toBeNull();
  });

  it("keeps a read-only connection viewable but disables mutations", async () => {
    mockIPC((command) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "sequence", name: options.name, schema: options.schema }], truncated: false };
      if (command === "get_sequence_options") return options;
      return undefined;
    });
    render(<SequenceManager connectionId="pg-1" schema="public" readOnly initialName={options.name} />);
    expect(await screen.findByRole("textbox", { name: "Start value" })).toHaveValue(options.start);
    expect(screen.getByRole("button", { name: "New sequence" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save options" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Drop sequence" })).toBeNull();
  });
});
