import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import { SchemaObjectTree } from "./SchemaObjectTree";

beforeEach(() => {
  useI18n.setState({ lang: "zh" });
  useConnections.setState({ treeFilter: "" });
  useWorkspace.setState({ tabs: [{ id: "existing", kind: "query", title: "Unsaved" }], activeTabId: "existing" });
  sessionStorage.clear();
});
afterEach(() => clearMocks());

it("loads names lazily and fetches the selected overload definition without executing it", async () => {
  const calls: string[] = [];
  mockIPC((cmd, payload) => {
    calls.push(cmd);
    if (cmd === "list_schema_objects") return { truncated: false, objects: [
      { kind: "function", name: "lookup", schema: "public", identity: "v integer" },
      { kind: "function", name: "lookup", schema: "public", identity: "v text" },
    ] };
    if (cmd === "get_schema_object_definition") {
      expect(payload).toEqual({ id: "c1", object: { kind: "function", name: "lookup", schema: "public", identity: "v text" } });
      return "CREATE FUNCTION lookup(v text) RETURNS text LANGUAGE SQL AS $$ SELECT v $$;";
    }
    throw new Error(`Unexpected IPC: ${cmd}`);
  });
  render(<SchemaObjectTree connectionId="c1" schema="public" />);
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "数据库对象" }));
  fireEvent.doubleClick(await screen.findByRole("button", { name: "lookup(v text)" }));
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
  const { activeTabId, tabs } = useWorkspace.getState();
  expect(tabs[0].id).toBe("existing");
  expect(sessionStorage.getItem(`rdb:sql:${activeTabId}`)).toContain("lookup(v text)");
  expect(calls).toEqual(["list_schema_objects", "get_schema_object_definition"]);
});

it.each(["Enter", " "])("opens an object definition with the %s key without executing it", async (key) => {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "list_schema_objects") return { truncated: false, objects: [
      { kind: "sequence", name: "counter", schema: "public" },
    ] };
    if (cmd === "get_schema_object_definition") return "CREATE SEQUENCE counter;";
    throw new Error(`Unexpected IPC: ${cmd}`);
  });
  render(<SchemaObjectTree connectionId="c1" schema="public" />);
  fireEvent.click(screen.getByRole("button", { name: "数据库对象" }));
  const object = await screen.findByRole("button", { name: "counter" });
  const event = createEvent.keyDown(object, { key, repeat: false });
  fireEvent(object, event);

  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
  const { activeTabId, tabs } = useWorkspace.getState();
  expect(tabs[0].id).toBe("existing");
  expect(sessionStorage.getItem(`rdb:sql:${activeTabId}`)).toBe("CREATE SEQUENCE counter;");
  expect(calls).toEqual(["list_schema_objects", "get_schema_object_definition"]);
  expect(calls).not.toContain("execute_query");
  expect(calls).not.toContain("execute_script");
  if (key === " ") expect(event.defaultPrevented).toBe(true);
});

it("opens matching groups while filtering and reports a truncated catalog", async () => {
  useConnections.setState({ treeFilter: "tick" });
  mockIPC(() => ({ truncated: true, objects: [
    { kind: "event", name: "daily_tick", schema: "app" },
    { kind: "function", name: "unrelated", schema: "app" },
  ] }));
  render(<SchemaObjectTree connectionId="c1" schema="app" />);
  expect(await screen.findByRole("button", { name: "daily_tick" })).toBeInTheDocument();
  expect(screen.queryByText("unrelated")).not.toBeInTheDocument();
  expect(screen.getByText(/仅显示前 500/)).toBeInTheDocument();
});

it("keeps the error visible and does not open an empty query when an object disappeared", async () => {
  mockIPC((cmd) => {
    if (cmd === "list_schema_objects") return { truncated: false, objects: [{ kind: "sequence", name: "counter", schema: "public" }] };
    throw new Error("sequence no longer exists");
  });
  render(<SchemaObjectTree connectionId="c1" schema="public" />);
  fireEvent.click(screen.getByRole("button", { name: "数据库对象" }));
  fireEvent.doubleClick(await screen.findByRole("button", { name: "counter" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("sequence no longer exists");
  expect(useWorkspace.getState().tabs).toHaveLength(1);
});

it.each(["event", "sequence"])("opens %s management with the exact connection and schema", async (kind) => {
  mockIPC(() => ({ truncated: false, objects: [{ kind, name: "selected", schema: "tenant" }] }));
  render(<SchemaObjectTree connectionId="target" schema="tenant" />);
  fireEvent.click(screen.getByRole("button", { name: "数据库对象" }));
  fireEvent.contextMenu(await screen.findByRole("button", { name: "selected" }));
  fireEvent.click(screen.getByRole("button", { name: "管理对象" }));
  expect(useWorkspace.getState().tabs.at(-1)).toMatchObject({
    kind: "objects", connectionId: "target", schema: "tenant", objectKind: kind, objectName: "selected",
  });
});
