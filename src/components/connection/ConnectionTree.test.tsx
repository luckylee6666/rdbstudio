import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useToasts } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";
import { ConnectionTree } from "./ConnectionTree";

const connections: ConnectionConfig[] = [
  {
    id: "local",
    name: "local-9.0",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    group: null,
    ssl_mode: "disable",
  },
  {
    id: "grouped",
    name: "思誉-工具",
    driver: "mysql",
    host: "db.internal",
    port: 3306,
    username: "root",
    group: "思誉",
    ssl_mode: "disable",
  },
];

const originalElementFromPoint = document.elementFromPoint;

function installDropTarget(group: string) {
  const zone = document.querySelector(`[data-conn-drop="${group}"]`);
  if (!(zone instanceof Element)) throw new Error(`missing drop target ${group}`);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => zone,
  });
}

function startDraggingLocal() {
  const row = screen.getByText("local-9.0").closest("button");
  if (!row) throw new Error("missing connection row");
  fireEvent.mouseDown(row, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 120, clientY: 120 });
}

describe("ConnectionTree connection dragging", () => {
  beforeEach(() => {
    clearMocks();
    localStorage.clear();
    useI18n.setState({ lang: "zh" });
    useToasts.setState({ items: [] });
    useConnections.setState({
      list: connections,
      loaded: true,
      status: {},
      versions: {},
      branches: {},
      errors: {},
      treeFilter: "",
    });
    useWorkspace.setState({
      tabs: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeTabId: "welcome",
    });
  });

  afterEach(() => {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalElementFromPoint,
    });
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    clearMocks();
  });

  it("shows the target preview and confirms a successful move", async () => {
    const saved: ConnectionConfig[] = [];
    mockIPC((command, payload) => {
      if (command === "list_connections") return connections;
      if (command === "save_connection") {
        const config = (payload as { config: ConnectionConfig }).config;
        saved.push(config);
        return config;
      }
      return undefined;
    });

    render(<ConnectionTree />);
    installDropTarget("思誉");
    startDraggingLocal();

    expect(screen.getByText("移到「思誉」")).toBeInTheDocument();
    expect(document.body.style.cursor).toBe("grabbing");

    fireEvent.mouseUp(window, { clientX: 120, clientY: 120 });

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].group).toBe("思誉");
    expect(useToasts.getState().items.at(-1)?.title).toBe("已移到「思誉」");
    expect(document.body.style.cursor).toBe("");
  });

  it("cancels cleanly when the window loses focus", async () => {
    let saveCalls = 0;
    mockIPC((command) => {
      if (command === "list_connections") return connections;
      if (command === "save_connection") saveCalls += 1;
      return undefined;
    });

    render(<ConnectionTree />);
    installDropTarget("思誉");
    startDraggingLocal();
    expect(screen.getByText("移到「思誉」")).toBeInTheDocument();

    fireEvent.blur(window);

    await waitFor(() =>
      expect(screen.queryByText("移到「思誉」")).not.toBeInTheDocument()
    );
    expect(saveCalls).toBe(0);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("keeps the connection in place and reports a failed move", async () => {
    mockIPC((command) => {
      if (command === "list_connections") return connections;
      if (command === "save_connection") throw new Error("disk full");
      return undefined;
    });

    render(<ConnectionTree />);
    installDropTarget("思誉");
    startDraggingLocal();
    fireEvent.mouseUp(window, { clientX: 120, clientY: 120 });

    await waitFor(() =>
      expect(useToasts.getState().items.at(-1)?.title).toBe("移动连接失败")
    );
    expect(useConnections.getState().list.find((item) => item.id === "local")?.group).toBeNull();
  });
});

describe("ConnectionTree table operations", () => {
  beforeEach(() => {
    clearMocks();
    useI18n.setState({ lang: "zh" });
    useToasts.setState({ items: [] });
    useConnections.setState({
      list: [connections[0]],
      loaded: true,
      status: { local: "connected" },
      versions: { local: "9.0" },
      branches: {
        local: {
          databases: ["app"],
          tables: {
            app: [{ name: "users", kind: "table" }],
          },
        },
      },
      errors: {},
      treeFilter: "",
    });
    useWorkspace.setState({
      tabs: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
      activeTabId: "welcome",
    });
  });

  afterEach(() => clearMocks());

  it("renames the selected table with its database scope", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let renamed = false;
    mockIPC((command, payload) => {
      if (command === "list_connections") return [connections[0]];
      if (command === "list_databases") return ["app"];
      if (command === "list_tables") {
        return [{ name: renamed ? "customers" : "users", kind: "table" }];
      }
      if (command === "table_op") {
        calls.push(payload as Record<string, unknown>);
        renamed = true;
        return undefined;
      }
      return undefined;
    });

    render(<ConnectionTree />);
    await waitFor(() =>
      expect(useConnections.getState().branches.local?.loading).toBe(false)
    );
    fireEvent.click(screen.getByText("local-9.0"));
    fireEvent.click(await screen.findByText("app"));
    fireEvent.contextMenu(await screen.findByText("users"));
    fireEvent.click(screen.getByRole("button", { name: "重命名表" }));

    const dialog = screen.getByRole("dialog", { name: "重命名表" });
    const input = dialog.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "customers" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      id: "local",
      op: "rename",
      name: "users",
      schema: "app",
      newName: "customers",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "重命名表" })
      ).not.toBeInTheDocument()
    );
    expect(await screen.findByText("customers")).toBeInTheDocument();
    expect(useToasts.getState().items.at(-1)?.title).toBe("已重命名为 customers");
  });

  it("opens table data even when the pointer moves while clicking the portal menu", async () => {
    mockIPC((command) => {
      if (command === "list_connections") return [connections[0]];
      if (command === "list_databases") return ["app"];
      if (command === "list_tables") {
        return [{ name: "users", kind: "table" }];
      }
      return undefined;
    });

    render(<ConnectionTree />);
    await waitFor(() =>
      expect(useConnections.getState().branches.local?.loading).toBe(false)
    );
    fireEvent.click(screen.getByText("local-9.0"));
    fireEvent.click(await screen.findByText("app"));
    fireEvent.contextMenu(await screen.findByText("users"));
    const item = screen.getByRole("button", { name: /打开数据/ });

    fireEvent.mouseDown(item, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 120, clientY: 120 });
    fireEvent.mouseUp(window, { clientX: 120, clientY: 120 });
    fireEvent.click(item);

    await waitFor(() =>
      expect(useWorkspace.getState().activeTabId).toBe("data:local:app:users")
    );
    expect(useWorkspace.getState().tabs.at(-1)).toMatchObject({
      kind: "table-data",
      connectionId: "local",
      schema: "app",
      table: "users",
    });
  });
});
