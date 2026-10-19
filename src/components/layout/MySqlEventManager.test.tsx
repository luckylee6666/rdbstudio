import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useI18n } from "@/store/i18n";
import { MySqlEventManager, type EventDetails, type MySqlEventOptions } from "./MySqlEventManager";

const eventOptions: MySqlEventOptions = {
  schema: "app",
  name: "nightly_cleanup",
  schedule: { kind: "every", interval_value: "1", interval_unit: "DAY", starts: "2026-10-20 02:30:00", ends: null },
  body: "DELETE FROM expired_rows WHERE expires_at < NOW()",
  comment: "nightly cleanup",
  preserve: true,
};
const details: EventDetails = {
  options: eventOptions,
  enabled: false,
  definer: "operator@localhost",
  time_zone: "America/Los_Angeles",
  scheduler: "ON",
};

beforeEach(() => useI18n.setState({ lang: "en" }));
afterEach(() => clearMocks());

describe("MySqlEventManager", () => {
  it("keeps an existing compound body unchanged when only its comment is edited", async () => {
    const compound = "BEGIN UPDATE task SET n=1; INSERT INTO audit VALUES (2); END";
    const legacy = { ...details, options: { ...eventOptions, body: compound } };
    let saved: Record<string, unknown> | undefined;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "event", name: eventOptions.name, schema: "app" }], truncated: false };
      if (command === "get_event_options") return legacy;
      if (command === "save_event") { saved = payload as Record<string, unknown>; return legacy; }
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" initialName={eventOptions.name} />);
    expect(await screen.findByRole("textbox", { name: "SQL body" })).toHaveValue(compound);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "new comment" } });
    fireEvent.click(screen.getByRole("button", { name: "Save event" }));
    await waitFor(() => expect(saved).toBeDefined());
    expect(saved).toMatchObject({ create: false, options: { body: compound, comment: "new comment", schedule: eventOptions.schedule } });
  });
  it("filters events, loads options, and displays server metadata", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "list_schema_objects") return { objects: [
        { kind: "procedure", name: "cleanup_proc", schema: "app" },
        { kind: "event", name: eventOptions.name, schema: "app" },
      ], truncated: false };
      if (command === "get_event_options") return details;
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" />);

    fireEvent.click(await screen.findByRole("button", { name: /nightly_cleanup/ }));
    expect(await screen.findByRole("textbox", { name: "SQL body" })).toHaveValue(eventOptions.body);
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
    expect(screen.getByText("operator@localhost")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cleanup_proc/ })).toBeNull();
    expect(calls).toContainEqual({ command: "get_event_options", payload: { id: "mysql-1", schema: "app", name: eventOptions.name } });
  });

  it("creates a disabled recurring event with string interval and server-time fields", async () => {
    let saved: { command: string; payload: Record<string, unknown> } | undefined;
    let created = false;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: created ? [{ kind: "event", name: "nightly_cleanup", schema: "app" }] : [], truncated: false };
      if (command === "save_event") {
        created = true;
        saved = { command, payload: payload as Record<string, unknown> };
        return { ...details, options: (payload as { options: MySqlEventOptions }).options, enabled: false };
      }
      if (command === "get_event_options") return { ...details, enabled: false };
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" />);
    fireEvent.click(await screen.findByRole("button", { name: "New event" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "nightly_cleanup" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Every" }), { target: { value: " 9007199254740993 " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Starts" }), { target: { value: "2026-10-20 02:30:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(saved).toBeDefined());
    expect(saved).toEqual({
      command: "save_event",
      payload: {
        id: "mysql-1",
        create: true,
        options: {
          schema: "app",
          name: "nightly_cleanup",
          schedule: { kind: "every", interval_value: "9007199254740993", interval_unit: "DAY", starts: "2026-10-20 02:30:00", ends: null },
          body: "SELECT 1",
          comment: "",
          preserve: true,
        },
      },
    });
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable event" })).toBeInTheDocument();
  });

  it("requires confirmation before enabling a scheduled event", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "list_schema_objects") return { objects: [{ kind: "event", name: eventOptions.name, schema: "app" }], truncated: false };
      if (command === "get_event_options") return { ...details, scheduler: "OFF" };
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" initialName={eventOptions.name} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable event" }));
    expect(await screen.findByText(/only be marked enabled; an administrator must start/)).toBeInTheDocument();
    expect(calls.some((call) => call.command === "set_event_enabled")).toBe(false);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Enable event" }));
    await waitFor(() => expect(calls).toContainEqual({
      command: "set_event_enabled",
      payload: { id: "mysql-1", schema: "app", name: eventOptions.name, enabled: true },
    }));
  });

  it("requires a second confirmation before dropping an event", async () => {
    let dropped: unknown;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "event", name: eventOptions.name, schema: "app" }], truncated: false };
      if (command === "get_event_options") return details;
      if (command === "drop_event") { dropped = payload; return null; }
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" initialName={eventOptions.name} />);
    fireEvent.click(await screen.findByRole("button", { name: "Drop event" }));
    expect(dropped).toBeUndefined();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Drop event" }));
    await waitFor(() => expect(dropped).toEqual({ id: "mysql-1", schema: "app", name: eventOptions.name }));
  });

  it("preserves exact schema and event identifier when saving an existing event", async () => {
    const spacedOptions: MySqlEventOptions = { ...eventOptions, schema: " app ", name: " nightly event " };
    let saved: Record<string, unknown> | undefined;
    mockIPC((command, payload) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "event", name: spacedOptions.name, schema: spacedOptions.schema }], truncated: false };
      if (command === "get_event_options") return { ...details, options: spacedOptions };
      if (command === "save_event") { saved = payload as Record<string, unknown>; return { ...details, options: spacedOptions }; }
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" initialName={spacedOptions.name} />);
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(spacedOptions.name);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save event" }));

    await waitFor(() => expect(saved).toBeDefined());
    expect((saved?.options as MySqlEventOptions).schema).toBe(spacedOptions.schema);
    expect((saved?.options as MySqlEventOptions).name).toBe(spacedOptions.name);
  });

  it("rejects malformed server-time input without saving", async () => {
    let saveCalled = false;
    mockIPC((command) => {
      if (command === "list_schema_objects") return { objects: [], truncated: false };
      if (command === "save_event") { saveCalled = true; return details; }
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" />);
    fireEvent.click(await screen.findByRole("button", { name: "New event" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "once" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Schedule" }), { target: { value: "at" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Run at" }), { target: { value: "2026-10-20T02:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("YYYY-MM-DD HH:MM:SS");
    expect(saveCalled).toBe(false);
  });

  it("does not apply a stale catalog response after changing connection", async () => {
    let finishOld!: (value: { objects: Array<{ kind: string; name: string; schema: string }>; truncated: boolean }) => void;
    mockIPC((command, payload) => {
      if (command !== "list_schema_objects") return undefined;
      if ((payload as { id: string }).id === "mysql-old") return new Promise((resolve) => { finishOld = resolve; });
      return { objects: [{ kind: "event", name: "new_target", schema: "app" }], truncated: false };
    });
    const view = render(<MySqlEventManager connectionId="mysql-old" schema="app" />);
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    view.rerender(<MySqlEventManager connectionId="mysql-new" schema="app" />);
    expect(await screen.findByRole("button", { name: /new_target/ })).toBeInTheDocument();
    await act(async () => finishOld({ objects: [{ kind: "event", name: "stale_target", schema: "app" }], truncated: false }));
    expect(screen.queryByRole("button", { name: /stale_target/ })).toBeNull();
  });

  it("keeps read-only events visible while disabling mutations", async () => {
    mockIPC((command) => {
      if (command === "list_schema_objects") return { objects: [{ kind: "event", name: eventOptions.name, schema: "app" }], truncated: false };
      if (command === "get_event_options") return details;
      return undefined;
    });
    render(<MySqlEventManager connectionId="mysql-1" schema="app" readOnly initialName={eventOptions.name} />);
    expect(await screen.findByRole("textbox", { name: "SQL body" })).toHaveValue(eventOptions.body);
    expect(screen.getByRole("button", { name: "New event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save event" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Enable event" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Drop event" })).toBeNull();
  });
});
